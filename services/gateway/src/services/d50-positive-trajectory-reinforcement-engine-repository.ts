// impact-allow-no-test: pure data-access seam (thin Supabase RPC wrappers, no
// independent request-handling behavior); exercised indirectly by
// d50-positive-trajectory-reinforcement-engine.ts's existing test suite
// (test/d50-positive-trajectory-reinforcement.test.ts), which covers every
// call site here.
/**
 * services/d50-positive-trajectory-reinforcement-engine.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in
 * d50-positive-trajectory-reinforcement-engine.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same RPC
 * names, same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function bootstrapDevRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function getLastReinforcement(sb: SupabaseClient, trajectoryType: string) {
  return sb.rpc('d50_get_last_reinforcement', { p_trajectory_type: trajectoryType });
}

export async function countTodayReinforcements(sb: SupabaseClient) {
  return sb.rpc('d50_count_today_reinforcements');
}

export async function storeReinforcement(
  sb: SupabaseClient,
  params: {
    p_trajectory_type: string;
    p_confidence: number;
    p_what_is_working: string;
    p_why_it_matters: string;
    p_suggested_focus: string | null | undefined;
    p_source_signals: unknown[];
    p_source_trends: unknown[];
    p_context_snapshot: unknown;
    p_dismissible: boolean;
  },
) {
  return sb.rpc('d50_store_reinforcement', params);
}

export async function markReinforcementDelivered(sb: SupabaseClient, reinforcementId: string) {
  return sb.rpc('d50_mark_delivered', { p_reinforcement_id: reinforcementId });
}

export async function dismissReinforcementRpc(sb: SupabaseClient, reinforcementId: string, reason: string | null) {
  return sb.rpc('d50_dismiss_reinforcement', { p_reinforcement_id: reinforcementId, p_reason: reason });
}

export async function getRecentReinforcements(
  sb: SupabaseClient,
  params: { p_trajectory_types: unknown; p_include_dismissed: unknown; p_limit: unknown },
) {
  return sb.rpc('d50_get_recent_reinforcements', params);
}
