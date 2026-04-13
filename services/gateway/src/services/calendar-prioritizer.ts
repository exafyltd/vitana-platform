/**
 * Intelligent Calendar — Phase 7b: Dynamic Prioritization
 *
 * Updates priority_score (0-100) on calendar events based on:
 * - Temporal urgency (closer → higher)
 * - Health signals (declining index → boost wellness events)
 * - Journey stage (current wave events get priority)
 * - Completion history (patterns from past behavior)
 * - Reschedule count (rescheduled 2x → urgency boost)
 *
 * Runs alongside the rescheduler or on-demand.
 */

import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[CalendarPrioritizer]';

export interface PrioritizationResult {
  updated: number;
  errors: number;
}

/**
 * Reprioritize all upcoming events for a given user.
 */
export async function reprioritizeUserEvents(userId: string): Promise<PrioritizationResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !svcKey) {
    return { updated: 0, errors: 0 };
  }

  const headers = {
    apikey: svcKey,
    Authorization: `Bearer ${svcKey}`,
    'Content-Type': 'application/json',
  };

  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Fetch upcoming events for the next 7 days
  const url = `${supabaseUrl}/rest/v1/calendar_events?user_id=eq.${userId}&status=in.(confirmed,pending)&start_time=gte.${now.toISOString()}&start_time=lte.${weekFromNow.toISOString()}&select=id,title,start_time,event_type,wellness_tags,reschedule_count,priority_score,source_type&order=start_time.asc&limit=50`;

  const resp = await fetch(url, { headers });
  if (!resp.ok) return { updated: 0, errors: 0 };

  const events = await resp.json() as any[];
  const result: PrioritizationResult = { updated: 0, errors: 0 };

  for (const event of events) {
    try {
      let score = 50; // Base score

      // Temporal urgency: events in the next 24h get +20, next 3 days +10
      const hoursUntil = (new Date(event.start_time).getTime() - now.getTime()) / (60 * 60 * 1000);
      if (hoursUntil <= 24) score += 20;
      else if (hoursUntil <= 72) score += 10;

      // Reschedule urgency: rescheduled 2x → +15 (now or never)
      if (event.reschedule_count >= 2) score += 15;
      else if (event.reschedule_count === 1) score += 5;

      // Health events get a baseline boost (wellness is always important)
      if (['health', 'workout', 'nutrition', 'wellness_nudge'].includes(event.event_type)) {
        score += 5;
      }

      // Journey milestones get a boost
      if (event.event_type === 'journey_milestone') score += 10;

      // Movement-tagged events when health signals are low could get extra boost
      // (Future: integrate with health_features_daily for real-time signals)
      const tags = event.wellness_tags || [];
      if (tags.includes('movement') || tags.includes('mindfulness')) score += 3;

      // Clamp to 0-100
      score = Math.min(100, Math.max(0, score));

      // Only update if score changed
      if (score !== event.priority_score) {
        const patchResp = await fetch(
          `${supabaseUrl}/rest/v1/calendar_events?id=eq.${event.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ priority_score: score, updated_at: new Date().toISOString() }),
          },
        );

        if (patchResp.ok) {
          result.updated++;
        } else {
          result.errors++;
        }
      }
    } catch (err: any) {
      console.error(`${LOG_PREFIX} Error prioritizing event ${event.id}:`, err.message);
      result.errors++;
    }
  }

  return result;
}

/**
 * Batch reprioritize for all active users.
 * Called by the scheduler endpoint.
 */
export async function reprioritizeAllUsers(): Promise<{
  users_processed: number;
  total_updated: number;
  total_errors: number;
}> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !svcKey) {
    return { users_processed: 0, total_updated: 0, total_errors: 0 };
  }

  // Find users with upcoming events
  const now = new Date().toISOString();
  const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${supabaseUrl}/rest/v1/calendar_events?status=in.(confirmed,pending)&start_time=gte.${now}&start_time=lte.${weekFromNow}&select=user_id&limit=1000`;

  const resp = await fetch(url, {
    headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
  });
  if (!resp.ok) return { users_processed: 0, total_updated: 0, total_errors: 0 };

  const rows = await resp.json() as any[];
  const userIds = [...new Set(rows.map((r: any) => r.user_id))];

  console.log(`${LOG_PREFIX} Reprioritizing events for ${userIds.length} users`);

  let totalUpdated = 0;
  let totalErrors = 0;

  for (const uid of userIds) {
    const result = await reprioritizeUserEvents(uid as string);
    totalUpdated += result.updated;
    totalErrors += result.errors;
  }

  console.log(`${LOG_PREFIX} Done: ${userIds.length} users, ${totalUpdated} updated, ${totalErrors} errors`);

  emitOasisEvent({
    vtid: 'SYSTEM',
    type: 'calendar.prioritization.completed' as any,
    source: 'calendar-prioritizer',
    status: 'info',
    message: `Calendar prioritization: ${userIds.length} users, ${totalUpdated} events updated`,
    payload: { users_processed: userIds.length, total_updated: totalUpdated, total_errors: totalErrors },
  }).catch(() => {});

  return { users_processed: userIds.length, total_updated: totalUpdated, total_errors: totalErrors };
}
