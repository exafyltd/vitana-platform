// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references d45-predictive-risk-forecasting-engine.ts —
// zero coverage today.
/**
 * services/d45-predictive-risk-forecasting-engine.ts — Aurora migration
 * B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase
 * 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in
 * d45-predictive-risk-forecasting-engine.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * RPCs, same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function fetchD43DataPointsForForecast(sb: SupabaseClient, domains: string[] | null, sinceIso: string, limit: number) {
  return sb.rpc('d43_get_data_points', { p_domains: domains, p_since: sinceIso, p_limit: limit });
}

export async function storeD45Window(sb: SupabaseClient, window: unknown) {
  return sb.rpc('d45_store_window', { p_window: window });
}

export async function fetchD45Windows(
  sb: SupabaseClient,
  params: {
    p_window_types: string[] | null;
    p_domains: string[] | null;
    p_status: string[] | null;
    p_include_past: boolean;
    p_limit: number;
    p_offset: number;
  },
) {
  return sb.rpc('d45_get_windows', params);
}

export async function fetchD45WindowDetails(sb: SupabaseClient, windowId: string) {
  return sb.rpc('d45_get_window_details', { p_window_id: windowId });
}

export async function acknowledgeD45Window(sb: SupabaseClient, windowId: string, feedback: unknown, notes: string | null) {
  return sb.rpc('d45_acknowledge_window', { p_window_id: windowId, p_feedback: feedback, p_notes: notes });
}

export async function invalidateD45Window(sb: SupabaseClient, windowId: string, reason: string) {
  return sb.rpc('d45_invalidate_window', { p_window_id: windowId, p_reason: reason });
}
