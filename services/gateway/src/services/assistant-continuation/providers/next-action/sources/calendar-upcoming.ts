/**
 * VTID-03058 (B0d-real slice Xc) — Calendar-upcoming NextActionSource.
 *
 * Reads from the canonical `calendar_events` table (same one
 * awareness-context.ts + opener-mvp.ts + pillar-agents/base-agent.ts
 * query). Picks the user's next scheduled event when it starts within
 * the next 24 hours, with priority decaying as the event moves further
 * out.
 *
 * Priority bands (minutes-until-start):
 *   <  30 min  → 92 (about-to-start)
 *   30-120 min → 82
 *   2-6 hours  → 72
 *   6-24 hours → 62
 *   > 24 hours → skipped (no_eligible_record)
 *
 * Why slightly lower than reminders at the same horizon: calendar
 * events are typically less urgent than reminders (a reminder is a
 * deliberate "nudge me at X" intent; a calendar event might just be a
 * meeting on the books). The reminder source at the same minutes-out
 * wins the tie.
 *
 * Acceptance #2 (calendar OR reminder due soon can win) is now covered
 * on both sides; the composer picks the higher-priority winner.
 */

import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
} from '../types';

const KEY = 'calendar_upcoming' as const;
const HORIZON_MINUTES = 24 * 60;

export function makeCalendarUpcomingSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true,
    produce: produceCalendarUpcoming,
  };
}

export async function produceCalendarUpcoming(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
  const horizonIso = new Date(
    Date.parse(ctx.nowIso) + HORIZON_MINUTES * 60 * 1000,
  ).toISOString();

  let row: CalendarEventLike | null = null;
  try {
    const { data, error } = await ctx.supabase
      .from('calendar_events')
      .select('id, title, start_time, end_time, status, event_type')
      .eq('user_id', ctx.userId)
      .eq('status', 'scheduled')
      .gte('start_time', ctx.nowIso)
      .lte('start_time', horizonIso)
      .order('start_time', { ascending: true })
      .limit(1);
    if (error) {
      return { source: KEY, candidate: null, skippedReason: 'source_unavailable' };
    }
    row = (data && data[0]) ? (data[0] as CalendarEventLike) : null;
  } catch {
    return { source: KEY, candidate: null, skippedReason: 'errored' };
  }

  if (!row) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const minutesUntil = computeMinutesUntil(row.start_time, ctx.nowIso);
  if (minutesUntil < 0 || minutesUntil > HORIZON_MINUTES) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const priority = priorityForMinutes(minutesUntil);
  const confidence: ScoredCandidate['confidence'] =
    minutesUntil <= 30 ? 'high' : minutesUntil <= 120 ? 'medium' : 'low';

  const title = (row.title || '').trim() || 'an event';
  const userFacingLine = renderLine(title, minutesUntil, ctx.lang);

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence,
    userFacingLine,
    reasons: [
      {
        kind: 'calendar_event_upcoming',
        detail: `${minutesUntil} min until "${title}"`,
      },
    ],
    dedupeKey: `calendar_upcoming:${row.id}`,
    cta: { type: 'ask_permission', payload: { event_id: row.id } },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

interface CalendarEventLike {
  id: string;
  title: string | null;
  start_time: string;
  end_time: string | null;
  status: string;
  event_type: string | null;
}

export function priorityForMinutes(minutes: number): number {
  if (minutes < 30) return 92;
  if (minutes < 120) return 82;
  if (minutes < 360) return 72;
  if (minutes <= HORIZON_MINUTES) return 62;
  return 0;
}

export function computeMinutesUntil(startIso: string, nowIso: string): number {
  const start = Date.parse(startIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return Number.NaN;
  return Math.round((start - now) / 60_000);
}

export function renderLine(title: string, minutes: number, lang: string): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  if (minutes < 30) {
    return isDe
      ? `In ${minutes} Minuten startet "${title}". Sollen wir das kurz vorbereiten?`
      : `"${title}" starts in ${minutes} minutes. Want to prep quickly?`;
  }
  if (minutes < 120) {
    return isDe
      ? `In ${minutes} Minuten steht "${title}" an. Brauchst du davor noch etwas?`
      : `"${title}" is in ${minutes} minutes. Anything you need before then?`;
  }
  const hours = Math.round(minutes / 60);
  return isDe
    ? `Heute steht "${title}" in etwa ${hours} Stunde${hours === 1 ? '' : 'n'} an. Sollen wir das im Hinterkopf behalten?`
    : `"${title}" is in about ${hours} hour${hours === 1 ? '' : 's'}. Want me to keep that in mind?`;
}
