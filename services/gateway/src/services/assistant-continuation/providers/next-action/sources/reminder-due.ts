/**
 * VTID-03057 (B0d-real slice Xb) — Reminder-due NextActionSource.
 *
 * Reads from the canonical `reminders` table (same one
 * reminders-service.ts owns). Picks the user's most-imminent pending
 * reminder when it fires within the next 2 hours; turns it into a
 * proactive opener.
 *
 * Source priority bands (mapped from minutes-until-fire):
 *   - < 10 min    → 95 (urgent)
 *   - 10-30 min   → 85
 *   - 30-60 min   → 75
 *   - 60-120 min  → 65
 *   - > 120 min   → skipped (no_eligible_record)
 *
 * Confidence is derived: high under 30min, medium otherwise.
 *
 * Acceptance #2 (calendar/reminder due soon can win): this source
 * produces priority ≥ 65 for any reminder due in the next 2 hours,
 * comfortably above CROSS_SOURCE_THRESHOLD=50. The composer's
 * cross-source ranker handles the comparison; this file just supplies
 * the candidate.
 */

import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
} from '../types';

const KEY = 'reminder_due' as const;
const HORIZON_MINUTES = 120;

export function makeReminderDueSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true, // Both orb_wake AND orb_turn_end.
    produce: produceReminderDue,
  };
}

export async function produceReminderDue(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
  // Read the user's nearest pending reminder. Active statuses match the
  // canonical reminders-service.findReminders() default: pending + dispatching.
  const horizonIso = new Date(
    Date.parse(ctx.nowIso) + HORIZON_MINUTES * 60 * 1000,
  ).toISOString();

  let row: ReminderLike | null = null;
  try {
    const { data, error } = await ctx.supabase
      .from('reminders')
      .select('id, action_text, spoken_message, next_fire_at, status')
      .eq('user_id', ctx.userId)
      .in('status', ['pending', 'dispatching'])
      .gte('next_fire_at', ctx.nowIso)
      .lte('next_fire_at', horizonIso)
      .order('next_fire_at', { ascending: true })
      .limit(1);
    if (error) {
      return { source: KEY, candidate: null, skippedReason: 'source_unavailable' };
    }
    row = (data && data[0]) ? (data[0] as ReminderLike) : null;
  } catch {
    return { source: KEY, candidate: null, skippedReason: 'errored' };
  }

  if (!row) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const minutesUntilFire = computeMinutesUntil(row.next_fire_at, ctx.nowIso);
  if (minutesUntilFire < 0 || minutesUntilFire > HORIZON_MINUTES) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const priority = priorityForMinutes(minutesUntilFire);
  const confidence = minutesUntilFire <= 30 ? 'high' : 'medium';

  const actionText = (row.action_text || '').trim() || 'reminder';
  const userFacingLine = renderLine(actionText, minutesUntilFire, ctx.lang);

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence,
    userFacingLine,
    reasons: [
      {
        kind: 'reminder_due_within_horizon',
        detail: `${minutesUntilFire} min until "${actionText}"`,
      },
    ],
    dedupeKey: `reminder_due:${row.id}`,
    cta: { type: 'ask_permission', payload: { reminder_id: row.id } },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

interface ReminderLike {
  id: string;
  action_text: string | null;
  spoken_message: string | null;
  next_fire_at: string;
  status: string;
}

export function priorityForMinutes(minutes: number): number {
  if (minutes < 10) return 95;
  if (minutes < 30) return 85;
  if (minutes < 60) return 75;
  if (minutes <= HORIZON_MINUTES) return 65;
  return 0;
}

export function computeMinutesUntil(fireAtIso: string, nowIso: string): number {
  const fireAt = Date.parse(fireAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(fireAt) || !Number.isFinite(now)) return Number.NaN;
  return Math.round((fireAt - now) / 60_000);
}

export function renderLine(actionText: string, minutes: number, lang: string): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  if (minutes < 10) {
    return isDe
      ? `Du hast in ${minutes} Minuten einen Termin: ${actionText}. Soll ich dich gleich erinnern, oder willst du jetzt darüber sprechen?`
      : `You have something coming up in ${minutes} minutes: ${actionText}. Want me to nudge you, or talk about it now?`;
  }
  if (minutes < 60) {
    return isDe
      ? `In ${minutes} Minuten steht ${actionText} an. Sollen wir das vorbereiten?`
      : `${actionText} is coming up in ${minutes} minutes. Want help getting ready?`;
  }
  const hours = Math.round(minutes / 60);
  return isDe
    ? `In etwa ${hours} Stunde${hours === 1 ? '' : 'n'} steht ${actionText} an. Soll ich dir vorher Bescheid geben?`
    : `${actionText} is in about ${hours} hour${hours === 1 ? '' : 's'}. Want me to remind you closer to it?`;
}
