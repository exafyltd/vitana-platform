// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// test/orb-tools/reminders-clock-tools.test.ts, which covers every call
// site here (71/71 tests).
/**
 * services/orb-tools/reminders-clock-tools.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in reminders-clock-tools.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== reminders ====================

export async function fetchActiveReminderById(sb: SupabaseClient, reminderId: string, userId: string) {
  return sb
    .from('reminders')
    .select('*')
    .eq('id', reminderId)
    .eq('user_id', userId)
    .in('status', ['pending', 'dispatching', 'fired'])
    .maybeSingle();
}

export async function snoozeReminderUpdate(
  sb: SupabaseClient,
  reminderId: string,
  userId: string,
  patch: Record<string, unknown>,
) {
  return sb.from('reminders').update(patch).eq('id', reminderId).eq('user_id', userId).select('*').single();
}

export async function updateReminderPatch(
  sb: SupabaseClient,
  reminderId: string,
  userId: string,
  patch: Record<string, unknown>,
) {
  return sb.from('reminders').update(patch).eq('id', reminderId).eq('user_id', userId).select('*').maybeSingle();
}

export async function acknowledgeReminderUpdate(sb: SupabaseClient, reminderId: string, userId: string, ackedAtIso: string) {
  return sb
    .from('reminders')
    .update({ acked_at: ackedAtIso, delivery_via: 'manual' })
    .eq('id', reminderId)
    .eq('user_id', userId)
    .select('id, acked_at, delivery_via, action_text, status')
    .maybeSingle();
}

export async function completeReminderUpdate(sb: SupabaseClient, reminderId: string, userId: string, ackedAtIso: string) {
  return sb
    .from('reminders')
    .update({ status: 'completed', acked_at: ackedAtIso, delivery_via: 'manual' })
    .eq('id', reminderId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();
}

export async function fetchMissedReminders(sb: SupabaseClient, userId: string) {
  return sb
    .from('reminders')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'fired')
    .is('acked_at', null)
    .order('fired_at', { ascending: false })
    .limit(20);
}

// ==================== voice_clock_items ====================

const CLOCK_TABLE = 'voice_clock_items';

export async function insertVoiceClockItem(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from(CLOCK_TABLE).insert(row).select('*').single();
}

export async function fetchActiveAlarms(sb: SupabaseClient, userId: string) {
  return sb
    .from(CLOCK_TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('kind', 'alarm')
    .eq('status', 'active')
    .order('fires_at', { ascending: true })
    .limit(20);
}

export async function cancelAlarmClockItem(sb: SupabaseClient, alarmId: string, userId: string) {
  return sb
    .from(CLOCK_TABLE)
    .update({ status: 'cancelled' })
    .eq('id', alarmId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .select('id')
    .maybeSingle();
}

export async function fetchActiveTimers(sb: SupabaseClient, userId: string) {
  return sb
    .from(CLOCK_TABLE)
    .select('*')
    .eq('user_id', userId)
    .in('kind', ['timer', 'pomodoro'])
    .eq('status', 'active')
    .order('fires_at', { ascending: true })
    .limit(20);
}
