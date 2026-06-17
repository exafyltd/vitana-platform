/**
 * Journey Conversation V2 — awareness extension builder (Phase 1).
 *
 * Populates `UserAwareness.journey_v2` from the canonical read paths
 * (spec §3, clarification C):
 *
 *   1. user_guided_journey_state — curriculum progress + guided/full mode
 *   2. journey_checklist_topics  — next recommended topic (session, position)
 *   3. user_journey              — recent_greeting_openings anti-repetition
 *   4. app_users                 — profile completion fields
 *   5. autopilot_recommendations — lifetime activations
 *   6. user_proactive_pause      — active pause summary
 *   7. memory_diary_entries      — diary entry today
 *   8. Vitana Index snapshot     — index maturity input
 *
 * Every branch is fail-open: a failing query yields a safe default, never
 * an exception on the brain's critical path. When even the base inputs are
 * unavailable the caller leaves `journey_v2` undefined.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  deriveExtendedTenureStage,
  deriveJourneyExperienceLevel,
  deriveVitanaIndexMaturity,
} from './journey-experience';
import type {
  JourneyV2Awareness,
  JourneyV2ProgressAwareness,
  ProfileCompletionStatus,
  PriorityTasksStatus,
  ProactivePauseStateSummary,
} from './types';

const LOG_PREFIX = '[Guide:awareness-v2]';

/** Base signals already computed by awareness-context — never re-queried here. */
export interface JourneyV2BaseSignals {
  days_since_signup: number;
  active_usage_days: number;
  diary_streak_days: number;
  connection_count: number;
  group_count: number;
  /** Active Life Compass goal, with the system-seeded marker. */
  goal: { is_system_seeded: boolean } | null;
}

interface GuidedStateRow {
  mode: 'guided' | 'full';
  onboarding_status: string;
  current_session: number;
  completed_topic_ids: string[] | null;
  last_opened_topic_id: string | null;
}

interface ChecklistTopicRow {
  topic_id: string;
  session: number;
  position: number;
}

interface ProfileRow {
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  city: string | null;
  country: string | null;
  avatar_url: string | null;
}

export async function buildJourneyV2Awareness(
  userId: string,
  supabase: SupabaseClient,
  base: JourneyV2BaseSignals,
): Promise<JourneyV2Awareness> {
  const todayUtc = new Date().toISOString().slice(0, 10);

  const [
    guidedState,
    greetingOpenings,
    profile,
    autopilotActivations,
    pauseState,
    diaryToday,
    hasIndexSnapshot,
  ] = await Promise.all([
    fetchGuidedState(userId, supabase),
    fetchGreetingOpenings(userId, supabase),
    fetchProfile(userId, supabase),
    fetchAutopilotActivations(userId, supabase),
    fetchPauseState(userId, supabase),
    fetchDiaryToday(userId, supabase, todayUtc),
    fetchHasIndexSnapshot(userId, supabase),
  ]);

  // Needs guidedState (current session + completed ids) — runs after the batch.
  const journey_progress = await buildJourneyProgress(supabase, guidedState);
  const profile_completion_status = buildProfileCompletion(profile);

  const completed_priority_tasks: PriorityTasksStatus = {
    life_compass_defined: !!base.goal && base.goal.is_system_seeded === false,
    profile_completed: profile_completion_status.completion_percent >= 100,
    diary_started: base.diary_streak_days > 0 || diaryToday,
    autopilot_used: autopilotActivations > 0,
  };

  const vitana_index_maturity = deriveVitanaIndexMaturity({
    has_index_snapshot: hasIndexSnapshot,
    active_usage_days: base.active_usage_days,
    diary_streak_days: base.diary_streak_days,
  });

  const priorityTaskCount = Object.values(completed_priority_tasks).filter(Boolean).length;

  const experience_level = deriveJourneyExperienceLevel({
    days_since_signup: base.days_since_signup,
    active_usage_days: base.active_usage_days,
    completed_journey_topics: journey_progress?.completed_topic_count ?? 0,
    completed_journey_sessions: Math.max(0, (journey_progress?.current_session ?? 1) - 1),
    diary_streak_days: base.diary_streak_days,
    autopilot_activations: autopilotActivations,
    connection_count: base.connection_count,
    group_count: base.group_count,
    completed_priority_tasks: priorityTaskCount,
    vitana_index_maturity,
  });

  return {
    extended_tenure_stage: deriveExtendedTenureStage(base.days_since_signup),
    experience_level,
    vitana_index_maturity,
    journey_progress,
    profile_completion_status,
    completed_priority_tasks,
    diary_entry_today: diaryToday,
    proactive_pause_state: pauseState,
    recent_greeting_openings: greetingOpenings,
    autopilot_activations_lifetime: autopilotActivations,
  };
}

// =============================================================================
// Fetchers — all fail-open
// =============================================================================

