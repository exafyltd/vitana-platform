// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references d36-financial-monetization-engine.ts — zero
// coverage today.
/**
 * services/d36-financial-monetization-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * d36-financial-monetization-engine.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries/RPCs,
 * same columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function fetchRecentMonetizationSignals(sb: SupabaseClient, sinceIso: string) {
  return sb.from('monetization_signals').select('*').gte('detected_at', sinceIso).order('detected_at', { ascending: false }).limit(50);
}

export async function fetchRecentMonetizationAttemptsForSession(sb: SupabaseClient, sessionId: string) {
  return sb.from('monetization_attempts').select('*').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
}

export async function fetchRecentValueSignals(sb: SupabaseClient, sinceIso: string) {
  return sb.from('value_signals').select('*').gte('detected_at', sinceIso).order('detected_at', { ascending: false }).limit(100);
}

export function insertMonetizationSignalRecords(sb: SupabaseClient, records: unknown[]): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('monetization_signals').insert(records);
}

export function insertValueSignalRecords(sb: SupabaseClient, records: unknown[]): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('value_signals').insert(records);
}

export async function insertMonetizationSignal(
  sb: SupabaseClient,
  row: { signal_type: string; indicator: string; weight: number; detected_at: string; context: string | undefined; session_id: string | undefined },
) {
  return sb.from('monetization_signals').insert(row).select('id').single();
}

export async function insertValueSignal(
  sb: SupabaseClient,
  row: { signal_type: string; driver: string; strength: number; detected_at: string; context: string | undefined; session_id: string | undefined },
) {
  return sb.from('value_signals').insert(row).select('id').single();
}

export async function insertMonetizationAttempt(
  sb: SupabaseClient,
  row: {
    attempt_type: string;
    outcome: string;
    readiness_score_at_attempt: number;
    envelope_at_attempt: unknown;
    user_response: string | undefined;
    session_id: string | undefined;
    created_at: string;
  },
) {
  return sb.from('monetization_attempts').insert(row).select('id').single();
}

export async function fetchMonetizationAttemptsHistory(sb: SupabaseClient, limit: number) {
  return sb.from('monetization_attempts').select('*', { count: 'exact' }).order('created_at', { ascending: false }).limit(limit);
}
