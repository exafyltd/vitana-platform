/**
 * Proactive Guide — Shared Types
 *
 * Types for the Phase 0.5 thin proactive opener and dismissal honor system.
 * Plan: .claude/plans/lucent-stitching-sextant.md
 */

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