async function fetchGuidedState(
  userId: string,
  supabase: SupabaseClient,
): Promise<GuidedStateRow | null> {
  try {
    const { data, error } = await supabase
      .from('user_guided_journey_state')
      .select('mode, onboarding_status, current_session, completed_topic_ids, last_opened_topic_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return data as unknown as GuidedStateRow;
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} guided state read failed:`, err?.message);
    return null;
  }
}

async function buildJourneyProgress(
  supabase: SupabaseClient,
  guidedState: GuidedStateRow | null,
): Promise<JourneyV2ProgressAwareness | null> {
  if (!guidedState) return null;
  const completed = new Set(guidedState.completed_topic_ids ?? []);

  let nextTopicId: string | null = null;
  let nextTopicSession: number | null = null;
  try {
    // Next recommended topic = first published+enabled topic not yet
    // completed, in (session, position) order. We page from the user's
    // current session forward so the query stays small even with a
    // 250-topic curriculum.
    const { data, error } = await supabase
      .from('journey_checklist_topics')
      .select('topic_id, session, position')
      .eq('status', 'published')
      .eq('enabled', true)
      .gte('session', Math.max(1, guidedState.current_session))
      .order('session', { ascending: true })
      .order('position', { ascending: true })
      .limit(50);
    if (!error && data) {
      const next = (data as unknown as ChecklistTopicRow[]).find(
        (t) => !completed.has(t.topic_id),
      );
      if (next) {
        nextTopicId = next.topic_id;
        nextTopicSession = next.session;
      }
    }
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} next-topic read failed:`, err?.message);
  }

  return {
    mode: guidedState.mode === 'full' ? 'full' : 'guided',
    onboarding_status: guidedState.onboarding_status,
    current_session: guidedState.current_session,
    completed_topic_count: completed.size,
    last_opened_topic_id: guidedState.last_opened_topic_id,
    next_recommended_topic_id: nextTopicId,
    next_recommended_session: nextTopicSession,
  };
}

async function fetchGreetingOpenings(
  userId: string,
  supabase: SupabaseClient,
): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('user_journey')
      .select('recent_greeting_openings')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return [];
    return (data.recent_greeting_openings as string[] | null) ?? [];
  } catch {
    return [];
  }
}

async function fetchProfile(
  userId: string,
  supabase: SupabaseClient,
): Promise<ProfileRow | null> {
  try {
    const { data, error } = await supabase
      .from('app_users')
      .select('first_name, last_name, date_of_birth, gender, city, country, avatar_url')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return data as unknown as ProfileRow;
  } catch {
    return null;
  }
}

function buildProfileCompletion(profile: ProfileRow | null): ProfileCompletionStatus {
  const has = (v: string | null | undefined) => !!v && v.trim().length > 0;
  const fields = {
    first_name: has(profile?.first_name),
    last_name: has(profile?.last_name),
    birthday: has(profile?.date_of_birth),
    profile_picture: has(profile?.avatar_url),
    gender: has(profile?.gender),
    location: has(profile?.city) || has(profile?.country),
  };
  const done = Object.values(fields).filter(Boolean).length;
  return {
    ...fields,
    completion_percent: Math.round((done / 6) * 100),
  };
}

async function fetchAutopilotActivations(
  userId: string,
  supabase: SupabaseClient,
): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('autopilot_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'activated');
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function fetchPauseState(
  userId: string,
  supabase: SupabaseClient,
): Promise<ProactivePauseStateSummary> {
  const empty: ProactivePauseStateSummary = {
    paused_all: false,
    paused_categories: [],
    paused_nudge_keys: [],
  };
  try {
    const { data, error } = await supabase
      .from('user_proactive_pause')
      .select('scope, scope_value, paused_until')
      .eq('user_id', userId)
      .gt('paused_until', new Date().toISOString());
    if (error || !data) return empty;
    const rows = data as Array<{ scope: string; scope_value: string | null }>;
    return {
      paused_all: rows.some((r) => r.scope === 'all'),
      paused_categories: rows
        .filter((r) => r.scope === 'category' && r.scope_value)
        .map((r) => r.scope_value as string),
      paused_nudge_keys: rows
        .filter((r) => r.scope === 'nudge_key' && r.scope_value)
        .map((r) => r.scope_value as string),
    };
  } catch {
    return empty;
  }
}

async function fetchDiaryToday(
  userId: string,
  supabase: SupabaseClient,
  todayUtc: string,
): Promise<boolean> {
  try {
    const { count, error } = await supabase
      .from('memory_diary_entries')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', `${todayUtc}T00:00:00.000Z`);
    if (error) return false;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

async function fetchHasIndexSnapshot(
  userId: string,
  supabase: SupabaseClient,
): Promise<boolean> {
  try {
    // Lazy import — user-context-profiler pulls a wide dependency graph;
    // keep guide module init light (mirrors initiative-registry pattern).
    const { fetchVitanaIndexForProfiler } = await import('../user-context-profiler');
    const snapshot = await fetchVitanaIndexForProfiler(supabase as any, userId);
    return !!snapshot;
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} index snapshot read failed:`, err?.message);
    return false;
  }
}
