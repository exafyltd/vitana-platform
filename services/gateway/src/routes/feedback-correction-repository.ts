// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/feedback-correction.ts — zero coverage
// today.
/**
 * routes/feedback-correction.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same RPCs,
 * same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function recordUserCorrection(
  sb: SupabaseClient,
  payload: {
    feedback_type: string;
    content: string;
    context: unknown;
    affected_component: string;
    affected_item_id: string | null;
    affected_item_type: string | null;
    session_id: string | null;
    source: string;
  },
) {
  return sb.rpc('record_user_correction', { p_payload: payload });
}

export async function getCorrectionHistory(sb: SupabaseClient, limit: number, offset: number, feedbackType: string | null) {
  return sb.rpc('get_correction_history', { p_limit: limit, p_offset: offset, p_feedback_type: feedbackType });
}

export async function getTrustScores(sb: SupabaseClient) {
  return sb.rpc('get_trust_scores');
}

export async function repairTrust(
  sb: SupabaseClient,
  payload: { component: string; correction_id: string | null; repair_action: string },
) {
  return sb.rpc('repair_trust', { p_payload: payload });
}

export async function getBehaviorConstraints(sb: SupabaseClient, constraintType: string | null) {
  return sb.rpc('get_behavior_constraints', { p_constraint_type: constraintType });
}

export async function checkBehaviorConstraint(sb: SupabaseClient, constraintType: string, constraintKey: string) {
  return sb.rpc('check_behavior_constraint', { p_constraint_type: constraintType, p_constraint_key: constraintKey });
}
