// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references trust-repair-service.ts — zero coverage today.
/**
 * services/trust-repair-service.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in trust-repair-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPCs, same params, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 *
 * Note: routes/feedback-correction.ts calls the same 6 underlying RPCs
 * via its own feedback-correction-repository.ts, with a slightly wider
 * `record_user_correction` payload shape (includes affected_item_id/
 * affected_item_type, which this caller never sets). Kept as a separate
 * module rather than sharing, per this sweep's one-repository-per-source-
 * file convention — the two callers' payload shapes are allowed to
 * diverge independently.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function recordUserCorrectionRpc(
  sb: SupabaseClient,
  payload: {
    feedback_type: string;
    content: string;
    context: Record<string, unknown>;
    affected_component: string;
    session_id: string | null;
    source: string;
  },
) {
  return sb.rpc('record_user_correction', { p_payload: payload });
}

export async function fetchTrustScores(sb: SupabaseClient) {
  return sb.rpc('get_trust_scores');
}

export async function fetchBehaviorConstraints(sb: SupabaseClient, constraintType: string | null) {
  return sb.rpc('get_behavior_constraints', { p_constraint_type: constraintType });
}

export async function fetchCorrectionHistory(sb: SupabaseClient, limit: number, offset: number, feedbackType: string | null) {
  return sb.rpc('get_correction_history', { p_limit: limit, p_offset: offset, p_feedback_type: feedbackType });
}

export async function checkBehaviorConstraintRpc(sb: SupabaseClient, constraintType: string, constraintKey: string) {
  return sb.rpc('check_behavior_constraint', { p_constraint_type: constraintType, p_constraint_key: constraintKey });
}

export async function repairTrustRpc(
  sb: SupabaseClient,
  payload: { component: string; correction_id: string | null; repair_action: string },
) {
  return sb.rpc('repair_trust', { p_payload: payload });
}
