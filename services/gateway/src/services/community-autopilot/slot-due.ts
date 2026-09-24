/**
 * VTID-04506 (Community Autopilot CA-6): Autopilot calendar slots that come due.
 *
 * Before this, 226 slots had been booked from Autopilot suggestions and none
 * was ever started or completed: the calendar held them, nothing brought them
 * back to the member at the planned time, and ticking a linked reminder off
 * did not close the suggestion.
 *
 *   - findDueAutopilotSlot: the member's Autopilot slot starting within the
 *     window (30 min ago … 15 min ahead), not yet completed, whose suggestion
 *     is still activated. The ORB wake provider turns it into an offer.
 *   - startAutopilotSlot: the member said yes (voice) or tapped the reminder's
 *     "done": the slot is completed, the suggestion is completed (reward and
 *     state stay in the existing RPC), and the screen to open is returned.
 *   - completeReminderLinkedSlot: the reminder overlay's "Mark done" does the
 *     same for a reminder that belongs to an Autopilot slot.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const DUE_WINDOW_BEFORE_MIN = 30;
export const DUE_WINDOW_AFTER_MIN = 15;

export interface DueSlot {
  eventId: string;
  title: string;
  startTime: string;
  recommendationId: string;
  recommendationTitle: string;
  route: string | null;
}

/** Pure: is this start time inside the due window at `now`? */
export function isInDueWindow(startIso: string, now: Date): boolean {
  const t = Date.parse(startIso);
  if (!Number.isFinite(t)) return false;
  return t >= now.getTime() - DUE_WINDOW_BEFORE_MIN * 60_000 && t <= now.getTime() + DUE_WINDOW_AFTER_MIN * 60_000;
}

async function routeForRecommendation(sourceRef: string | null, action: unknown): Promise<string | null> {
  const a = action as { kind?: string; params?: Record<string, unknown> } | null;
  if (a && (a.kind === 'open_screen' || a.kind === 'start_guided_session') && typeof a.params?.route === 'string') {
    return a.params.route as string;
  }
  if (!sourceRef) return null;
  const { COMMUNITY_ACTIONS } = await import('../../routes/autopilot-recommendations');
  return COMMUNITY_ACTIONS[sourceRef]?.target ?? null;
}

export async function findDueAutopilotSlot(sb: SupabaseClient, userId: string, now: Date = new Date()): Promise<DueSlot | null> {
  const from = new Date(now.getTime() - DUE_WINDOW_BEFORE_MIN * 60_000).toISOString();
  const to = new Date(now.getTime() + DUE_WINDOW_AFTER_MIN * 60_000).toISOString();
  const { data: events, error } = await sb
    .from('calendar_events')
    .select('id,title,start_time,source_ref_id,status,completed_at')
    .eq('user_id', userId)
    .eq('source_type', 'autopilot')
    .eq('source_ref_type', 'autopilot_recommendation')
    .eq('status', 'confirmed')
    .is('completed_at', null)
    .gte('start_time', from)
    .lte('start_time', to)
    .order('start_time', { ascending: true })
    .limit(3);
  if (error || !events?.length) return null;

  for (const ev of events as Array<{ id: string; title: string; start_time: string; source_ref_id: string | null }>) {
    if (!ev.source_ref_id || !isInDueWindow(ev.start_time, now)) continue;
    const { data: recs } = await sb
      .from('autopilot_recommendations')
      .select('id,title,status,source_ref,action')
      .eq('id', ev.source_ref_id)
      .eq('user_id', userId)
      .limit(1);
    const rec = (recs as Array<{ id: string; title: string; status: string; source_ref: string | null; action: unknown }> | null)?.[0];
    if (!rec || rec.status !== 'activated') continue;
    return {
      eventId: ev.id,
      title: ev.title,
      startTime: ev.start_time,
      recommendationId: rec.id,
      recommendationTitle: rec.title,
      route: await routeForRecommendation(rec.source_ref, rec.action),
    };
  }
  return null;
}

export interface StartSlotResult {
  ok: boolean;
  error?: string;
  event_id?: string;
  recommendation_completed?: boolean;
  route?: string | null;
  title?: string;
}

/** Complete an Autopilot slot the member owns, and the suggestion it came from. */
export async function startAutopilotSlot(userId: string, eventId: string): Promise<StartSlotResult> {
  const { getOwnCalendarEvent, markEventCompleted } = await import('../calendar-service');
  const ev = await getOwnCalendarEvent(eventId, userId);
  if (!ev) return { ok: false, error: 'slot_not_found' };
  if ((ev as any).source_type !== 'autopilot' || (ev as any).source_ref_type !== 'autopilot_recommendation') {
    return { ok: false, error: 'not_an_autopilot_slot' };
  }
  const done = (ev as any).completed_at ? ev : await markEventCompleted(eventId, userId, 'completed');
  if (!done) return { ok: false, error: 'slot_update_failed' };
  const { completeSourceForCalendarEvent } = await import('../calendar-producers');
  const src = await completeSourceForCalendarEvent(done as any, userId).catch(() => ({ completed: false }));
  let route: string | null = null;
  const refId = (ev as any).source_ref_id as string | null;
  if (refId) {
    const cfgUrl = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE;
    if (cfgUrl && key) {
      const r = await fetch(
        `${cfgUrl}/rest/v1/autopilot_recommendations?id=eq.${encodeURIComponent(refId)}&user_id=eq.${encodeURIComponent(userId)}&select=source_ref,action&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      ).catch(() => null);
      const rec = r && r.ok ? ((await r.json()) as any[])[0] : null;
      route = await routeForRecommendation(rec?.source_ref ?? null, rec?.action ?? null);
    }
  }
  return { ok: true, event_id: eventId, recommendation_completed: src.completed === true, route, title: (ev as any).title };
}

/**
 * The reminder overlay's "Mark done": when the reminder belongs to an Autopilot
 * slot, finish the slot and its suggestion too. Best-effort, never throws.
 */
export async function completeReminderLinkedSlot(
  reminder: { calendar_event_id?: string | null } | null,
  userId: string,
): Promise<StartSlotResult | null> {
  const eventId = reminder?.calendar_event_id;
  if (!eventId) return null;
  try {
    const r = await startAutopilotSlot(userId, eventId);
    return r.ok ? r : null;
  } catch {
    return null;
  }
}
