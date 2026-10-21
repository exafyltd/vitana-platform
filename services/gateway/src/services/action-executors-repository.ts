// Genuinely tested via test/services/action-executors.test.ts (only
// lib/supabase's getSupabase is mocked, not this module) — not a
// wholesale module mock.
/**
 * services/action-executors.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in action-executors.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same calls, same params, same columns, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function setOfferState(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.rpc('offers_set_state', { p_payload: payload });
}

export async function insertManualWearableWorkout(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('wearable_workouts').insert(row).select('id').single();
}

export async function insertCalendarEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('calendar_events').insert(row).select('id').single();
}
