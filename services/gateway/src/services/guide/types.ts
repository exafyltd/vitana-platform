/**
 * Proactive Guide — Shared Types
 *
 * Types for the Phase 0.5 thin proactive opener, dismissal honor system,
 * and Phase A awareness context (VTID-01927).
 *
 * Plans:
 * - .claude/plans/lucent-stitching-sextant.md (broader Proactive Guide)
 * - .claude/plans/majestic-sleeping-kahan.md (Companion Awareness — this work)
 */

import type { LastInteraction } from './temporal-bucket';

// =============================================================================
// Awareness Context (Phase A — single source of truth for "who is on the line")
// =============================================================================

export type TenureStage = 'day0' | 'day1' | 'day3' | 'day7' | 'day14' | 'day30plus';

export interface JourneyContext {
  current_wave: { id: string; name: string; description: string } | null;
  day_in_journey: number;
  is_past_90_day: boolean;
}

export interface AwarenessGoal {
  primary_goal: string;
  category: string;
  is_system_seeded: boolean;
}

export interface CommunityAwarenessSignals {
  diary_streak_days: number;
  connection_count: number;
  group_count: number;
  pending_match_count: number;
  memory_goals: string[];
  memory_interests: string[];
}

export interface RecentActivitySummary {
  open_autopilot_recs: number;
  activated_recs_last_7d: number;
  dismissed_recs_last_7d: number;
  overdue_calendar_count: number;
  upcoming_calendar_24h_count: number;
}

/**
 * The unified "who is this user, right now" picture the brain reads once
 * per turn. Every signal that should influence how Vitana speaks lives here.
 *
 * Future companion pillars add their own fields (routines, tastes, adaptation,
 * prior_session_themes) — they're typed as null today and populated by
 * subsequent phases.
 */
export interface UserAwareness {
  tenure: {
    stage: TenureStage;
    days_since_signup: number;
    /**
     * BOOTSTRAP-DYK-TOUR: distinct UTC dates on which the user had an
     * authenticated session. Drives the Did-You-Know tour curriculum
     * (30 days of USAGE, not calendar days). Populated from
     * user_active_days table. Zero on any read error.
     */
    active_usage_days: number;
    registered_at: string;
  };
  journey: JourneyContext;
  goal: AwarenessGoal | null;
  community_signals: CommunityAwarenessSignals;
  recent_activity: RecentActivitySummary;
  last_interaction: LastInteraction | null;

  // Phase G — feature-introduction tracking (VTID-01932)
  feature_introductions: string[];

  // Phase F — conversation continuity / prior session summaries (VTID-01933)
  prior_session_themes: Array<{
    session_id: string;
    summary: string;
    themes: string[];
    ended_at: string;
  }>;

  // VTID-01990 — conversation tracking with timestamps. Cross-surface
  // (voice + text + community + developer) — "this is the Nth session today,
  // last at HH:MM" awareness so Vitana feels persistent across sessions.
  sessions_today: {
    count: number;
    entries: Array<{
      session_id: string;
      channel: 'voice' | 'text';
      summary: string;
      themes: string[];
      ended_at: string;
    }>;
  };
  last_session_yesterday: {
    session_id: string;
    channel: 'voice' | 'text';
    summary: string;
    themes: string[];
    ended_at: string;
  } | null;

  // Phase E — D43 adaptation status (VTID-01935)
  // Null when adaptation_plans table doesn't exist yet (D43 doesn't write
  // there yet). When populated, shows pending vs applied plans.
  adaptation_plans: {
    pending_plans: number;
    applied_plans: number;
    last_applied_at: string | null;
  } | null;

  // Phase C — user routines from pattern-extractor (VTID-01936)
  routines: Array<{
    routine_kind: string;
    title: string;
    summary: string;
    confidence: number;
  }>;

  // Reserved for future (null until then)
  tastes_preferences: null;
}

// =============================================================================
// Existing types (Phase 0.5)
// =============================================================================

export type ProactivePauseScope = 'all' | 'category' | 'nudge_key' | 'channel';

export interface ProactivePause {
  id: string;
  user_id: string;
  scope: ProactivePauseScope;
  scope_value: string | null;
  paused_from: string;
  paused_until: string;
  reason: string | null;
  created_via: 'voice' | 'text' | 'settings';
  created_at: string;
}

export type OpenerCandidateKind =
  | 'overdue_calendar'
  | 'upcoming_calendar'
  | 'autopilot_recommendation'
  | 'wave_transition'
  | 'goal_reminder';

export interface OpenerCandidate {
  /** Stable identifier used in user_nudge_state to prevent re-surfacing within silence window. */
  nudge_key: string;
  kind: OpenerCandidateKind;
  /** What the LLM should reference. Short, concrete, in the user's language ideally. */
  title: string;
  /** Optional subline — duration, time, what it's for. */
  subline?: string;
  /** The Life Compass goal this candidate aligns with. Frames every opener. */
  goal_link?: {
    primary_goal: string;
    category: string;
    /**
     * True when this Life Compass goal was system-seeded (the default longevity
     * goal applied to a new user who hasn't picked one). The brain prompt uses
     * this to make the agency offer ("I set this for you, change anytime")
     * explicit instead of implicit.
     */
    is_system_seeded?: boolean;
  };
  /** Shipping rationale for the LLM — why this was picked. Not shown to user verbatim. */
  reason: string;
  /** Optional category for category-mute checks. */
  category?: string;
}

export interface OpenerSelection {
  /** Null when there's no candidate OR an active pause covers the user. */
  candidate: OpenerCandidate | null;
  /** True if a pause caused suppression — useful for telemetry. */
  suppressed_by_pause: boolean;
  /** Set when suppressed_by_pause is true. */
  suppressing_pause?: ProactivePause;
}
