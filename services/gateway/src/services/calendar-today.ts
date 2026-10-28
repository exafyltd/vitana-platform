/**
 * VTID-04321 — "today" for a calendar event is the USER's today.
 *
 * POST /scheduled-notifications/upcoming-events used setHours(0..23:59) on the
 * gateway's clock (UTC on ECS), so for a Berlin user it covered 02:00-01:59
 * local and a 00:30 event landed on the wrong day, and the pushed time
 * ("today at 10:00") was printed in UTC — two hours off in summer.
 *
 * The route now fetches a window wide enough to contain every timezone's
 * "today" (now-14h .. now+38h) and this module keeps, per user, the first
 * event whose start falls on the user's local date, formatted in their zone.
 */

import { formatLocalDate, formatLocalHHMM } from './guide/user-timezone';

/** A window guaranteed to contain "today" in every IANA zone (UTC-12 .. UTC+14). */
export function wideTodayWindow(now: Date = new Date()): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - 14 * 3600_000).toISOString(),
    to: new Date(now.getTime() + 38 * 3600_000).toISOString(),
  };
}

export interface TodayEventRow {
  id: string;
  user_id: string;
  title?: string | null;
  start_time: string;
}

export interface TodayEventPick<T extends TodayEventRow> {
  event: T;
  localTime: string;
  timezone: string;
}

/**
 * Keep, per user, the earliest event that starts on the user's local "today".
 * `events` may come in any order; `tzOf` returns the user's IANA timezone.
 */
export function pickFirstEventTodayPerUser<T extends TodayEventRow>(
  events: T[],
  tzOf: (userId: string) => string,
  now: Date = new Date(),
): Array<TodayEventPick<T>> {
  const sorted = [...events].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  const picked = new Map<string, TodayEventPick<T>>();
  for (const ev of sorted) {
    if (picked.has(ev.user_id)) continue;
    const tz = tzOf(ev.user_id);
    if (formatLocalDate(ev.start_time, tz) !== formatLocalDate(now.toISOString(), tz)) continue;
    picked.set(ev.user_id, { event: ev, localTime: formatLocalHHMM(ev.start_time, tz), timezone: tz });
  }
  return [...picked.values()];
}
