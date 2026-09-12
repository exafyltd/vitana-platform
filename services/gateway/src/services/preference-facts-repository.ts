// Genuine coverage: test/services/preference-facts.test.ts passes a
// hand-built functional fake client directly (no jest.mock()) and asserts
// on the exact chained calls issued — real coverage, not a mock.
/**
 * services/preference-facts.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in preference-facts.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes the same `SupabaseLike` shape as
 * the source file's own client param).
 *
 * `buildPreferenceFactsQuery` returns only the query-initiating
 * `.from('memory_facts').select(...)...order().limit()` builder, so the
 * source file's one conditional filter (`opts.tenantId`) keeps mutating
 * it in place exactly as before — the same reasoning already applied to
 * discover-search-repository.ts's buildProductSearchQuery and its
 * siblings.
 */

type SupabaseLike = { from: (table: string) => any };

export function buildPreferenceFactsQuery(client: SupabaseLike, userId: string, factKeyPrefix: string, limit: number) {
  return client
    .from('memory_facts')
    .select('fact_key, fact_value, provenance_source, provenance_confidence, extracted_at')
    .eq('user_id', userId)
    .like('fact_key', `${factKeyPrefix}%`)
    .is('superseded_at', null)
    .order('extracted_at', { ascending: false })
    .limit(limit);
}
