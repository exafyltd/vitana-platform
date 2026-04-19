/**
 * Proactive Guide — Awareness Context (VTID-01927, Phase A)
 *
 * Single source of truth for "who is this user right now" — wraps every signal
 * the proactive companion needs into one structured UserAwareness object.
 *
 * Brain reads this once per turn via getAwarenessContext(user_id, tenant_id).
 * No more scattered queries; no more "Vitana talks to everybody the same way."
 *
 * Reuses (does NOT reimplement):
 *   - gatherUserContext from community-user-analyzer (tenure + community signals)
 *   - DEFAULT_WAVE_CONFIG from wave-defaults (journey wave detection)
 *   - describeTimeSince + fetchLastSessionInfo from temporal-bucket
 *   - life_compass / autopilot_recommendations / calendar_events tables
 *
 * Cached per user for ~30s to avoid repeat queries within multi-turn sessions.
 */

import { getSupabase } from '../../lib/supabase';
import {
  gatherUserContext,
  type UserContext,
} from '../recommendation-engine/analyzers/community-user-analyzer';
import { DEFAULT_WAVE_CONFIG } from '../wave-defaults';
import { describeTimeSince, fetchLastSessionInfo, type LastInteraction } from './temporal-bucket';
import { getFeatureIntroductions } from './feature-introductions';
import { getRecentSessionSummaries } from './session-summaries';
import { getAdaptationStatus } from './adaptation-applier';
import type {
  UserAwareness,
  TenureStage,
  JourneyContext,
  AwarenessGoal,
  CommunityAwarenessSignals,
  RecentActivitySummary,
} from './types';

const LOG_PREFIX = '[Guide:awareness]';
const CACHE_TTL_MS = 30_000;
const JOURNEY_TOTAL_DAYS = 90;

interface CacheEntry {
  awareness: UserAwareness;
  expires_at: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Build the unified UserAwareness for a single user.
 *
 * All sub-queries run in parallel. Any failing branch returns sensible defaults
 * rather than throwing — awareness is best-effort, brain must always get a result.
 */
export async function getAwarenessContext(
  userId: string,
  tenantId: string,
): Promise<UserAwareness> {
  const cacheKey = `${tenantId}::${userId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) {
    return cached.awareness;
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.warn(`${LOG_PREFIX} no supabase — returning skeletal awareness`);
    return skeletalAwareness();
  }

  // Run every awareness query in parallel
  const [
    userContext,
    lastSessionInfo,
    goal,
    recentActivity,
    featureIntros,
    priorSummaries,
    adaptationStatus,
  ] = await Promise.all([
    safeGatherUserContext(userId, tenantId, supabase),
    fetchLastSessionInfo(userId).catch(() => null),
    fetchActiveGoal(userId, supabase),
    fetchRecentActivitySummary(userId, supabase),
    getFeatureIntroductions(userId).catch(() => []),
    getRecentSessionSummaries(userId, 3).catch(() => []),
    getAdaptationStatus(userId).catch(() => null),
  ]);

  const tenure = buildTenure(userContext);
  const journey = buildJourney(tenure.days_since_signup);
  const community_signals = buildCommunitySignals(userContext);
  const last_interaction: LastInteraction | null = lastSessionInfo
    ? describeTimeSince(lastSessionInfo)
    : describeTimeSince(null); // 'first' bucket; never null so brain has a clean signal

  const awareness: UserAwareness = {
    tenure,
    journey,
    goal,
    community_signals,
    recent_activity: recentActivity,
    last_interaction,
    feature_introductions: (featureIntros || []).map((f) => f.feature_key),
    prior_session_themes: (priorSummaries || []).map((s) => ({
      session_id: s.session_id,
      summary: s.summary,
      themes: s.themes,
      ended_at: s.ended_at,
    })),
    adaptation_plans: adaptationStatus,
    routines: null,
    tastes_preferences: null,
  };

  cache.set(cacheKey, { awareness, expires_at: Date.now() + CACHE_TTL_MS });
  return awareness;
}

/**
 * Test helper — clears the per-user cache. Production callers don't need this.
 */
export function clearAwarenessCache(userId?: string, tenantId?: string): void {
  if (userId && tenantId) {
    cache.delete(`${tenantId}::${userId}`);
  } else {
    cache.clear();
  }
}

// =============================================================================
// Internal builders
// =============================================================================

async function safeGatherUserContext(
  userId: string,
  tenantId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<UserContext | null> {
  try {
    return await gatherUserContext(userId, tenantId, supabase as any);
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} gatherUserContext failed:`, err?.message);
    return null;
  }
}

