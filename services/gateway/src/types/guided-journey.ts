/**
 * VTID-03276 — Guided Journey shared types (P1).
 *
 * The durable per-user UX state for the additive Guided Journey onboarding layer.
 * This is PRODUCT/UX state only — it is intentionally decoupled from subscription
 * (commercial entitlement) and feature_permission (access control). Never fold
 * those concerns into this shape.
 */

export type JourneyMode = 'guided' | 'full';

export type JourneyOnboardingStatus =
  | 'not_started'
  | 'in_progress'
  | 'qualified'
  | 'skipped'
  | 'completed';

/** Camel-cased view of a `user_guided_journey_state` row, as served to clients. */
export interface JourneyState {
  mode: JourneyMode;
  onboardingStatus: JourneyOnboardingStatus;
  /** Usage session the user is on (NOT a calendar day). Always >= 1. */
  currentSession: number;
  completedTopicIds: string[];
  completedPracticeCount: number;
  qualificationThreshold: number;
  qualifiedAt: string | null;
  skippedOnboardingAt: string | null;
  enteredFullModeAt: string | null;
  returnedToGuidedAt: string | null;
  lastOpenedTopicId: string | null;
  updatedAt: string;
  /**
   * VTID-04763 — Audiobook episodes heard on the member's own calendar day
   * (`date` is their local YYYY-MM-DD, sent by the client). Drives the
   * "one episode a day" goal identically on every device. Null until the
   * first listen that carries a local date.
   */
  dailyListen: AudiobookDailyListen | null;
  /** VTID-04763 — the member's daily "your episode for today" push, or null when off. */
  audiobookReminder: AudiobookReminderPref | null;
}

export interface AudiobookDailyListen {
  date: string;
  sessions: number[];
}

export interface AudiobookReminderPref {
  /** Local wall-clock time, HH:MM (24h). */
  time: string;
  /** IANA time zone the time is interpreted in. */
  tz: string;
}

/** The raw DB row shape (snake_case) for `user_guided_journey_state`. */
export interface GuidedJourneyStateRow {
  user_id: string;
  mode: JourneyMode;
  onboarding_status: JourneyOnboardingStatus;
  current_session: number;
  completed_topic_ids: string[] | null;
  completed_practice_count: number;
  qualification_threshold: number;
  qualified_at: string | null;
  skipped_onboarding_at: string | null;
  entered_full_mode_at: string | null;
  returned_to_guided_at: string | null;
  last_opened_topic_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}
