// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references d35-social-context-engine.ts — zero coverage
// today.
/**
 * services/d35-social-context-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in d35-social-context-engine.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPCs, same params, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function fetchSocialComfortProfile(sb: SupabaseClient) {
  return sb.rpc('social_get_comfort_profile');
}

export async function updateSocialComfortProfileRpc(sb: SupabaseClient, field: string, value: string, source: string) {
  return sb.rpc('social_update_comfort_profile', { p_field: field, p_value: value, p_source: source });
}

export async function computeSocialProximity(sb: SupabaseClient, nodeId: string, contextDomain: string | null) {
  return sb.rpc('social_compute_proximity', { p_node_id: nodeId, p_context_domain: contextDomain });
}

export async function computeSocialContextRpc(
  sb: SupabaseClient,
  params: {
    p_domain: string | null;
    p_intent_type: string | null;
    p_emotional_state: string | null;
    p_social_intent: boolean;
    p_max_connections: number;
  },
) {
  return sb.rpc('social_compute_context', params);
}

export async function invalidateSocialCache(sb: SupabaseClient, nodeId: string | null) {
  return sb.rpc('social_invalidate_cache', { p_node_id: nodeId });
}
