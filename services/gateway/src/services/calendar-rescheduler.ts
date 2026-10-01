/**
 * Intelligent Calendar — Smart Rescheduler
 *
 * Moves an Autopilot or journey suggestion the user did not get to onto the
 * next day, at the same local time. Keeps the calendar alive without the
 * user having to clean up after a busy day.
 *
 * VTID-04374 rewrote the candidate rules. The original moved anything whose
 * end time had passed, which:
 *   - moved (and after three runs cancelled) whole recurring series — a
 *     habit's base row always has its first occurrence in the past;
 *   - moved entries the user had already completed;
 *   - shifted entries by an hour across a DST change (24 h in UTC is not
 *     "the same time tomorrow");
 *   - moved an entry an hour after it ended instead of after its day ended,
 *     and could land it in the past again when a run was missed.
 *
 * Now: one-off entries only, never completed, only once the entry's local
 * day is over, moved to the first future day at the same local wall-clock
 * time. After three moves the entry is dropped (status cancelled,
 * completion_status 'skipped'). Only tasks and recommendations move (never
 * journey milestones), and only those from the last LOOKBACK_DAYS days.
 */

import { emitOasisEvent } from './oasis-event-service';
import { localParts, zonedTimeToEpoch } from './calendar-recurrence';

const LOG_PREFIX = '[CalendarRescheduler]';

/** Source types whose entries are suggestions the user may not act on. */
export const RESCHEDULABLE_SOURCES = ['autopilot', 'journey'] as const;
/**
 * Only actual to-dos move. Journey wave milestones and sentinels are markers
 * of the 90-day structure, not tasks — moving them would re-date the journey.
 */
export const RESCHEDULABLE_REF_TYPES = ['autopilot_recommendation', 'journey_task'] as const;
export const MAX_RESCHEDULES = 3;
/**
 * Only entries from the last few days are carried forward. Measured
 * 2026-09-23: 849 missed suggestions going back to April and 0 from the last
 * three days — without this bound the first run would pull months of stale
 * suggestions (and their reminders) onto tomorrow for every member.
 */
export const LOOKBACK_DAYS = 3;

export interface RescheduleResult {
  rescheduled: number;
  cancelled: number;
  errors: number;
  details: Array<{ event_id: string; action: 'rescheduled' | 'cancelled' | 'error'; title: string }>;
}

export interface RescheduleCandidate {
  id: string;
  user_id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  timezone: string | null;
  reschedule_count: number | null;
  original_start_time: string | null;
}

function dayNumber(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return Date.UTC(p.y, p.mo - 1, p.d) / 86_400_000;
}

/** True once the local day the entry ends on is over. Pure. */
export function isDayOver(c: Pick<RescheduleCandidate, 'start_time' | 'end_time'>, tz: string, now: number): boolean {
  const endMs = Date.parse(c.end_time ?? c.start_time);
  if (Number.isNaN(endMs) || endMs >= now) return false;
  return dayNumber(endMs, tz) < dayNumber(now, tz);
}

/**
 * The first start on a day after `now`'s local day, at the entry's own local
 * wall-clock time; the end keeps the entry's duration. Pure, DST-aware.
 */
export function nextSlot(
  c: Pick<RescheduleCandidate, 'start_time' | 'end_time'>,
  tz: string,
  now: number,
): { start: string; end: string | null } {
  const startMs = Date.parse(c.start_time);
  const endMs = c.end_time ? Date.parse(c.end_time) : NaN;
  const duration = Number.isNaN(endMs) || endMs < startMs ? null : endMs - startMs;
  const s = localParts(startMs, tz);
  const today = localParts(now, tz);
  // Tomorrow in the user's local calendar.
  const tomorrow = new Date(Date.UTC(today.y, today.mo - 1, today.d) + 86_400_000);
  const newStart = zonedTimeToEpoch(
    tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), s.h, s.mi, s.s, tz,
  );
  return {
    start: new Date(newStart).toISOString(),
    end: duration === null ? null : new Date(newStart + duration).toISOString(),
  };
}

function validTz(tz: string | null | undefined, fallback: string): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

