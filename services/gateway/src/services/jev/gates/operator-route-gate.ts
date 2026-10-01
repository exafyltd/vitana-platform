/**
 * VTID-04816: Jev P3 gate A10 — Operator Console turn router.
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 A10)
 *
 *   operator_route   (JEV_OPERATOR_ROUTE_MODE = off | shadow | enforce)
 *
 * Every Operator Console turn sends the model the whole role-filtered tool
 * catalog (~60 tools) and lets it pick. A turn that only needs an answer, or
 * only code lookup, still pays for — and can be confused by — every tool.
 *
 * Before the turn runs, Jev `operator_route` names the lane the message asks
 * for (answer only / task management / code lookup / ops diagnostics /
 * delivery / community), in parallel with the turn, never awaited before it.
 * When the turn returns, the lane of the tools it actually called (most
 * frequent; none called → answer only) is the outcome, so agreement is known
 * at once. Enforce — sending only the lane's tools — comes after the data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';

export const OPERATOR_ROUTE_GATE = 'operator_route';
const SYSTEM_CALLER = { actor_id: 'operator-console', system: true } as const;

export type OperatorLane = 'answer_only' | 'task_management' | 'code_lookup' | 'ops_diagnostics' | 'delivery' | 'community';

/** The lane each operator tool belongs to (gemini-operator executeTool). */
export const TOOL_LANES: Record<string, OperatorLane> = {
  autopilot_activate_recommendation: 'task_management', autopilot_approve_execution: 'task_management', autopilot_cancel_execution: 'task_management',
  autopilot_create_task: 'task_management', autopilot_execute_task: 'task_management', autopilot_get_recommendations: 'task_management',
  autopilot_get_status: 'task_management', autopilot_list_recent_tasks: 'task_management', autopilot_reject_execution: 'task_management',
  autopilot_review_execution: 'task_management', autopilot_run_task: 'task_management', dev_approval_count: 'task_management',
  dev_approve_item: 'task_management', dev_approve_spec: 'task_management', dev_generate_spec: 'task_management', dev_get_spec: 'task_management',
  dev_get_task_detail: 'task_management', dev_list_approvals: 'task_management', dev_list_tasks: 'task_management', dev_quality_check: 'task_management',
  dev_reject_item: 'task_management', dev_validate_spec: 'task_management', discover_oasis_tasks: 'task_management', oasis_analyze_vtid: 'task_management',
  dev_search_codebase: 'code_lookup', dev_read_file: 'code_lookup', dev_repowise: 'code_lookup', dev_graphify: 'code_lookup', dev_graph_path: 'code_lookup',
  dev_index_query: 'code_lookup', dev_domain_atlas: 'code_lookup', dev_deep_dive: 'code_lookup', dev_get_risk: 'code_lookup', knowledge_search: 'code_lookup',
  run_code: 'code_lookup',
  dev_aws_ecs_status: 'ops_diagnostics', dev_cloudwatch_logs: 'ops_diagnostics', dev_ecs_tasks: 'ops_diagnostics', dev_db_query: 'ops_diagnostics',
  dev_run_sql_readonly: 'ops_diagnostics', dev_query_oasis_events: 'ops_diagnostics', investigate_failure: 'ops_diagnostics', dev_cicd_health: 'ops_diagnostics',
  dev_deployment_status: 'ops_diagnostics', dev_lock_status: 'ops_diagnostics', dev_system_status: 'ops_diagnostics',
  dev_create_pr: 'delivery', dev_merge_pr: 'delivery', dev_deploy_service: 'delivery', dev_verify_deploy_checklist: 'delivery',
  search_community: 'community', search_events: 'community', get_user_matches: 'community', get_wearable_metrics: 'community',
  open_discover_feed: 'community', search_marketplace_products: 'community', send_chat_message: 'community', resolve_recipient: 'community',
  recall_conversation_at_time: 'community', get_recommendations: 'community',
};

/** The lane a finished turn took: the most frequent lane of its tool calls (first wins a tie); none → answer only; unknown tools only → null. */
export function observedLane(toolNames: string[]): OperatorLane | null {
  if (toolNames.length === 0) return 'answer_only';
  const counts = new Map<OperatorLane, number>();
  for (const n of toolNames) {
    const lane = TOOL_LANES[n];
    if (lane) counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  let best: OperatorLane | null = null;
  for (const [lane, c] of counts) if (best === null || c > (counts.get(best) ?? 0)) best = lane;
  return best;
}

export function isOperatorRouteOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(OPERATOR_ROUTE_GATE, env) !== 'off';
}

export interface OperatorRouteCheck {
  shadow_id: string | null;
  lane: string | null;
}

/** Name the lane for a message and write the row. Returns null when off; never throws. */
export async function runOperatorRoute(a: {
  threadId: string;
  message: string;
  developerTools: boolean;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<OperatorRouteCheck | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(OPERATOR_ROUTE_GATE, env);
  if (mode === 'off') return null;
  try {
    const r = await decide('operator_route', { message: a.message.slice(0, 4000) || '(empty)', developer_tools: a.developerTools }, SYSTEM_CALLER, {
      ...(a.decideOptions || {}), source: `gate:${OPERATOR_ROUTE_GATE}`, env,
    });
    const lane = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
    const id = await recordJevShadowDecision(
      {
        gate: OPERATOR_ROUTE_GATE,
        decision: 'operator_route',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'operator_thread',
        subject_ref: a.threadId,
        jev_outcome: r.outcome,
        jev_verdict: r.ok ? { lane: r.verdict.value, developer_tools: a.developerTools } : { reason: r.reason, developer_tools: a.developerTools },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: 'full_tool_catalog',
        cost_usd: r.ok ? r.cost_usd : 0,
      },
      a.sb,
    );
    return { shadow_id: id, lane };
  } catch (err: any) {
    console.warn(`[jev] ${OPERATOR_ROUTE_GATE} failed for thread ${a.threadId}: ${err?.message || err}`);
    return null;
  }
}

/** The turn finished: the lane its tools took, compared with Jev's. Never throws. */
export async function recordOperatorRouteOutcome(
  check: Promise<OperatorRouteCheck | null> | null,
  toolNames: string[],
  sb?: SupabaseClient | null,
): Promise<void> {
  try {
    const c = check ? await check : null;
    if (!c || !c.shadow_id) return;
    const lane = observedLane(toolNames);
    const agreed = lane === null || c.lane === null ? null : c.lane === lane;
    await recordJevShadowOutcome(c.shadow_id, `turn_lane:${lane ?? 'unknown'}`, agreed, sb);
  } catch (err: any) {
    console.warn(`[jev] ${OPERATOR_ROUTE_GATE} outcome not recorded: ${err?.message || err}`);
  }
}
