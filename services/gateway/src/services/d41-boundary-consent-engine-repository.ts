// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references d41-boundary-consent-engine.ts — zero coverage
// today.
/**
 * services/d41-boundary-consent-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in d41-boundary-consent-engine.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPCs, same params, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function fetchPersonalBoundaries(sb: SupabaseClient) {
  return sb.rpc('d41_get_personal_boundaries');
}

export async function setPersonalBoundaryRpc(sb: SupabaseClient, boundaryType: string, value: unknown, reason: string | null) {
  return sb.rpc('d41_set_personal_boundary', { p_boundary_type: boundaryType, p_value: value, p_reason: reason });
}

export async function fetchConsentBundle(sb: SupabaseClient) {
  return sb.rpc('d41_get_consent_bundle');
}

export async function setConsentRpc(sb: SupabaseClient, topic: string, status: string, expiresAt: string | null, reason: string | null) {
  return sb.rpc('d41_set_consent', { p_topic: topic, p_status: status, p_expires_at: expiresAt, p_reason: reason });
}

export async function revokeConsentRpc(sb: SupabaseClient, topic: string, reason: string | null) {
  return sb.rpc('d41_revoke_consent', { p_topic: topic, p_reason: reason });
}
