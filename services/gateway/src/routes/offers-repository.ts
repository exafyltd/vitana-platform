// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/offers.ts — zero coverage today.
/**
 * routes/offers.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same RPCs,
 * same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function catalogAddService(
  sb: SupabaseClient,
  payload: { name: string; service_type: string; topic_keys: string[]; provider_name?: string; metadata: Record<string, unknown> },
) {
  return sb.rpc('catalog_add_service', { p_payload: payload });
}

export async function catalogAddProduct(
  sb: SupabaseClient,
  payload: { name: string; product_type: string; topic_keys: string[]; metadata: Record<string, unknown> },
) {
  return sb.rpc('catalog_add_product', { p_payload: payload });
}

export async function offersSetState(
  sb: SupabaseClient,
  payload: { target_type: string; target_id: string; state: string; trust_score?: number; notes?: string },
) {
  return sb.rpc('offers_set_state', { p_payload: payload });
}

export async function offersRecordOutcome(
  sb: SupabaseClient,
  payload: { target_type: string; target_id: string; outcome_date: string; outcome_type: string; perceived_impact: string; evidence: Record<string, unknown> },
) {
  return sb.rpc('offers_record_outcome', { p_payload: payload });
}

export async function offersGetRecommendations(sb: SupabaseClient, limit: number, targetType: string | null) {
  return sb.rpc('offers_get_recommendations', { p_limit: limit, p_target_type: targetType });
}

export async function offersGetMemory(sb: SupabaseClient, limit: number, targetType: string | null, state: string | null) {
  return sb.rpc('offers_get_memory', { p_limit: limit, p_target_type: targetType, p_state: state });
}
