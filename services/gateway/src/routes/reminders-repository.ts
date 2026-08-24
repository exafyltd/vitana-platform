// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: NO
// test file in this repo directly exercises this route
// (test/orb-tools/reminders-clock-tools.test.ts covers a different,
// already-seamed module — services/orb-tools/reminders-clock-tools.ts).
// createReminder/findReminders/softDeleteReminders are delegated to
// services/reminders-service.ts and are out of scope for this seam.
/**
 * routes/reminders.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/reminders.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Reused for both GET /missed (desc, one-shot) and GET /stream's poll loop (asc, repeated). */
export async function fetchFiredUnackedReminders(sb: SupabaseClient, userId: string, ascending: boolean) {
  return sb
    .from('reminders')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'fired')
    .is('acked_at', null)
    .order('fired_at', { ascending })
    .limit(20);
}

export async function fetchReminderById(sb: SupabaseClient, id: string, userId: string) {
  return sb.from('reminders').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
}

/** Reused for PATCH /:id and POST /:id/complete — same update-by-id-and-user, select('*'), maybeSingle() shape. */
export async function updateReminderReturningFull(sb: SupabaseClient, id: string, userId: string, patch: Record<string, unknown>) {
  return sb.from('reminders').update(patch).eq('id', id).eq('user_id', userId).select('*').maybeSingle();
}

export async function fetchReminderSnoozeCount(sb: SupabaseClient, id: string, userId: string) {
  return sb.from('reminders').select('snooze_count').eq('id', id).eq('user_id', userId).maybeSingle();
}

export async function updateReminderSnooze(sb: SupabaseClient, id: string, userId: string, patch: Record<string, unknown>) {
  return sb.from('reminders').update(patch).eq('id', id).eq('user_id', userId).select('*').single();
}

export async function updateReminderAck(sb: SupabaseClient, id: string, userId: string, patch: Record<string, unknown>) {
  return sb.from('reminders').update(patch).eq('id', id).eq('user_id', userId).select('id, acked_at, delivery_via').maybeSingle();
}
