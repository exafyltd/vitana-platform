// Genuinely tested via test/journey-foundation.test.ts, which drives a
// real functional fake SupabaseClient (table-keyed, chain-method
// agnostic — any filter method is a no-op returning `this`), not a
// wholesale module mock.
/**
 * services/journey-foundation/journey-foundation-state.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase
 * 3b/B1).
 *
 * Every Supabase `.from(...)` call in journey-foundation-state.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserJourneyFoundationRow(sb: SupabaseClient, userId: string) {
  return sb.from('user_journey_foundation').select('*').eq('user_id', userId).maybeSingle();
}

export async function fetchActiveLifeCompassGoalFull(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('primary_goal, category, target_value, target_unit, target_date, starting_value')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchProfileCreatedAt(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('created_at').eq('user_id', userId).maybeSingle();
}

export async function fetchRecentJourneySessionUpdates(sb: SupabaseClient, userId: string) {
  return sb
    .from('journey_session_updates')
    .select('session_id, completed_steps, next_step, summary, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(3);
}
