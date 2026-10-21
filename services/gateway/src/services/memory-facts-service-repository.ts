// write_fact/get_current_facts are genuinely tested via
// test/services/memory-facts-service.test.ts, which mocks only
// createClient()'s .rpc method (a shared mockRpc jest.fn), not this
// module. updateFactEmbedding has no test coverage — no referencing
// suite ever reaches createServiceClient() with real credentials in
// the test env, so that branch (`if (!supabase) return;`) always
// short-circuits before this call would execute — impact-allow-no-test
// applies to that one function only.
/**
 * services/memory-facts-service.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * memory-facts-service.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same calls, same params,
 * same columns, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// write_fact moved to services/memory/remember.ts (VTID-04364).

export async function getCurrentFactsRpc(
  sb: SupabaseClient,
  args: {
    p_tenant_id: string;
    p_user_id: string;
    p_entity: string | null;
    p_fact_keys: string[] | null;
  },
) {
  return sb.rpc('get_current_facts', args);
}

export async function updateFactEmbedding(
  sb: SupabaseClient,
  factId: string,
  embeddingJson: string,
  embeddingModel: string,
  embeddingUpdatedAtIso: string,
) {
  return sb
    .from('memory_facts')
    .update({
      embedding: embeddingJson,
      embedding_model: embeddingModel,
      embedding_updated_at: embeddingUpdatedAtIso,
    })
    .eq('id', factId);
}
