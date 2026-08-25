// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// no test file references routes/admin-embeddings-backfill.ts — zero
// coverage today.
/**
 * routes/admin-embeddings-backfill.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * routes/admin-embeddings-backfill.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countMemoryItemsTotal(sb: SupabaseClient) {
  return sb.from('memory_items').select('id', { count: 'exact', head: true });
}

export async function countMemoryItemsEmbedded(sb: SupabaseClient) {
  return sb.from('memory_items').select('id', { count: 'exact', head: true }).not('embedding', 'is', null);
}

export async function countMemoryItemsMissingEmbedding(sb: SupabaseClient) {
  return sb.from('memory_items').select('id', { count: 'exact', head: true }).is('embedding', null);
}

export async function fetchMemoryItemsMissingEmbeddingBatch(sb: SupabaseClient, batchSize: number) {
  return sb
    .from('memory_items')
    .select('id, tenant_id, user_id, content')
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .limit(batchSize);
}

export async function updateMemoryItemEmbedding(
  sb: SupabaseClient,
  itemId: string,
  patch: { embedding: number[]; embedding_model: string; embedding_updated_at: string },
) {
  return sb.from('memory_items').update(patch).eq('id', itemId);
}
