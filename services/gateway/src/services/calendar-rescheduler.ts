/**
 * Intelligent Calendar — Phase 7a: Smart Rescheduler
 *
 * Background service that auto-moves unactivated autopilot/journey tasks
 * to the next day. Keeps the calendar alive without user intervention.
 *
 * Runs daily via Cloud Scheduler at ~23:00 UTC.
 * Max 3 reschedules before auto-cancelling with user notification.
 */

import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[CalendarRescheduler]';

export interface RescheduleResult {
  rescheduled: number;
  cancelled: number;
  errors: number;
  details: Array<{ event_id: string; action: 'rescheduled' | 'cancelled' | 'error'; title: string }>;
}

/**
 * Find and reschedule all unactivated autopilot/journey events
 * whose time window has passed.
 */
export async function rescheduleUnactivatedTasks(): Promise<RescheduleResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !svcKey) {
    console.warn(`${LOG_PREFIX} Missing Supabase credentials`);
    return { rescheduled: 0, cancelled: 0, errors: 0, details: [] };
  }

  const now = new Date().toISOString();
  const headers = {
    apikey: svcKey,
    Authorization: `Bearer ${svcKey}`,
    'Content-Type': 'application/json',
  };

  // Find candidates: autopilot/journey events that have passed, not activated, not cancelled
  const url = `${supabaseUrl}/rest/v1/calendar_events?source_type=in.(autopilot,journey)&status=in.(confirmed,pending)&end_time=lt.${now}&activated_at=is.null&select=id,title,start_time,end_time,reschedule_count,user_id&order=end_time.asc&limit=200`;

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    console.error(`${LOG_PREFIX} Failed to fetch candidates:`, await resp.text());
    return { rescheduled: 0, cancelled: 0, errors: 0, details: [] };
  }

  const candidates = await resp.json() as any[];
  console.log(`${LOG_PREFIX} Found ${candidates.length} unactivated events to process`);

  const result: RescheduleResult = { rescheduled: 0, cancelled: 0, errors: 0, details: [] };

  for (const event of candidates) {
    try {
      if ((event.reschedule_count || 0) >= 3) {
        // Max reschedules reached → cancel
        const cancelResp = await fetch(
          `${supabaseUrl}/rest/v1/calendar_events?id=eq.${event.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              status: 'cancelled',
              completion_status: 'skipped',
              updated_at: new Date().toISOString(),
            }),
          },
        );

        if (cancelResp.ok) {
          result.cancelled++;
          result.details.push({ event_id: event.id, action: 'cancelled', title: event.title });

          emitOasisEvent({
            vtid: 'SYSTEM',
            type: 'calendar.event.auto_cancelled' as any,
            source: 'calendar-rescheduler',
            status: 'info',
            message: `Calendar event auto-cancelled after 3 reschedules: ${event.title}`,
            payload: { event_id: event.id, user_id: event.user_id, reschedule_count: event.reschedule_count },
          }).catch(() => {});
        } else {
          result.errors++;
          result.details.push({ event_id: event.id, action: 'error', title: event.title });
        }
      } else {
        // Reschedule to same time-of-day, next day
        const oldStart = new Date(event.start_time);
        const oldEnd = new Date(event.end_time);
        const durationMs = oldEnd.getTime() - oldStart.getTime();

        const newStart = new Date(oldStart);
        newStart.setDate(newStart.getDate() + 1);
        const newEnd = new Date(newStart.getTime() + durationMs);

        const rescheduleResp = await fetch(
          `${supabaseUrl}/rest/v1/calendar_events?id=eq.${event.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              start_time: newStart.toISOString(),
              end_time: newEnd.toISOString(),
              original_start_time: event.original_start_time || event.start_time,
              reschedule_count: (event.reschedule_count || 0) + 1,
              updated_at: new Date().toISOString(),
            }),
          },
        );

        if (rescheduleResp.ok) {
          result.rescheduled++;
          result.details.push({ event_id: event.id, action: 'rescheduled', title: event.title });

          emitOasisEvent({
            vtid: 'SYSTEM',
            type: 'calendar.event.rescheduled' as any,
            source: 'calendar-rescheduler',
            status: 'info',
            message: `Calendar event auto-rescheduled: ${event.title} → ${newStart.toISOString()}`,
            payload: {
              event_id: event.id,
              user_id: event.user_id,
              new_start: newStart.toISOString(),
              reschedule_count: (event.reschedule_count || 0) + 1,
            },
          }).catch(() => {});
        } else {
          result.errors++;
          result.details.push({ event_id: event.id, action: 'error', title: event.title });
        }
      }
    } catch (err: any) {
      console.error(`${LOG_PREFIX} Error processing event ${event.id}:`, err.message);
      result.errors++;
      result.details.push({ event_id: event.id, action: 'error', title: event.title });
    }
  }

  console.log(`${LOG_PREFIX} Done: ${result.rescheduled} rescheduled, ${result.cancelled} cancelled, ${result.errors} errors`);
  return result;
}
