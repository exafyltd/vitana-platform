/**
 * VTID-03059 (B0d-real slice Xd) — Diary-missing-relevant NextActionSource.
 *
 * Reads from `user_diary_streak` (the canonical streak view —
 * same shape diary-streak-celebrator.ts uses). Detects two coachable
 * states:
 *
 *   STREAK_AT_RISK
 *     Current streak >= 2 days AND last_day is yesterday (local). The
 *     user has built momentum; one more entry today preserves it. This
 *     is the highest-priority diary nudge — momentum loss is psych-
 *     ologically costly.
 *
 *   STREAK_BROKEN_RESTART
 *     last_day is >= 3 days ago AND was previously >= 3 days in a row.
 *     The streak has lapsed but a restart is meaningful. Lower priority
 *     than at-risk (no immediate loss) but above CROSS_SOURCE_THRESHOLD.
 *
 * Anything else (no rows / first-day user / fresh entry already today)
 * → skipped:no_eligible_record.
 *
 * Priority bands:
 *   streak_at_risk          → 78
 *   streak_broken_restart   → 58 (above threshold 50; below most others)
 *
 * Sits below reminders/calendar/autopilot at the same urgency level so
 * those imminent items win. Above CROSS_SOURCE_THRESHOLD so when nothing
 * else qualifies, the diary nudge fires.
 *
 * Covers B0d-real acceptance #5 ("If diary is missing and relevant, it
 * can win"). The "relevant" qualifier is the (streak >= 2) gate — we
 * don't nag first-day users who haven't built any pattern yet.
 */

import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
} from '../types';

const KEY = 'diary_missing_relevant' as const;

export function makeDiaryMissingRelevantSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true,
    produce: produceDiaryMissingRelevant,
  };
}

export async function produceDiaryMissingRelevant(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
  let row: DiaryStreakLike | null = null;
  try {
    const { data, error } = await ctx.supabase
      .from('user_diary_streak')
      .select('current_streak_days, last_day, longest_streak_days')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) {
        return { source: KEY, candidate: null, skippedReason: 'feature_disabled' };
      }
      return { source: KEY, candidate: null, skippedReason: 'source_unavailable' };
    }
    row = (data as DiaryStreakLike | null) ?? null;
  } catch {
    return { source: KEY, candidate: null, skippedReason: 'errored' };
  }

  if (!row) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const state = classifyDiaryState(row, ctx.nowIso);
  if (state.kind === 'none') {
    return { source: KEY, candidate: null, skippedReason: state.reason };
  }

  const userFacingLine = renderLine(state, ctx.lang);
  const priority = state.kind === 'streak_at_risk' ? 78 : 58;
  const confidence: ScoredCandidate['confidence'] =
    state.kind === 'streak_at_risk' ? 'high' : 'medium';

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence,
    userFacingLine,
    reasons: [
      {
        kind: state.kind,
        detail:
          state.kind === 'streak_at_risk'
            ? `current_streak=${state.currentStreak} days`
            : `last entry ${state.daysSinceLast} days ago, longest=${state.longestStreak}`,
      },
    ],
    dedupeKey: `diary_missing_relevant:${state.kind}`,
    cta: { type: 'navigate', route: '/diary' },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

interface DiaryStreakLike {
  current_streak_days: number | null;
  last_day: string | null; // YYYY-MM-DD
  longest_streak_days: number | null;
}

export type DiaryState =
  | { kind: 'streak_at_risk'; currentStreak: number; daysSinceLast: number }
  | { kind: 'streak_broken_restart'; daysSinceLast: number; longestStreak: number }
  | { kind: 'none'; reason: 'no_eligible_record' | 'no_data' };

/**
 * Classify the current diary state. Pure; exported for tests.
 *
 * Date math uses UTC-day boundaries — the underlying view stores
 * `last_day` as YYYY-MM-DD (no timezone). Per the user's
 * "All user-facing time is CET" memory, a follow-up slice can swap to
 * Europe/Berlin date diffing; for now UTC keeps the math deterministic
 * across the parallel-deployed gateway instances. The mis-classification
 * window is at most ~2 hours per user per day — acceptable for a
 * coaching nudge.
 */
export function classifyDiaryState(
  row: DiaryStreakLike,
  nowIso: string,
): DiaryState {
  const currentStreak = Number(row.current_streak_days ?? 0);
  const longestStreak = Number(row.longest_streak_days ?? 0);
  const lastDay = (row.last_day ?? '').trim();

  if (!lastDay) {
    return { kind: 'none', reason: 'no_data' };
  }

  const lastTs = Date.parse(`${lastDay}T00:00:00Z`);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(lastTs) || !Number.isFinite(now)) {
    return { kind: 'none', reason: 'no_data' };
  }

  const today = Math.floor(now / 86_400_000);
  const lastDayN = Math.floor(lastTs / 86_400_000);
  const daysSinceLast = today - lastDayN;

  if (daysSinceLast <= 0) {
    // Entry already today (or future-dated row) → no nudge.
    return { kind: 'none', reason: 'no_eligible_record' };
  }

  if (daysSinceLast === 1 && currentStreak >= 2) {
    return { kind: 'streak_at_risk', currentStreak, daysSinceLast };
  }

  if (daysSinceLast >= 3 && longestStreak >= 3) {
    return { kind: 'streak_broken_restart', daysSinceLast, longestStreak };
  }

  // Day-2 gap with no streak, or short historical longest → don't nag.
  return { kind: 'none', reason: 'no_eligible_record' };
}

export function renderLine(
  state: Exclude<DiaryState, { kind: 'none' }>,
  lang: string,
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  if (state.kind === 'streak_at_risk') {
    if (isDe) {
      return (
        `Du hast ${state.currentStreak} Tage in Folge ins Tagebuch geschrieben. ` +
        `Soll ich dir helfen, heute den nächsten Eintrag zu machen, bevor die Serie reißt?`
      );
    }
    return (
      `You've journaled ${state.currentStreak} days in a row. ` +
      `Want help making today's entry so the streak stays alive?`
    );
  }
  // streak_broken_restart
  if (isDe) {
    return (
      `Dein letzter Tagebucheintrag liegt ${state.daysSinceLast} Tage zurück — ` +
      `deine längste Serie war ${state.longestStreak} Tage. Wollen wir heute neu anfangen?`
    );
  }
  return (
    `Your last diary entry was ${state.daysSinceLast} days ago — your longest streak was ` +
    `${state.longestStreak} days. Want to start a new one today?`
  );
}
