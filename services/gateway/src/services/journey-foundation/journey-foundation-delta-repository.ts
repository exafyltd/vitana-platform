// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior); exercised
// indirectly by journey-foundation-delta.ts's existing test suite
// (test/journey-foundation-delta.test.ts), which uses a real stateful
// fake Supabase client (writes reflected in subsequent reads) covering
// the full answer -> write -> re-verify -> delta loop, not a whole-module
// mock.
/**
 * services/journey-foundation/journey-foundation-delta.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in journey-foundation-delta.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchJourneyFoundationRow(sb: SupabaseClient, userId: string) {
  return sb.from('user_journey_foundation').select('*').eq('user_id', userId).maybeSingle();
}

export async function insertJourneyFoundationRow(sb: SupabaseClient, userId: string) {
  return sb.from('user_journey_foundation').insert({ user_id: userId }).select('*').maybeSingle();
}

export async function updateJourneyFoundationRow(sb: SupabaseClient, userId: string, patch: Record<string, unknown>) {
  return sb.from('user_journey_foundation').update(patch).eq('user_id', userId);
}

export async function fetchActiveLifeCompassId(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function updateLifeCompassGoal(sb: SupabaseClient, id: string, payload: Record<string, unknown>) {
  return sb.from('life_compass').update(payload).eq('id', id);
}

export async function insertLifeCompassGoal(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('life_compass').insert(row);
}
