/**
 * VTID-03166 — New-day overview aggregator.
 *
 * Pulls the structured payload the new-day-return renderer uses to
 * compose a 3-5 sentence greeting that includes:
 *   1. What happened since the user's last session (overnight delta)
 *   2. What's on their plate today (next event, today's volume)
 *   3. Vitana Index direction (if material movement)
 *   4. The Life Compass goal as a through-line
 *
 * Every source is fetched in parallel; per-source failures degrade
 * gracefully (return null) so a single broken table never blocks the
 * greeting. The renderer is responsible for picking which clauses to
 * actually speak — the aggregator just supplies the data.
 *
 * NOT included in this slice:
 *   - Reminders table (schema not yet stabilized cross-tenant)
 *   - Autopilot recommendations (separate next-action provider already
 *     wins priority 92+ when there's an urgent one — this aggregator
 *     stays focused on the greeting, not action-routing)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchLifeCompass, fetchVitanaIndexForProfiler } from '../../user-context-profiler';

export interface NewDayOverviewPayload {
  /** Calendar events with start_time in (last_session_started_at, now). */
  calendar_passed_count: number;
  /** Most recent calendar event that passed since last session (for the "you had X at Y" clause). */
  calendar_passed_notable: { title: string; start_iso: string } | null;
  /** Calendar events with start_time in (now, end-of-today-local). */
  calendar_today_count: number;
  /** Next calendar event today (chronologically first). */
  calendar_today_next: { title: string; start_iso: string } | null;
  /** Current Vitana Index total (0-999) or null when no score exists. */
  vitana_index_today: number | null;
  /** 7-day delta (positive = up). Null when no history. */
  vitana_index_trend_7d: number | null;
  /** Active Life Compass goal text. Null when not set. */
  life_compass_goal: string | null;
}

/** Empty payload — used as the fallback when the aggregator is skipped or fully failed. */
export const EMPTY_OVERVIEW: NewDayOverviewPayload = {
  calendar_passed_count: 0,
  calendar_passed_notable: null,
  calendar_today_count: 0,
  calendar_today_next: null,
  vitana_index_today: null,
  vitana_index_trend_7d: null,
  life_compass_goal: null,
};

interface CalendarRow {
  title: string;
  start_time: string;
  end_time?: string | null;
  status?: string | null;
}

/** Compute the local-day [start, end] window in UTC ISO strings for a given TZ. */
export function dayWindowUtcIso(now: Date, timezone: string): { startUtc: string; endUtc: string } {
  // The local day in `timezone` containing `now` runs from local 00:00 to local 23:59:59.999.
  // Compute by formatting `now` in that TZ to get YYYY-MM-DD, then synthesize the bounds
  // back to UTC by binary-searching the timezone offset. Cheapest correct approach:
  // use Intl + parse parts.
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    const Y = parts.year, M = parts.month, D = parts.day;
    const localHour = parseInt(parts.hour ?? '0', 10);
    const localMin = parseInt(parts.minute ?? '0', 10);
    const localSec = parseInt(parts.second ?? '0', 10);
    // Offset (in ms) between local TZ wall clock and UTC at `now`.
    const localAsUtcMs = Date.UTC(parseInt(Y, 10), parseInt(M, 10) - 1, parseInt(D, 10), localHour, localMin, localSec);
    const offsetMs = now.getTime() - localAsUtcMs;
    // Local 00:00:00 of the day, expressed in UTC.
    const localMidnightUtcMs = Date.UTC(parseInt(Y, 10), parseInt(M, 10) - 1, parseInt(D, 10), 0, 0, 0) + offsetMs;
    const startUtc = new Date(localMidnightUtcMs).toISOString();
    const endUtc = new Date(localMidnightUtcMs + 24 * 3600 * 1000 - 1).toISOString();
    return { startUtc, endUtc };
  } catch {
    // Fallback to UTC day if TZ math fails.
    const utcMid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return {
      startUtc: utcMid.toISOString(),
      endUtc: new Date(utcMid.getTime() + 24 * 3600 * 1000 - 1).toISOString(),
    };
  }
}

