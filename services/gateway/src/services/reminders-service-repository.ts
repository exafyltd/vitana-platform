// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references reminders-service.ts — zero coverage today.
/**
 * services/reminders-service.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in reminders-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertReminder(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('reminders').insert(row).select('*').single();
}

export async function cancelSingleReminder(sb: SupabaseClient, reminderId: string, userId: string, activeStatuses: string[]) {
  return sb
    .from('reminders')
    .update({ status: 'cancelled' })
    .eq('id', reminderId)
    .eq('user_id', userId)
    .in('status', activeStatuses)
    .select('id, action_text')
    .maybeSingle();
}

export async function cancelAllReminders(sb: SupabaseClient, userId: string, activeStatuses: string[]) {
  return sb.from('reminders').update({ status: 'cancelled' }).eq('user_id', userId).in('status', activeStatuses).select('id');
}

export async function fetchReminders(sb: SupabaseClient, userId: string, statuses: string[], limit: number, query: string) {
  let qb = sb
    .from('reminders')
    .select('*')
    .eq('user_id', userId)
    .in('status', statuses)
    .order('next_fire_at', { ascending: true })
    .limit(limit);

  if (query) {
    // ilike against both fields. Supabase JS .or() takes a comma-separated PostgREST filter string.
    const escaped = query.replace(/[,)]/g, ' ');
    qb = qb.or(`action_text.ilike.%${escaped}%,spoken_message.ilike.%${escaped}%`);
  }

  return qb;
}
