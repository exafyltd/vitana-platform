/**
 * VTID-02761 — Voice Tool Expansion P1d: Calendar deep tools.
 *
 * Backs the deep-action calendar voice tools that go beyond the
 * existing search/create primitives:
 *   - reschedule_event   → updateCalendarEvent
 *   - cancel_event       → softDeleteEvent
 *   - complete_event     → markEventCompleted
 *   - find_free_slot     → computeNextAvailableSlot
 *   - get_event_details  → direct read of calendar_events row
 *   - check_calendar_conflicts → checkConflicts
 *
 * All helpers are user-scoped — every query passes the calling
 * user_id to the underlying calendar-service function which enforces
 * "this row belongs to this user" before touching it.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  updateCalendarEvent,
  softDeleteEvent,
  markEventCompleted,
  computeNextAvailableSlot,
  checkConflicts,
} from '../calendar-service';

export interface VoiceCalEvent {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  status: string;
  event_type: string | null;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// 1. reschedule_event
// ---------------------------------------------------------------------------

export async function rescheduleEvent(
  userId: string,
  args: { event_id: string; start_time: string; end_time?: string },
): Promise<{ ok: true; event: VoiceCalEvent } | { ok: false; error: string }> {
  if (!args.event_id) return { ok: false, error: 'event_id_required' };
  if (!args.start_time) return { ok: false, error: 'start_time_required' };
  try {
    const updates: any = { start_time: args.start_time };
    if (args.end_time) updates.end_time = args.end_time;
    const event = await updateCalendarEvent(args.event_id, userId, updates);
    if (!event) return { ok: false, error: 'event_not_found' };
    return { ok: true, event: event as any };
  } catch (e: any) {
    return { ok: false, error: `reschedule_failed: ${e?.message ?? 'unknown'}` };
  }
}

// ---------------------------------------------------------------------------
// 2. cancel_event (soft-delete; row stays in DB with status=cancelled)
// ---------------------------------------------------------------------------

export async function cancelEvent(
  userId: string,
  args: { event_id: string },
): Promise<{ ok: true; event: VoiceCalEvent } | { ok: false; error: string }> {
  if (!args.event_id) return { ok: false, error: 'event_id_required' };
  try {
    const event = await softDeleteEvent(args.event_id, userId);
    if (!event) return { ok: false, error: 'event_not_found' };
    return { ok: true, event: event as any };
  } catch (e: any) {
    return { ok: false, error: `cancel_failed: ${e?.message ?? 'unknown'}` };
  }
}

// ---------------------------------------------------------------------------
// 3. complete_event — mark completed/skipped/partial
// ---------------------------------------------------------------------------

export async function completeEvent(
  userId: string,
  args: {
    event_id: string;
    completion_status: 'completed' | 'skipped' | 'partial';
    completion_notes?: string;
  },
): Promise<{ ok: true; event: VoiceCalEvent } | { ok: false; error: string }> {
  if (!args.event_id) return { ok: false, error: 'event_id_required' };
  if (!['completed', 'skipped', 'partial'].includes(args.completion_status)) {
    return { ok: false, error: 'invalid_completion_status' };
  }
  try {
    const event = await markEventCompleted(
      args.event_id,
      userId,
      args.completion_status,
      args.completion_notes,
    );
    if (!event) return { ok: false, error: 'event_not_found' };
    return { ok: true, event: event as any };
  } catch (e: any) {
    return { ok: false, error: `complete_failed: ${e?.message ?? 'unknown'}` };
  }
}

// ---------------------------------------------------------------------------
// 4. find_free_slot — returns the next free slot fitting the duration
// ---------------------------------------------------------------------------

export async function findFreeSlot(
  userId: string,
  role: string | null,
  args: { duration_minutes: number },
): Promise<
  { ok: true; start_time: string; duration_minutes: number } | { ok: false; error: string }
> {
  const dur = Number(args.duration_minutes);
  if (!Number.isFinite(dur) || dur < 5 || dur > 480) {
    return { ok: false, error: 'duration_out_of_range' };
  }
  try {
    const slot = await computeNextAvailableSlot(userId, role, dur);
    return {
      ok: true,
      start_time: slot.toISOString(),
      duration_minutes: dur,
    };
  } catch (e: any) {
    return { ok: false, error: `slot_search_failed: ${e?.message ?? 'unknown'}` };
  }
}

// ---------------------------------------------------------------------------
// 5. get_event_details — direct read with user_id scoping
// ---------------------------------------------------------------------------

export async function getEventDetails(
  sb: SupabaseClient,
  userId: string,
  args: { event_id: string },
): Promise<{ ok: true; event: VoiceCalEvent } | { ok: false; error: string }> {
  if (!args.event_id) return { ok: false, error: 'event_id_required' };
  const { data, error } = await sb
    .from('calendar_events')
    .select('id, title, start_time, end_time, status, event_type, description')
    .eq('id', args.event_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { ok: false, error: `details_query_failed: ${error.message}` };
  if (!data) return { ok: false, error: 'event_not_found' };
  return { ok: true, event: data as any };
}

// ---------------------------------------------------------------------------
// 6. check_calendar_conflicts — find events that overlap a proposed window
// ---------------------------------------------------------------------------

export async function checkCalendarConflicts(
  userId: string,
  role: string | null,
  args: { start_time: string; end_time: string },
): Promise<{ ok: true; conflicts: VoiceCalEvent[] } | { ok: false; error: string }> {
  if (!args.start_time || !args.end_time) {
    return { ok: false, error: 'window_required' };
  }
  try {
    const conflicts = await checkConflicts(userId, role, args.start_time, args.end_time);
    return { ok: true, conflicts: conflicts as any };
  } catch (e: any) {
    return { ok: false, error: `conflict_check_failed: ${e?.message ?? 'unknown'}` };
  }
}
