/**
 * Journey Conversation V2 — single proactive arbiter (Phase 4).
 *
 * ONE decision point for the proactive focus of a session. On the V2 path
 * the opener layering (opener-mvp), the initiative engine and the tip
 * curriculum stop being independent decision-makers — their signals become
 * candidates in the priority order below. Exactly one proactive focus is
 * surfaced per turn.
 *
 * Priority order (spec §7; slots 1–2 — user safety and the user's explicit
 * request — are handled upstream by the brain/LLM and always outrank any
 * proactive content):
 *
 *   3. overdue Autopilot calendar event
 *   4. missing USER-DEFINED Life Compass (system-seeded default ≠ defined)
 *   5. Daily Diary — no entry today (voice-first via save_diary_entry)
 *   6. upcoming Autopilot event within 24h
 *   7. high-value open Autopilot recommendation (consent-gated activation)
 *   8. incomplete priority profile fields (early tenure only)
 *   9. next My Journey session/topic (teaching candidate)
 *  10. community connection / pending match
 *  11. occasional inspirational / responsibility message (pacer-capped)
 *
 * Pause semantics: a nudge_key- or category-scoped pause SKIPS to the next
 * candidate; an 'all'/'channel'-scoped pause suppresses every proactive
 * focus for the session. The once-per-day responsibility slot additionally
 * checks the presence pacer.
 */

import { getSupabase } from '../../lib/supabase';
import { isPaused } from './pause-check';
import { canSurfaceProactively, recordTouch } from './presence-pacer';
import {
  RESPONSIBILITY_SURFACE,
  RESPONSIBILITY_NUDGE_KEY,
} from './speech-intent';
import type { ProactivePause, UserAwareness } from './types';

const LOG_PREFIX = '[Guide:conversation-focus]';

export type ConversationFocusKind =
  | 'overdue_autopilot_event'
  | 'missing_life_compass'
  | 'daily_diary'
  | 'upcoming_autopilot_event'
  | 'autopilot_recommendation'
  | 'profile_completion'
  | 'journey_next_topic'
  | 'community_connection'
  | 'inspiration';

export interface ConversationFocus {
  kind: ConversationFocusKind;
  /** Stable key for pause_proactive_guidance(scope="nudge_key"). */
  nudge_key: string;
  title: string;
  detail?: string;
  /** Why this was selected — for the LLM, not spoken verbatim. */
  reason: string;
  category: string;
  /** Tool the LLM may call ON USER CONSENT (never without). */
  on_yes_tool?: 'save_diary_entry' | 'activate_recommendation' | null;
  on_yes_payload_hint?: string;
}

export interface FocusSelection {
  focus: ConversationFocus | null;
  suppressed_by_pause: boolean;
  suppressing_pause?: ProactivePause;
}

export interface PickConversationFocusInput {
  user_id: string;
  awareness: UserAwareness;
  channel: 'voice' | 'text';
}

interface CandidateDraft {
  kind: ConversationFocusKind;
  nudge_key: string;
  title: string;
  detail?: string;
  reason: string;
  category: string;
  on_yes_tool?: 'save_diary_entry' | 'activate_recommendation' | null;
  on_yes_payload_hint?: string;
}

