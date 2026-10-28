// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior); exercised
// indirectly by health-capacity-awareness-engine.ts's existing test suite
// (test/services/health-capacity-awareness-engine.test.ts), which mocks
// @supabase/supabase-js, not this module.
/**
 * services/health-capacity-awareness-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in health-capacity-awareness-engine.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC names, same params, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Reused across all four call sites — identical params, identical shape. */
export async function bootstrapDevRequestContext(sb: SupabaseClient, tenantId: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: 'developer' });
}

export async function capacityComputeRpc(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('capacity_compute', params);
}

export async function capacityGetCurrentRpc(sb: SupabaseClient, sessionId: string | null) {
  return sb.rpc('capacity_get_current', { p_session_id: sessionId });
}

export async function capacityOverrideRpc(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('capacity_override', params);
}

export async function capacityFilterActionsRpc(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('capacity_filter_actions', params);
}
