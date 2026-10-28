/**
 * Intelligent Calendar — Phase 7b: Dynamic Prioritization
 *
 * Updates priority_score (0-100) on calendar events based on:
 * - Temporal urgency (closer → higher)
 * - Vitana Index pillars (VTID-04826): events that work on the user's
 *   weakest pillar (+10) or second weakest (+5), by wellness tag
 *   (PILLAR_TAGS, the canonical tag → pillar map) or event type
 * - Reschedule count (rescheduled 2x → urgency boost)
 *
 * Journey stage and completion history are not inputs yet.
 * Runs alongside the rescheduler or on-demand.
 */

import { emitOasisEvent } from './oasis-event-service';
import { PILLAR_KEYS, PILLAR_TAGS, type PillarKey } from '../lib/vitana-pillars';
import { isCommunityGateOn } from './jev/gates/community-class-a-gates';
import { RANKING_GATES, shadowCalendarPriority } from './jev/gates/community-ranking-gates';

export type PillarScores = Partial<Record<PillarKey, number>>;

const EVENT_TYPE_PILLAR: Record<string, PillarKey> = { workout: 'exercise', nutrition: 'nutrition' };
/** Below this spread between the weakest and strongest pillar, no pillar is "weak". */
const MIN_PILLAR_SPREAD = 5;

/** The pillar an event works on: its first wellness tag in PILLAR_TAGS, else its event type. Pure. */
export function eventPillar(event: { event_type?: string | null; wellness_tags?: string[] | null }): PillarKey | null {
  for (const tag of event.wellness_tags || []) {
    const t = String(tag).toLowerCase();
    for (const p of PILLAR_KEYS) if (PILLAR_TAGS[p].includes(t)) return p;
  }
  return (event.event_type && EVENT_TYPE_PILLAR[event.event_type]) || null;
}

/** +10 for the weakest pillar, +5 for the second weakest; 0 without index data or when the pillars are level. Pure. */
export function pillarBoost(pillar: PillarKey | null, scores: PillarScores | null): number {
  if (!pillar || !scores) return 0;
  const known = PILLAR_KEYS.filter((p) => typeof scores[p] === 'number').map((p) => [p, scores[p] as number] as const);
  if (known.length < 3) return 0;
  const sorted = [...known].sort((a, b) => a[1] - b[1]);
  if (sorted[sorted.length - 1][1] - sorted[0][1] < MIN_PILLAR_SPREAD) return 0;
  if (sorted[0][0] === pillar) return 10;
  if (sorted[1][0] === pillar) return 5;
  return 0;
}

/** The user's latest Vitana Index pillar scores, or null. Never throws. */
async function fetchLatestPillarScores(supabaseUrl: string, headers: Record<string, string>, userId: string): Promise<PillarScores | null> {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/vitana_index_scores?user_id=eq.${userId}&select=score_sleep,score_nutrition,score_exercise,score_hydration,score_mental&order=date.desc&limit=1`,
      { headers },
    );
    if (!resp.ok) return null;
    const row = ((await resp.json()) as any[])[0];
    if (!row) return null;
    return { sleep: row.score_sleep, nutrition: row.score_nutrition, exercise: row.score_exercise, hydration: row.score_hydration, mental: row.score_mental };
  } catch {
    return null;
  }
}

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
  const pillarScores = events.length ? await fetchLatestPillarScores(supabaseUrl, headers, userId) : null;
  // VTID-04883 (D1): the run's scores, for the Jev shadow after the loop.
  const scored: Array<{ id: string; score: number; event_type?: string | null; pillar: PillarKey | null; start_time?: string | null; reschedule_count?: number | null; source_type?: string | null }> = [];

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

      // VTID-04826: events on the user's weakest Vitana Index pillars. Without
      // index data, the old flat +3 for movement/mindfulness tags stays.
      if (pillarScores) {
        score += pillarBoost(eventPillar(event), pillarScores);
      } else {
        const tags = event.wellness_tags || [];
        if (tags.includes('movement') || tags.includes('mindfulness')) score += 3;
      }

      // Clamp to 0-100
      score = Math.min(100, Math.max(0, score));
      scored.push({ id: String(event.id), score, event_type: event.event_type, pillar: eventPillar(event), start_time: event.start_time, reschedule_count: event.reschedule_count, source_type: event.source_type });

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

  // VTID-04883 (D1): Jev shadow of this member's ranking. Fire-and-forget, after the PATCHes; the tenant is
  // looked up only when the gate is on.
  if (scored.length > 0 && isCommunityGateOn(RANKING_GATES.calendar)) {
    void (async () => {
      const tr = await fetch(`${supabaseUrl}/rest/v1/user_tenants?user_id=eq.${userId}&select=tenant_id,is_primary&order=is_primary.desc&limit=1`, { headers });
      const rows = tr.ok ? ((await tr.json()) as Array<{ tenant_id: string }>) : [];
      await shadowCalendarPriority({ tenantId: rows[0]?.tenant_id, userId, weakestPillar: weakestPillar(pillarScores), events: scored, now });
    })().catch(() => undefined);
  }

  return result;
}

/** The lowest-scoring pillar, or null without index data. Pure. */
export function weakestPillar(scores: PillarScores | null): PillarKey | null {
  if (!scores) return null;
  let best: PillarKey | null = null;
  for (const p of PILLAR_KEYS) {
    const v = scores[p];
    if (typeof v === 'number' && (best === null || v < (scores[best] as number))) best = p;
  }
  return best;
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
