// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references intent-compass-lens.ts — zero coverage today.
/**
 * services/intent-compass-lens.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-compass-lens.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveLifeCompassGoal(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('user_id, category, primary_goal, alignment_score, confidence_score')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
}

export async function fetchIntentCompassBoosts(sb: SupabaseClient, categories: string[], intentKinds: string[]) {
  return sb
    .from('intent_compass_boost')
    .select('compass_category, intent_kind, boost_weight')
    .in('compass_category', categories)
    .in('intent_kind', intentKinds);
}