export async function pickConversationFocus(
  input: PickConversationFocusInput,
): Promise<FocusSelection> {
  const { awareness } = input;
  const v2 = awareness.journey_v2;
  const dateKey = new Date().toISOString().slice(0, 10);

  // Build candidates lazily, in priority order. Each provider returns null
  // when not applicable; DB lookups only run for slots whose awareness
  // counters indicate something exists.
  const providers: Array<() => Promise<CandidateDraft | null> | CandidateDraft | null> = [
    // 3 — overdue autopilot calendar event
    async () => {
      if ((awareness.recent_activity?.overdue_calendar_count ?? 0) < 1) return null;
      const ev = await fetchCalendarEvent(input.user_id, 'overdue');
      if (!ev) return null;
      return {
        kind: 'overdue_autopilot_event',
        nudge_key: `overdue_event:${ev.id}`,
        title: ev.title,
        detail: ev.duration_minutes ? `${ev.duration_minutes} min — from earlier` : 'from earlier',
        reason: 'overdue autopilot calendar event — time-sensitive commitment comes first',
        category: 'calendar',
      };
    },
    // 4 — missing user-defined Life Compass
    () => {
      const goal = awareness.goal;
      if (goal && goal.is_system_seeded === false) return null;
      return {
        kind: 'missing_life_compass',
        nudge_key: `life_compass_define:${dateKey}`,
        title: goal
          ? 'Life Compass still on the system default — invite the user to define their own'
          : 'No Life Compass goal set — invite the user to define one',
        reason:
          'a personal Life Compass gives the whole journey direction; the system-seeded default does not count as user-defined',
        category: 'goal',
      };
    },
    // 5 — Daily Diary (no entry today)
    () => {
      if (!v2) return null;
      if (v2.diary_entry_today) return null;
      return {
        kind: 'daily_diary',
        nudge_key: `diary_today:${dateKey}`,
        title: 'No diary entry yet today — offer a voice-first diary moment',
        detail:
          'rotate the angle: sleep, water, meals, fruit/vegetables, movement, exercise, mood, energy, mental state, recovery',
        reason: 'daily lived data powers the Vitana Index and personalization',
        category: 'diary',
        on_yes_tool: 'save_diary_entry',
        on_yes_payload_hint:
          'use the user\'s dictated content as `content`, set `template_type="free"`',
      };
    },
    // 6 — upcoming autopilot event within 24h
    async () => {
      if ((awareness.recent_activity?.upcoming_calendar_24h_count ?? 0) < 1) return null;
      const ev = await fetchCalendarEvent(input.user_id, 'upcoming');
      if (!ev) return null;
      return {
        kind: 'upcoming_autopilot_event',
        nudge_key: `upcoming_event:${ev.id}`,
        title: ev.title,
        detail: `starts ${describeTimeUntil(ev.start_time)}`,
        reason: 'autopilot event scheduled within the next 24h',
        category: 'calendar',
      };
    },
    // 7 — high-value open autopilot recommendation
    async () => {
      if ((awareness.recent_activity?.open_autopilot_recs ?? 0) < 1) return null;
      const rec = await fetchTopRecommendation(input.user_id);
      if (!rec) return null;
      return {
        kind: 'autopilot_recommendation',
        nudge_key: `recommendation:${rec.id}`,
        title: rec.title,
        detail: rec.summary?.slice(0, 100),
        reason:
          'Autopilot turns guidance into action — surface the top open recommendation and offer to activate it on consent',
        category: 'autopilot',
        on_yes_tool: 'activate_recommendation',
        on_yes_payload_hint: `use recommendation id "${rec.id}" (the one you just named)`,
      };
    },
    // 8 — incomplete priority profile fields (early tenure only)
    () => {
      if (!v2) return null;
      if (v2.profile_completion_status.completion_percent >= 100) return null;
      // Mature/advanced users are not nagged about profile fields.
      const lvl = v2.experience_level;
      if (lvl === 'advanced' || lvl === 'mature') return null;
      const missing = Object.entries(v2.profile_completion_status)
        .filter(([k, val]) => k !== 'completion_percent' && val === false)
        .map(([k]) => k);
      return {
        kind: 'profile_completion',
        nudge_key: `profile_completion:${dateKey}`,
        title: `Profile ${v2.profile_completion_status.completion_percent}% complete — missing: ${missing.join(', ')}`,
        reason:
          'these details improve personalization, community matching, age context and location relevance. Profile data stays authoritative in profile settings — invite the user to complete it there; NEVER silently change identity fields by voice.',
        category: 'profile',
      };
    },
    // 9 — next My Journey session/topic
    () => {
      const jp = v2?.journey_progress;
      if (!jp || !jp.next_recommended_topic_id) return null;
      const modeNote =
        jp.mode === 'guided'
          ? 'user is in GUIDED JOURNEY mode — teach, coach, and guide the practice'
          : 'user is in FULL APP mode — reconnect gently to the journey, do not interrupt their task';
      return {
        kind: 'journey_next_topic',
        nudge_key: `journey_topic:${jp.next_recommended_topic_id}:${dateKey}`,
        title: `Next My Journey topic (session ${jp.next_recommended_session ?? jp.current_session})`,
        detail: `${jp.completed_topic_count} topics completed so far; next topic id ${jp.next_recommended_topic_id}`,
        reason: `My Journey is the teaching center; ${modeNote}`,
        category: 'journey',
      };
    },
    // 10 — community connection / pending match
    () => {
      const cs = awareness.community_signals;
      if ((cs?.pending_match_count ?? 0) > 0) {
        return {
          kind: 'community_connection',
          nudge_key: `community_matches:${dateKey}`,
          title: `${cs.pending_match_count} pending community match${cs.pending_match_count === 1 ? '' : 'es'}`,
          reason: 'community connection supports wellbeing and retention',
          category: 'community',
        };
      }
      if ((cs?.connection_count ?? 0) === 0 && (awareness.tenure?.days_since_signup ?? 0) >= 3) {
        return {
          kind: 'community_connection',
          nudge_key: `community_first_connection:${dateKey}`,
          title: 'No community connections yet — suggest exploring the community',
          reason: 'a first connection is a strong early-retention signal',
          category: 'community',
        };
      }
      return null;
    },
    // 11 — inspirational / responsibility message (pacer-capped, once/day)
    async () => {
      const decision = await canSurfaceProactively(input.user_id, RESPONSIBILITY_SURFACE).catch(
        () => null,
      );
      if (!decision || !decision.allow) return null;
      return {
        kind: 'inspiration',
        nudge_key: RESPONSIBILITY_NUDGE_KEY,
        title: 'General motivational check-in / brief responsibility reflection',
        reason:
          'no higher-priority focus exists — close with warmth: one varied motivational note, never a recited list',
        category: 'inspiration',
      };
    },
  ];

  for (const provider of providers) {
    let draft: CandidateDraft | null = null;
    try {
      draft = await provider();
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} candidate provider failed:`, err?.message);
      continue;
    }
    if (!draft) continue;

    const pause = await isPaused({
      user_id: input.user_id,
      channel: input.channel,
      category: draft.category,
      nudge_key: draft.nudge_key,
    });
    if (pause.paused) {
      const scope = pause.pause?.scope;
      if (scope === 'all' || scope === 'channel') {
        // Blanket pause — nothing proactive this session.
        return { focus: null, suppressed_by_pause: true, suppressing_pause: pause.pause };
      }
      // Scoped pause (nudge_key/category) — honor it and try the next slot.
      continue;
    }

    if (draft.kind === 'inspiration') {
      // Count the once-per-day responsibility slot against the pacer cap.
      recordTouch({
        user_id: input.user_id,
        surface: RESPONSIBILITY_SURFACE,
        reason_tag: RESPONSIBILITY_NUDGE_KEY,
      }).catch(() => {});
    }

    return { focus: { ...draft }, suppressed_by_pause: false };
  }

  return { focus: null, suppressed_by_pause: false };
}

// =============================================================================
// Targeted lookups (only run when awareness counters say data exists)
// =============================================================================

interface CalendarEventLite {
  id: string;
  title: string;
  start_time: string;
  duration_minutes: number | null;
}

async function fetchCalendarEvent(
  userId: string,
  which: 'overdue' | 'upcoming',
): Promise<CalendarEventLite | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const nowIso = new Date().toISOString();
  let query = supabase
    .from('calendar_events')
    .select('id, title, start_time, duration_minutes')
    .eq('user_id', userId)
    .eq('event_type', 'autopilot')
    .eq('status', 'scheduled');
  if (which === 'overdue') {
    query = query.lt('start_time', nowIso).order('start_time', { ascending: false });
  } else {
    const in24hIso = new Date(Date.now() + 86_400_000).toISOString();
    query = query
      .gt('start_time', nowIso)
      .lt('start_time', in24hIso)
      .order('start_time', { ascending: true });
  }
  const { data, error } = await query.limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0] as CalendarEventLite;
}

interface RecommendationLite {
  id: string;
  title: string;
  summary: string | null;
}

async function fetchTopRecommendation(userId: string): Promise<RecommendationLite | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('autopilot_recommendations')
    .select('id, title, summary, priority')
    .eq('user_id', userId)
    .eq('status', 'new')
    .order('priority', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0] as RecommendationLite;
}

function describeTimeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}
