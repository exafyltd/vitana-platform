/**
 * pillar-momentum/pillar-momentum-fetcher.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The Supabase `.from(...)` call in pillar-momentum-fetcher.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same query, same columns, same filters/ordering, same return shape —
 * no behavior change today. Client-agnostic (takes `supabase` as a
 * param), same convention as every other *-repository.ts in this
 * codebase.
 *
 * B5 wall note (unchanged from the source file): this stays READ-ONLY —
 * no insert/update/upsert/delete/rpc.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== vitana_index_scores ====================

export async function fetchVitanaIndexScoreHistory(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  limit: number,
) {
  return supabase
    .from('vitana_index_scores')
    .select(
      'date, score_total, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental',
    )
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(limit);
}
