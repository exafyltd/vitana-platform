/**
 * d44-signal-detection-engine.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in d44-signal-detection-
 * engine.ts now goes through here instead of being written inline. PURE
 * MOVE, not a rewrite: same RPC names/params, same queries, same
 * conditional-filter logic, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function rpcDevBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function rpcD44CreateSignal(sb: SupabaseClient, signal: unknown) {
  return sb.rpc('d44_create_signal', { p_signal: signal });
}

export async function rpcD44GetActiveSignals(sb: SupabaseClient, params: { p_signal_types: unknown; p_min_confidence: number; p_limit: number }) {
  return sb.rpc('d44_get_active_signals', params);
}

export async function fetchPredictiveSignalById(sb: SupabaseClient, signalId: string) {
  return sb.from('d44_predictive_signals').select('*').eq('id', signalId).limit(1);
}

export async function rpcD44GetSignalEvidence(sb: SupabaseClient, signalId: string) {
  return sb.rpc('d44_get_signal_evidence', { p_signal_id: signalId });
}

export async function fetchInterventionHistoryForSignal(sb: SupabaseClient, signalId: string) {
  return sb.from('d44_intervention_history').select('*').eq('signal_id', signalId).order('created_at', { ascending: false });
}

export async function rpcD44UpdateSignalStatus(sb: SupabaseClient, signalId: string, status: string, feedback: unknown) {
  return sb.rpc('d44_update_signal_status', { p_signal_id: signalId, p_status: status, p_feedback: feedback });
}

export async function rpcD44RecordIntervention(sb: SupabaseClient, signalId: string, actionType: string, actionDetails: unknown) {
  return sb.rpc('d44_record_intervention', { p_signal_id: signalId, p_action_type: actionType, p_action_details: actionDetails });
}

export async function rpcD44GetSignalStats(sb: SupabaseClient, since: string | null) {
  return sb.rpc('d44_get_signal_stats', { p_since: since });
}

export async function fetchRecentSignalsOfType(sb: SupabaseClient, signalType: string | undefined, sinceIso: string) {
  return sb.from('d44_predictive_signals').select('id').eq('signal_type', signalType).gte('detected_at', sinceIso).limit(1);
}
