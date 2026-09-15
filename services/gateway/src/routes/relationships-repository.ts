// impact-allow-no-test: pure data-access seam (thin Supabase RPC/query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/relationships.ts — zero coverage today.
/**
 * routes/relationships.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in this file now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC names, same params, same queries, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Reused by the direct POST /nodes route and the Cognee bulk-extraction hydration. */
export async function ensureRelationshipNodeRpc(
  sb: SupabaseClient,
  params: { p_node_type: unknown; p_title: unknown; p_ref_id?: unknown; p_domain: unknown; p_metadata: unknown },
) {
  return sb.rpc('relationship_ensure_node', params);
}

/** Reused by the direct POST /edges route and the Cognee bulk-extraction hydration. */
export async function addRelationshipEdgeRpc(
  sb: SupabaseClient,
  params: { p_from_node_id: unknown; p_to_node_id: unknown; p_relationship_type: unknown; p_origin: unknown; p_context: unknown },
) {
  return sb.rpc('relationship_add_edge', params);
}

export async function fetchUserTenantIdLimit1(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).single();
}

/** Reused by the direct GET /graph route and the discover-recommendations helper. */
export async function getRelationshipGraphRpc(
  sb: SupabaseClient,
  params: { p_domain: unknown; p_node_types: unknown; p_relationship_types: unknown; p_min_strength: unknown; p_limit: unknown },
) {
  return sb.rpc('relationship_get_graph', params);
}

/** Reused by the direct GET /signals route and the discover-recommendations helper. */
export async function getRelationshipSignalsRpc(sb: SupabaseClient, params: { p_min_confidence: unknown; p_signal_keys: unknown }) {
  return sb.rpc('relationship_get_signals', params);
}

/** Reused by the direct PATCH /signals route and the Cognee bulk-extraction hydration. */
export async function updateRelationshipSignalRpc(sb: SupabaseClient, params: { p_signal_key: unknown; p_confidence: unknown; p_evidence: unknown }) {
  return sb.rpc('relationship_update_signal', params);
}
