// Genuine coverage: test/services/assistant-continuation/providers/next-action/reminder-due.test.ts
// passes a hand-built functional fake client directly (no jest.mock())
// — real coverage, not a mock.
/**
 * services/assistant-continuation/providers/next-action/sources/reminder-due.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md
 * Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in reminder-due.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchNearestPendingReminder(
  sb: SupabaseClient,
  userId: string,
  nowIso: string,
  horizonIso: string,
) {
  return sb
    .from('reminders')
    .select('id, action_text, spoken_message, next_fire_at, status')
    .eq('user_id', userId)
    .in('status', ['pending', 'dispatching'])
    .gte('next_fire_at', nowIso)
    .lte('next_fire_at', horizonIso)
    .order('next_fire_at', { ascending: true })
    .limit(1);
}
