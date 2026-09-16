/**
 * d40-life-stage-awareness-engine.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in d40-life-stage-awareness-engine.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC names, same params, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function rpcDevBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function rpcLifeStageAssess(sb: SupabaseClient, params: {
  p_session_id: string | null;
  p_include_goals: boolean;
  p_include_trajectory: boolean;
  p_context_window_days: number;
}) {
  return sb.rpc('life_stage_assess', params);
}

export async function rpcLifeStageGetCurrent(sb: SupabaseClient, sessionId: string | null) {
  return sb.rpc('life_stage_get_current', { p_session_id: sessionId });
}

export async function rpcLifeStageOverride(sb: SupabaseClient, assessmentId: string, override: Record<string, unknown>) {
  return sb.rpc('life_stage_override', { p_assessment_id: assessmentId, p_override: override });
}

export async function rpcLifeStageExplain(sb: SupabaseClient, assessmentId: string) {
  return sb.rpc('life_stage_explain', { p_assessment_id: assessmentId });
}

export async function rpcLifeStageDetectGoal(sb: SupabaseClient, params: {
  p_message: string | null;
  p_session_id: string | null;
  p_source: unknown;
}) {
  return sb.rpc('life_stage_detect_goal', params);
}

export async function rpcLifeStageGetGoals(sb: SupabaseClient) {
  return sb.rpc('life_stage_get_goals');
}

export async function rpcLifeStageUpdateGoal(sb: SupabaseClient, goalId: string, updates: Record<string, unknown>) {
  return sb.rpc('life_stage_update_goal', { p_goal_id: goalId, p_updates: updates });
}

export async function rpcLifeStageScoreTrajectory(sb: SupabaseClient, params: {
  p_actions: unknown;
  p_session_id: string | null;
  p_include_trade_offs: boolean;
}) {
  return sb.rpc('life_stage_score_trajectory', params);
}
