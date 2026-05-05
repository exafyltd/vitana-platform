/**
 * VTID-02763 — Voice Tool Expansion P1e: Reminders extension.
 *
 * Backs voice tools for the reminder lifecycle BEYOND the existing
 * set_reminder / find_reminders / delete_reminder primitives:
 *   - snooze_reminder        → push out by N minutes
 *   - update_reminder        → change text / spoken_message / time
 *   - acknowledge_reminder   → mark delivered (manual replay)
 *   - complete_reminder      → user did the thing
 *   - list_missed_reminders  → fired but not acked
 *
 * Each helper enforces user_id ownership before mutating, mirroring
 * the controls in routes/reminders.ts so voice can't reach across
 * users by id.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface ReminderRow {
  id: string;
  action_text: string;
  spoken_message?: string | null;
  next_fire_at: string;
  status: string;
  snooze_count?: number | null;
  fired_at?: string | null;
  acked_at?: string | null;
  delivery_via?: string | null;
}

// ---------------------------------------------------------------------------
// 1. snooze_reminder — push by minutes (default 10, max 24h)
// ---------------------------------------------------------------------------

export async function snoozeReminder(
  sb: SupabaseClient,
  userId: string,
  args: { reminder_id: string; minutes?: number },
): Promise<{ ok: true; reminder: ReminderRow } | { ok: false; error: string }> {
  if (!args.reminder_id) return { ok: false, error: 'reminder_id_required' };
  const minutes = Math.max(1, Math.min(Number(args.minutes ?? 10) || 10, 24 * 60));
  const newTime = new Date(Date.now() + minutes * 60_000).toISOString();

  const { data: row } = await sb
    .from('reminders')
    .select('snooze_count')
    .eq('id', args.reminder_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!row) return { ok: false, error: 'reminder_not_found' };

  const { data, error } = await sb
    .from('reminders')
    .update({
      next_fire_at: newTime,
      status: 'pending',
      fired_at: null,
      acked_at: null,
      delivery_via: null,
      snooze_count: ((row as any).snooze_count || 0) + 1,
    })
    .eq('id', args.reminder_id)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (error) return { ok: false, error: `snooze_failed: ${error.message}` };
  return { ok: true, reminder: data as any };
}

// ---------------------------------------------------------------------------
// 2. update_reminder — change action_text / spoken_message / scheduled_for_iso
// ---------------------------------------------------------------------------

export async function updateReminder(
  sb: SupabaseClient,
  userId: string,
  args: {
    reminder_id: string;
    action_text?: string;
    spoken_message?: string;
    scheduled_for_iso?: string;
    description?: string;
  },
): Promise<{ ok: true; reminder: ReminderRow } | { ok: false; error: string }> {
  if (!args.reminder_id) return { ok: false, error: 'reminder_id_required' };

  const updates: Record<string, unknown> = {};
  if (typeof args.action_text === 'string') updates.action_text = args.action_text.trim();
  if (typeof args.spoken_message === 'string') updates.spoken_message = args.spoken_message.trim();
  if (typeof args.description === 'string') updates.description = args.description;
  if (typeof args.scheduled_for_iso === 'string') {
    const t = new Date(args.scheduled_for_iso);
    if (isNaN(t.getTime())) return { ok: false, error: 'invalid_scheduled_for_iso' };
    if (t.getTime() < Date.now() + 60_000) {
      return { ok: false, error: 'time_must_be_60s_in_future' };
    }
    updates.next_fire_at = t.toISOString();
    updates.status = 'pending';
    updates.fired_at = null;
    updates.acked_at = null;
    updates.delivery_via = null;
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: 'no_updatable_fields' };
  }

  const { data, error } = await sb
    .from('reminders')
    .update(updates)
    .eq('id', args.reminder_id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();
  if (error) return { ok: false, error: `update_failed: ${error.message}` };
  if (!data) return { ok: false, error: 'reminder_not_found' };
  return { ok: true, reminder: data as any };
}

// ---------------------------------------------------------------------------
// 3. acknowledge_reminder — mark delivered (used after voice playback)
// ---------------------------------------------------------------------------

export async function acknowledgeReminder(
  sb: SupabaseClient,
  userId: string,
  args: { reminder_id: string; via?: string },
): Promise<
  | { ok: true; reminder: { id: string; acked_at: string; delivery_via: string } }
  | { ok: false; error: string }
> {
  if (!args.reminder_id) return { ok: false, error: 'reminder_id_required' };
  const via = String(args.via || 'manual');
  if (!['sse', 'fcm', 'manual', 'manual_replay', 'none'].includes(via)) {
    return { ok: false, error: 'invalid_via' };
  }

  const { data, error } = await sb
    .from('reminders')
    .update({ acked_at: new Date().toISOString(), delivery_via: via })
    .eq('id', args.reminder_id)
    .eq('user_id', userId)
    .select('id, acked_at, delivery_via')
    .maybeSingle();
  if (error) return { ok: false, error: `ack_failed: ${error.message}` };
  if (!data) return { ok: false, error: 'reminder_not_found' };
  return { ok: true, reminder: data as any };
}

// ---------------------------------------------------------------------------
// 4. complete_reminder — user did the thing
// ---------------------------------------------------------------------------

export async function completeReminder(
  sb: SupabaseClient,
  userId: string,
  args: { reminder_id: string },
): Promise<{ ok: true; reminder: ReminderRow } | { ok: false; error: string }> {
  if (!args.reminder_id) return { ok: false, error: 'reminder_id_required' };
  const { data, error } = await sb
    .from('reminders')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', args.reminder_id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();
  if (error) return { ok: false, error: `complete_failed: ${error.message}` };
  if (!data) return { ok: false, error: 'reminder_not_found' };
  return { ok: true, reminder: data as any };
}

// ---------------------------------------------------------------------------
// 5. list_missed_reminders — fired but not acked
// ---------------------------------------------------------------------------

export async function listMissedReminders(
  sb: SupabaseClient,
  userId: string,
  args: { limit?: number },
): Promise<
  | { ok: true; reminders: ReminderRow[]; count: number }
  | { ok: false; error: string }
> {
  const limit = Math.max(1, Math.min(20, args.limit ?? 5));
  const { data, error } = await sb
    .from('reminders')
    .select('*')
    .eq('user_id', userId)
    .not('fired_at', 'is', null)
    .is('acked_at', null)
    .neq('status', 'cancelled')
    .neq('status', 'completed')
    .order('fired_at', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, error: `missed_query_failed: ${error.message}` };
  const list = (data || []) as ReminderRow[];
  return { ok: true, reminders: list, count: list.length };
}
