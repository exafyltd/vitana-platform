// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note:
// no test file references routes/user-preferences.ts — zero coverage
// today.
/**
 * routes/user-preferences.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same RPC
 * names, same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function getMeContextRpc(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

/** Reused by both GET /bundle and the constraint-check action flow. */
export async function getPreferenceBundleRpc(sb: SupabaseClient) {
  return sb.rpc('preference_bundle_get');
}

export async function setPreferenceRpc(
  sb: SupabaseClient,
  params: { p_category: unknown; p_key: unknown; p_value: unknown; p_priority: unknown; p_scope: unknown; p_scope_domain: unknown },
) {
  return sb.rpc('preference_set', params);
}

export async function deletePreferenceRpc(sb: SupabaseClient, params: { p_category: unknown; p_key: unknown; p_scope: unknown; p_scope_domain: unknown }) {
  return sb.rpc('preference_delete', params);
}

export async function setConstraintRpc(sb: SupabaseClient, params: { p_type: unknown; p_key: unknown; p_value: unknown; p_severity: unknown; p_reason: unknown }) {
  return sb.rpc('constraint_set', params);
}

export async function deleteConstraintRpc(sb: SupabaseClient, params: { p_type: unknown; p_key: unknown }) {
  return sb.rpc('constraint_delete', params);
}

export async function confirmPreferenceRpc(sb: SupabaseClient, params: { p_preference_id: unknown }) {
  return sb.rpc('preference_confirm', params);
}

export async function reinforceInferenceRpc(sb: SupabaseClient, params: { p_inference_id: unknown; p_evidence: unknown }) {
  return sb.rpc('inference_reinforce', params);
}

export async function downgradeInferenceRpc(sb: SupabaseClient, params: { p_inference_id: unknown; p_reason: unknown }) {
  return sb.rpc('inference_downgrade', params);
}

export async function getPreferenceAuditRpc(sb: SupabaseClient, params: { p_limit: unknown; p_offset: unknown; p_target_type: unknown }) {
  return sb.rpc('preference_get_audit', params);
}
