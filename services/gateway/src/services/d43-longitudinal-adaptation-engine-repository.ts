// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note:
// both test references (test/d50-positive-trajectory-reinforcement.test.ts,
// test/routes/positive-trajectory-reinforcement.test.ts) wholesale
// jest.mock('.../d43-longitudinal-adaptation-engine', ...) — zero
// genuine coverage of this module's own DB logic.
/**
 * services/d43-longitudinal-adaptation-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in
 * d43-longitudinal-adaptation-engine.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same RPCs, same
 * params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function recordD43DataPoint(
  sb: SupabaseClient,
  params: {
    p_domain: string;
    p_key: string;
    p_value: unknown;
    p_numeric_value: number | null;
    p_source: string;
    p_confidence: number;
    p_metadata: Record<string, unknown> | null;
  },
) {
  return sb.rpc('d43_record_data_point', params);
}

export async function fetchD43DataPoints(sb: SupabaseClient, domains: string[] | null, sinceIso: string, limit: number) {
  return sb.rpc('d43_get_data_points', { p_domains: domains, p_since: sinceIso, p_limit: limit });
}

export async function fetchD43PendingAdaptations(sb: SupabaseClient, limit: number) {
  return sb.rpc('d43_get_pending_adaptations', { p_limit: limit });
}

export async function createD43AdaptationPlan(sb: SupabaseClient, plan: Record<string, unknown>) {
  return sb.rpc('d43_create_adaptation_plan', { p_plan: plan });
}

export async function updateD43AdaptationStatus(sb: SupabaseClient, planId: string, status: string, apply: boolean) {
  return sb.rpc('d43_update_adaptation_status', { p_plan_id: planId, p_status: status, p_apply: apply });
}

export async function rollbackD43Adaptation(sb: SupabaseClient, planId: string, reason: string) {
  return sb.rpc('d43_rollback_adaptation', { p_plan_id: planId, p_reason: reason });
}

export async function acknowledgeD43Drift(sb: SupabaseClient, driftId: string, response: string) {
  return sb.rpc('d43_acknowledge_drift', { p_drift_id: driftId, p_response: response });
}

export async function createD43Snapshot(sb: SupabaseClient, snapshotType: string, adaptationPlanId: string | null) {
  return sb.rpc('d43_create_snapshot', { p_snapshot_type: snapshotType, p_adaptation_plan_id: adaptationPlanId });
}