function buildTenure(uc: UserContext | null): UserAwareness['tenure'] {
  if (!uc) {
    // Fallback when gatherUserContext failed — use day30plus as the safest default
    // (won't trigger an introduction we can't honor)
    return {
      stage: 'day30plus',
      days_since_signup: 0,
      registered_at: new Date().toISOString(),
    };
  }
  const days = Math.floor((Date.now() - uc.createdAt.getTime()) / 86400000);
  return {
    stage: uc.onboardingStage as TenureStage,
    days_since_signup: Math.max(0, days),
    registered_at: uc.createdAt.toISOString(),
  };
}

function buildJourney(daysSinceSignup: number): JourneyContext {
  const isPast = daysSinceSignup >= JOURNEY_TOTAL_DAYS;
  if (isPast) {
    return { current_wave: null, day_in_journey: daysSinceSignup, is_past_90_day: true };
  }
  const enabled = DEFAULT_WAVE_CONFIG.filter((w) => w.enabled);
  const matching = enabled.filter(
    (w) => daysSinceSignup >= w.timeline.start_day && daysSinceSignup <= w.timeline.end_day,
  );
  if (matching.length === 0) {
    return { current_wave: null, day_in_journey: daysSinceSignup, is_past_90_day: false };
  }
  matching.sort((a, b) => a.timeline.end_day - b.timeline.end_day);
  const w = matching[0];
  return {
    current_wave: { id: w.id, name: w.name, description: w.description },
    day_in_journey: daysSinceSignup,
    is_past_90_day: false,
  };
}

function buildCommunitySignals(uc: UserContext | null): CommunityAwarenessSignals {
  if (!uc) {
    return {
      diary_streak_days: 0,
      connection_count: 0,
      group_count: 0,
      pending_match_count: 0,
      memory_goals: [],
      memory_interests: [],
    };
  }
  return {
    diary_streak_days: uc.diaryStreak,
    connection_count: uc.connectionCount,
    group_count: uc.groupCount,
    pending_match_count: uc.pendingMatchCount,
    memory_goals: uc.memoryGoals,
    memory_interests: uc.memoryInterests,
  };
}

async function fetchActiveGoal(
  userId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<AwarenessGoal | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from('life_compass')
    .select('id, primary_goal, category, created_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!data || !data.length) return null;
  const row = data[0] as { id: string; primary_goal: string; category: string; created_at: string };
  // Heuristic for is_system_seeded: the canonical default (longevity category +
  // mission text) marks the auto-seeded goal. Becomes a real column in Phase 4
  // of the broader Proactive Guide plan.
  const isSeeded =
    row.category === 'longevity' &&
    /improve quality of life and extend lifespan/i.test(row.primary_goal);
  return {
    primary_goal: row.primary_goal,
    category: row.category,
    is_system_seeded: isSeeded,
  };
}

async function fetchRecentActivitySummary(
  userId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<RecentActivitySummary> {
  if (!supabase) return emptyRecentActivity();

  const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
  const nowIso = new Date().toISOString();
  const in24hIso = new Date(Date.now() + 86400000).toISOString();

  const [openRecsRes, activatedRecsRes, dismissedRecsRes, overdueRes, upcomingRes] = await Promise.all([
    supabase
      .from('autopilot_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'new'),
    supabase
      .from('autopilot_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'activated')
      .gte('updated_at', sevenDaysAgoIso),
    supabase
      .from('autopilot_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'rejected')
      .gte('updated_at', sevenDaysAgoIso),
    supabase
      .from('calendar_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('event_type', 'autopilot')
      .eq('status', 'scheduled')
      .lt('start_time', nowIso),
    supabase
      .from('calendar_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('event_type', 'autopilot')
      .eq('status', 'scheduled')
      .gt('start_time', nowIso)
      .lt('start_time', in24hIso),
  ]);

  return {
    open_autopilot_recs: openRecsRes.count ?? 0,
    activated_recs_last_7d: activatedRecsRes.count ?? 0,
    dismissed_recs_last_7d: dismissedRecsRes.count ?? 0,
    overdue_calendar_count: overdueRes.count ?? 0,
    upcoming_calendar_24h_count: upcomingRes.count ?? 0,
  };
}

function emptyRecentActivity(): RecentActivitySummary {
  return {
    open_autopilot_recs: 0,
    activated_recs_last_7d: 0,
    dismissed_recs_last_7d: 0,
    overdue_calendar_count: 0,
    upcoming_calendar_24h_count: 0,
  };
}

function skeletalAwareness(): UserAwareness {
  return {
    tenure: { stage: 'day30plus', days_since_signup: 0, registered_at: new Date().toISOString() },
    journey: { current_wave: null, day_in_journey: 0, is_past_90_day: true },
    goal: null,
    community_signals: {
      diary_streak_days: 0,
      connection_count: 0,
      group_count: 0,
      pending_match_count: 0,
      memory_goals: [],
      memory_interests: [],
    },
    recent_activity: emptyRecentActivity(),
    last_interaction: describeTimeSince(null),
    feature_introductions: [],
    prior_session_themes: [],
    adaptation_plans: null,
    routines: null,
    tastes_preferences: null,
  };
}
