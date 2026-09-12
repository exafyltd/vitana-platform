/**
 * orb/context/providers/match-journey-fetcher.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in match-journey-fetcher.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same filters/ordering, same return shapes —
 * no behavior change today. Client-agnostic (takes `supabase` as a param),
 * same convention as every other *-repository.ts in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== profiles ====================

export async function fetchVitanaIdForUser(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('profiles')
    .select('vitana_id')
    .eq('user_id', userId)
    .maybeSingle();
}

// ==================== intent_matches ====================

export async function fetchLatestIntentMatch(supabase: SupabaseClient, vitanaId: string) {
  return supabase
    .from('intent_matches')
    .select('match_id, intent_a_id, state, state_changed_at, created_at')
    .eq('vitana_id_a', vitanaId)
    .order('state_changed_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}