interface AggregateArgs {
  supabase: SupabaseClient;
  userId: string;
  /** ISO timestamp marking the cutoff for "passed since last session".
   *  Pass the user's last session timestamp; null/missing → uses 24h ago. */
  lastSessionAtIso: string | null;
  /** Local date YYYY-MM-DD; used together with timezone for the today-window. */
  todayDateIso: string;
  /** IANA timezone (for the today bounds). */
  timezone: string;
  /** Current server time. */
  now: Date;
}

/**
 * Pure-async aggregator. Never throws. Per-source failures return null
 * fields. Total wall-clock budget should stay <300ms in p95 — every
 * query is best-effort and runs in parallel.
 */
export async function aggregateNewDayOverview(args: AggregateArgs): Promise<NewDayOverviewPayload> {
  const { startUtc, endUtc } = dayWindowUtcIso(args.now, args.timezone);
  const nowIso = args.now.toISOString();
  const lookbackIso = args.lastSessionAtIso ?? new Date(args.now.getTime() - 24 * 3600 * 1000).toISOString();

  const [
    calendarPassedRes,
    calendarTodayRes,
    indexSnapshot,
    lifeCompass,
  ] = await Promise.all([
    fetchCalendarPassed(args.supabase, args.userId, lookbackIso, nowIso),
    fetchCalendarTodayUpcoming(args.supabase, args.userId, nowIso, endUtc),
    fetchVitanaIndexForProfiler(args.supabase, args.userId).catch(() => null),
    fetchLifeCompass(args.supabase, args.userId).catch(() => null),
  ]);

  return {
    calendar_passed_count: calendarPassedRes.count,
    calendar_passed_notable: calendarPassedRes.notable,
    calendar_today_count: calendarTodayRes.count,
    calendar_today_next: calendarTodayRes.next,
    vitana_index_today: indexSnapshot?.total ?? null,
    vitana_index_trend_7d: indexSnapshot?.trend_7d ?? null,
    life_compass_goal: lifeCompass?.primary_goal ?? null,
  };
  // startUtc reserved for future use (timezone bounds reasoning); not currently needed.
  void startUtc;
}

async function fetchCalendarPassed(
  supabase: SupabaseClient,
  userId: string,
  lookbackIso: string,
  nowIso: string,
): Promise<{ count: number; notable: { title: string; start_iso: string } | null }> {
  try {
    const { data, error } = await supabase
      .from('calendar_events')
      .select('title, start_time, end_time, status')
      .eq('user_id', userId)
      .gte('start_time', lookbackIso)
      .lt('start_time', nowIso)
      .order('start_time', { ascending: false })
      .limit(5);
    if (error) return { count: 0, notable: null };
    const rows = (data ?? []) as CalendarRow[];
    if (rows.length === 0) return { count: 0, notable: null };
    const first = rows[0];
    return {
      count: rows.length,
      notable: { title: String(first.title ?? '').trim() || 'an event', start_iso: first.start_time },
    };
  } catch {
    return { count: 0, notable: null };
  }
}

async function fetchCalendarTodayUpcoming(
  supabase: SupabaseClient,
  userId: string,
  nowIso: string,
  endOfTodayUtcIso: string,
): Promise<{ count: number; next: { title: string; start_iso: string } | null }> {
  try {
    const { data, error } = await supabase
      .from('calendar_events')
      .select('title, start_time, end_time, status')
      .eq('user_id', userId)
      .gte('start_time', nowIso)
      .lte('start_time', endOfTodayUtcIso)
      .order('start_time', { ascending: true })
      .limit(5);
    if (error) return { count: 0, next: null };
    const rows = (data ?? []) as CalendarRow[];
    if (rows.length === 0) return { count: 0, next: null };
    const first = rows[0];
    return {
      count: rows.length,
      next: { title: String(first.title ?? '').trim() || 'an event', start_iso: first.start_time },
    };
  } catch {
    return { count: 0, next: null };
  }
}

/** Pure helper: HH:MM in user's local TZ from an ISO timestamp. Exported for tests + renderer. */
export function formatHhmmInTz(iso: string, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(new Date(iso));
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h}:${m}`;
  } catch {
    return '00:00';
  }
}
