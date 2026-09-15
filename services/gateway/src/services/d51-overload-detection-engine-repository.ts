// impact-allow-no-test: pure data-access seam (thin Supabase RPC/query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references d51-overload-detection-engine.ts — zero
// coverage today.
/**
 * services/d51-overload-detection-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)`/`.from(...)` call in
 * d51-overload-detection-engine.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same RPCs/queries,
 * same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function computeOverloadBaselines(sb: SupabaseClient, dimensions: string[] | null) {
  return sb.rpc('overload_compute_baselines', { p_dimensions: dimensions });
}

export async function fetchOverloadBaselines(sb: SupabaseClient, dimensions: string[] | null) {
  return sb.rpc('overload_get_baselines', { p_dimensions: dimensions });
}

export async function recordOverloadPattern(
  sb: SupabaseClient,
  params: {
    p_pattern_type: string;
    p_dimension: string;
    p_signal_sources: string[];
    p_intensity: number;
    p_trend_direction: string;
    p_supporting_evidence: string | null;
  },
) {
  return sb.rpc('overload_record_pattern', params);
}

export async function detectOverload(sb: SupabaseClient, timeWindowDays: number, dimensions: string[] | null) {
  return sb.rpc('overload_detect', { p_time_window_days: timeWindowDays, p_dimensions: dimensions });
}

export async function fetchOverloadDetections(sb: SupabaseClient, includeDismissed: boolean, limit: number) {
  return sb.rpc('overload_get_detections', { p_include_dismissed: includeDismissed, p_limit: limit });
}

export async function dismissOverloadDetection(sb: SupabaseClient, overloadId: string, reason: string | null) {
  return sb.rpc('overload_dismiss', { p_overload_id: overloadId, p_reason: reason });
}

export async function explainOverloadDetection(sb: SupabaseClient, overloadId: string) {
  return sb.rpc('overload_explain', { p_overload_id: overloadId });
}

export async function fetchD43DataPointsForOverload(sb: SupabaseClient, domains: string[], sinceIso: string, limit: number) {
  return sb.rpc('d43_get_data_points', { p_domains: domains, p_since: sinceIso, p_limit: limit });
}

export async function fetchEmotionalCognitiveSignalsSince(sb: SupabaseClient, sinceIso: string) {
  return sb
    .from('emotional_cognitive_signals')
    .select('*')
    .eq('decayed', false)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true });
}

export async function fetchCapacityStatesSince(sb: SupabaseClient, sinceIso: string) {
  return sb
    .from('capacity_state')
    .select('*')
    .eq('decayed', false)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true });
}
