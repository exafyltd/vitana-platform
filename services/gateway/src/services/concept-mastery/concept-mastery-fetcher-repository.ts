/**
 * concept-mastery/concept-mastery-fetcher.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The Supabase `.from(...)` call in concept-mastery-fetcher.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same query, same columns, same filters/ordering, same return shape —
 * no behavior change today. Client-agnostic (takes `supabase` as a
 * param), same convention as every other *-repository.ts in this
 * codebase.
 *
 * B3 wall note (unchanged from the source file): this stays READ-ONLY —
 * no insert/update/upsert/delete/rpc.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_assistant_state ====================

export async function fetchConceptMasteryState(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  limit: number,
) {
  return supabase
    .from('user_assistant_state')
    .select('signal_name, value, count, confidence, source, last_seen_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .or(
      "signal_name.like.concept_explained:%,signal_name.like.concept_mastery:%,signal_name.like.dyk_card_seen:%",
    )
    .order('last_seen_at', { ascending: false })
    .limit(limit);
}
