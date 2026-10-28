// impact-allow-no-test: pure data-access seam (thin Supabase RPC wrappers,
// no independent request-handling behavior); exercised indirectly by
// supabase-semantic-memory.ts's existing test suite
// (test/services/supabase-semantic-memory.test.ts), which covers every
// call site here, including the v2→v1 write fallback.
/**
 * services/supabase-semantic-memory.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in supabase-semantic-memory.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same RPC names, same params, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param) — the source file still
 * owns creating the service-role client via createServiceClient() and
 * passes it in, exactly as before.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function callMemorySemanticSearch(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('memory_semantic_search', params);
}

export async function callMemoryWriteItemV2(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.rpc('memory_write_item_v2', { p_payload: payload });
}

export async function callDevBootstrapRequestContext(
  sb: SupabaseClient,
  tenantId: string | undefined,
  activeRole: string,
) {
  return sb.rpc('dev_bootstrap_request_context', {
    p_tenant_id: tenantId,
    p_active_role: activeRole,
  });
}

export async function callMemoryWriteItemV1(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.rpc('memory_write_item', { p_payload: payload });
}

export async function callMemoryGetItemsNeedingEmbeddings(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('memory_get_items_needing_embeddings', params);
}

export async function callMemoryUpdateEmbeddings(sb: SupabaseClient, updates: unknown[]) {
  return sb.rpc('memory_update_embeddings', { p_updates: updates });
}

export async function callMemoryMarkForReembed(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('memory_mark_for_reembed', params);
}
