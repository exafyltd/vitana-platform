/**
 * VTID-04892 — Vitana Onboarding Assistant: stages, the activation ladder and
 * the per-member decision. Pure functions only (no I/O), so the whole rule
 * set is exercised by the simulation in test:onboarding.
 *
 * Plan: docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md (v3) §4.3, §4.4, §4.7.
 */

export type CoachStage = 'd0' | 'd1' | 'd2_3' | 'd4_7' | 'd8_30' | 'd31_60' | 'd61_90' | 'done';

export const COACH_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

/** Tenure (whole days since joining) → stage. 90 days and beyond is `done`. */
export function stageForTenure(tenureDays: number): CoachStage {
  if (tenureDays < 1) return 'd0';
  if (tenureDays < 2) return 'd1';
  if (tenureDays < 4) return 'd2_3';
  if (tenureDays < 8) return 'd4_7';
  if (tenureDays < 31) return 'd8_30';
  if (tenureDays < 61) return 'd31_60';
  if (tenureDays < COACH_WINDOW_DAYS) return 'd61_90';
  return 'done';
}

export function tenureDays(joinedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - joinedAt.getTime()) / DAY_MS);
}

const STAGE_ORDER: CoachStage[] = ['d0', 'd1', 'd2_3', 'd4_7', 'd8_30', 'd31_60', 'd61_90', 'done'];
const atLeast = (stage: CoachStage, min: CoachStage) => STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(min);

/**
 * The ladder (plan §4.4), in order. Each rung is the next best step while its
 * milestone is not reached and the member is far enough in. Milestone ids are
 * the existing `milestone-service.ts` ids (VOA adds no milestones in slice 1).
 * `listen_first_episode` points at the Audiobook (it never repeats its own
 * Episode-1 invitation — plan §9.1 C2/C4).
 */
export interface Rung {
  key: string;
  from: CoachStage;
  /** Reached when this milestone is achieved (or, for listening, a first episode was heard). */
  doneWhen: { milestone: string } | { listened: true };
}

export const LADDER: Rung[] = [
  { key: 'listen_first_episode', from: 'd0', doneWhen: { listened: true } },
  { key: 'complete_profile', from: 'd0', doneWhen: { milestone: 'profile_complete' } },
  { key: 'first_diary', from: 'd1', doneWhen: { milestone: 'first_diary' } },
  { key: 'join_first_group', from: 'd2_3', doneWhen: { milestone: 'first_group' } },
  { key: 'first_connection', from: 'd4_7', doneWhen: { milestone: 'first_connection' } },
  { key: 'first_event_rsvp', from: 'd4_7', doneWhen: { milestone: 'first_event_rsvp' } },
  { key: 'diary_streak_7', from: 'd8_30', doneWhen: { milestone: 'diary_streak_7' } },
  { key: 'invite_a_friend', from: 'd31_60', doneWhen: { milestone: 'first_referral' } },
];

export function nextAction(stage: CoachStage, achieved: ReadonlySet<string>, hasListened: boolean): string | null {
  if (stage === 'done') return null;
  for (const rung of LADDER) {
    if (!atLeast(stage, rung.from)) continue;
    const done = 'listened' in rung.doneWhen ? hasListened : achieved.has(rung.doneWhen.milestone);
    if (!done) return rung.key;
  }
  return null;
}

export type SkipReason =
  | 'opted_out'
  | 'graduated'
  | 'snoozed'
  | 'paused_after_ignores'
  | 'backing_off'
  | 'audiobook_owns_day'
  | 'already_touched_today'
  | 'nothing_to_do';

export interface MemberInput {
  joinedAt: Date;
  /** Member's local date (YYYY-MM-DD) — the coach's "day" everywhere (plan §4.7). */
  localDay: string;
  stageOverride?: CoachStage | null;
  optedOutAt?: Date | null;
  snoozedUntil?: Date | null;
  ignoredStreak?: number;
  lastTouchAt?: Date | null;
  achieved: ReadonlySet<string>;
  /** Audiobook state from user_guided_journey_state.metadata. */
  audiobook: {
    reminderSet: boolean;
    reminderLastSentLocalDate?: string | null;
    listenedToday: boolean;
    everListened: boolean;
  };
  /** An onboarding touch already claimed for localDay (any status). */
  touchedToday: boolean;
}

export interface Decision {
  stage: CoachStage;
  actionKey: string | null;
  decision: 'would_touch' | 'skip';
  reason: 'touch' | SkipReason;
}

export const MAX_IGNORED_STREAK = 3;

/**
 * One member, one local day. Order matters and is the plan's: opt-out and the
 * 90-day window first, then snooze/back-off, then the day's budget (the
 * Audiobook reminder owns the day when it is set and today's episode is not
 * finished, or when it was already sent today — plan §4.7, sparring N5/M2),
 * then the ladder.
 */
export function decide(m: MemberInput, now: Date): Decision {
  const stage = m.stageOverride ?? stageForTenure(tenureDays(m.joinedAt, now));
  const skip = (reason: SkipReason, actionKey: string | null = null): Decision =>
    ({ stage, actionKey, decision: 'skip', reason });

  if (m.optedOutAt) return skip('opted_out');
  if (stage === 'done') return skip('graduated');
  if (m.snoozedUntil && m.snoozedUntil.getTime() > now.getTime()) return skip('snoozed');

  const streak = m.ignoredStreak ?? 0;
  if (streak >= MAX_IGNORED_STREAK) return skip('paused_after_ignores');
  if (streak > 0 && m.lastTouchAt) {
    const gapDays = 2 ** streak; // ×2 gap after each ignored touch (plan §4.4)
    if (now.getTime() - m.lastTouchAt.getTime() < gapDays * DAY_MS) return skip('backing_off');
  }

  const actionKey = nextAction(stage, m.achieved, m.audiobook.everListened);

  const reminderOwnsDay =
    m.audiobook.reminderSet &&
    (!m.audiobook.listenedToday || m.audiobook.reminderLastSentLocalDate === m.localDay);
  if (reminderOwnsDay) return skip('audiobook_owns_day', actionKey);

  if (m.touchedToday) return skip('already_touched_today', actionKey);
  if (!actionKey) return skip('nothing_to_do');
  return { stage, actionKey, decision: 'would_touch', reason: 'touch' };
}

/** Members in the cohort (plan §4.2): joined on/after rollout − 30 days and still inside 90 days. */
export function inCohort(joinedAt: Date, rolloutDate: Date, now: Date): boolean {
  const earliest = rolloutDate.getTime() - 30 * DAY_MS;
  return joinedAt.getTime() >= earliest && tenureDays(joinedAt, now) < COACH_WINDOW_DAYS;
}

/** Member's local date (YYYY-MM-DD) in an IANA zone; falls back to Europe/Berlin. */
export function localDate(now: Date, tz: string | null | undefined): string {
  const zone = tz && isValidTimeZone(tz) ? tz : 'Europe/Berlin';
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