export async function rescheduleUnactivatedTasks(now: number = Date.now()): Promise<RescheduleResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const result: RescheduleResult = { rescheduled: 0, cancelled: 0, errors: 0, details: [] };
  if (!supabaseUrl || !svcKey) {
    console.warn(`${LOG_PREFIX} Missing Supabase credentials`);
    return result;
  }
  const headers = { apikey: svcKey, Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json' };

  const url =
    `${supabaseUrl}/rest/v1/calendar_events?select=id,user_id,title,start_time,end_time,timezone,reschedule_count,original_start_time` +
    `&source_type=in.(${RESCHEDULABLE_SOURCES.join(',')})&status=in.(confirmed,pending)` +
    `&rrule=is.null&completed_at=is.null&activated_at=is.null` +
    `&source_ref_type=in.(${RESCHEDULABLE_REF_TYPES.join(',')})` +
    `&start_time=gte.${encodeURIComponent(new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString())}` +
    `&start_time=lt.${encodeURIComponent(new Date(now).toISOString())}&order=start_time.asc&limit=200`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    console.error(`${LOG_PREFIX} Failed to fetch candidates:`, await resp.text());
    return result;
  }
  const candidates = (await resp.json()) as RescheduleCandidate[];
  if (!candidates.length) return result;

  const { createClient } = await import('@supabase/supabase-js');
  const { getUserTimezone } = await import('./daily-pace-service');
  const { resolveUserTimezone } = await import('./guide/user-timezone');
  const supa = createClient(supabaseUrl, svcKey);
  const tzByUser = new Map<string, string>();

  for (const event of candidates) {
    try {
      if (!tzByUser.has(event.user_id)) {
        tzByUser.set(event.user_id, resolveUserTimezone(await getUserTimezone(supa as any, event.user_id)));
      }
      const tz = validTz(event.timezone, tzByUser.get(event.user_id)!);
      if (!isDayOver(event, tz, now)) continue;

      const count = event.reschedule_count ?? 0;
      const guard = `id=eq.${event.id}&completed_at=is.null&status=in.(confirmed,pending)`;
      if (count >= MAX_RESCHEDULES) {
        const r = await fetch(`${supabaseUrl}/rest/v1/calendar_events?${guard}`, {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({ status: 'cancelled', completion_status: 'skipped', updated_at: new Date(now).toISOString() }),
        });
        if (!r.ok) throw new Error(`cancel ${r.status}`);
        if (((await r.json()) as unknown[]).length === 0) continue;
        result.cancelled++;
        result.details.push({ event_id: event.id, action: 'cancelled', title: event.title });
        emitOasisEvent({
          vtid: 'VTID-04374',
          type: 'calendar.event.auto_cancelled' as any,
          source: 'calendar-rescheduler',
          status: 'info',
          message: `Calendar entry dropped after ${MAX_RESCHEDULES} moves`,
          payload: { event_id: event.id, user_id: event.user_id, reschedule_count: count },
        }).catch(() => {});
        continue;
      }

      const slot = nextSlot(event, tz, now);
      const r = await fetch(`${supabaseUrl}/rest/v1/calendar_events?${guard}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          start_time: slot.start,
          end_time: slot.end,
          original_start_time: event.original_start_time || event.start_time,
          reschedule_count: count + 1,
          updated_at: new Date(now).toISOString(),
        }),
      });
      if (!r.ok) throw new Error(`move ${r.status}`);
      if (((await r.json()) as unknown[]).length === 0) continue;
      result.rescheduled++;
      result.details.push({ event_id: event.id, action: 'rescheduled', title: event.title });
      emitOasisEvent({
        vtid: 'VTID-04374',
        type: 'calendar.event.rescheduled' as any,
        source: 'calendar-rescheduler',
        status: 'info',
        message: `Calendar entry moved to ${slot.start}`,
        payload: { event_id: event.id, user_id: event.user_id, new_start: slot.start, reschedule_count: count + 1 },
      }).catch(() => {});
    } catch (err: any) {
      console.error(`${LOG_PREFIX} Error processing event ${event.id}:`, err.message);
      result.errors++;
      result.details.push({ event_id: event.id, action: 'error', title: event.title });
    }
  }

  if (result.rescheduled || result.cancelled || result.errors) {
    console.log(`${LOG_PREFIX} rescheduled=${result.rescheduled} cancelled=${result.cancelled} errors=${result.errors}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// In-process maintenance loop (replaces the dead GCP Cloud Scheduler job)
// ---------------------------------------------------------------------------

export function isCalendarMaintenanceEnabled(raw: string | undefined = process.env.CALENDAR_MAINTENANCE_ENABLED): boolean {
  return raw === 'true';
}

const RESCHEDULE_EVERY_MS = 60 * 60_000; // hourly: each entry moves once its own local day is over
const REPRIORITIZE_EVERY_MS = 6 * 60 * 60_000;
let maintenanceStarted = false;

export function startCalendarMaintenanceLoop(): boolean {
  if (maintenanceStarted || !isCalendarMaintenanceEnabled()) return false;
  maintenanceStarted = true;
  let rescheduling = false;
  let prioritizing = false;
  const reschedule = async () => {
    if (rescheduling) return;
    rescheduling = true;
    try {
      await rescheduleUnactivatedTasks();
    } catch (err: any) {
      console.error(`${LOG_PREFIX} maintenance run failed:`, err?.message);
    } finally {
      rescheduling = false;
    }
  };
  const reprioritize = async () => {
    if (prioritizing) return;
    prioritizing = true;
    try {
      const { reprioritizeAllUsers } = await import('./calendar-prioritizer');
      await reprioritizeAllUsers();
    } catch (err: any) {
      console.error(`${LOG_PREFIX} reprioritize run failed:`, err?.message);
    } finally {
      prioritizing = false;
    }
  };
  setInterval(reschedule, RESCHEDULE_EVERY_MS).unref?.();
  setInterval(reprioritize, REPRIORITIZE_EVERY_MS).unref?.();
  // First runs shortly after boot, off the startup path.
  setTimeout(reschedule, 90_000).unref?.();
  setTimeout(reprioritize, 120_000).unref?.();
  return true;
}
