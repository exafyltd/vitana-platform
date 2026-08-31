// Genuinely tested via test/services/find-match-exact-name.test.ts (only
// createClient is mocked at the module boundary, not this module) —
// not a wholesale module mock.
/**
 * services/intent-find-match.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in intent-find-match.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same calls, same params, same columns, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function searchIntentCatalogRpc(
  sb: SupabaseClient,
  args: {
    p_user_id: string;
    p_tenant_id: string | null;
    p_intent_kind: string;
    p_category: string | null;
    p_kind_payload: Record<string, unknown>;
    p_embedding: string | null;
    p_visibility: string;
    p_top_n: number;
  },
) {
  return sb.rpc('search_intent_catalog', args);
}

export async function insertUserIntent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_intents').insert(row).select('intent_id, requester_vitana_id').single();
}

export async function updateUserIntentEmbedding(sb: SupabaseClient, intentId: string, embedding: string) {
  return sb.from('user_intents').update({ embedding }).eq('intent_id', intentId);
}
