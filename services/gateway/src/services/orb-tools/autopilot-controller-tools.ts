/**
 * Developer voice tools — Autopilot Controller & Loop (C6), Wave 5 of
 * docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/autopilot.ts (mounted at
 * /api/v1/autopilot — the VTID-execution-loop controller; distinct from
 * routes/admin-autopilot.ts, the tenant-facing recommendations admin
 * surface already built in Wave 4 as B13). No HTTP-level auth middleware
 * on this router — `developerGate()` is the real access control here.
 *
 * dev_plan_task / dev_start_task_work / dev_complete_task_work are
 * SKIPPED. Their backing routes (POST .../plan, .../work/start,
 * .../work/complete) are explicitly DEPRECATED (VTID-01170) and return 400
 * unless the caller sets `X-BYPASS-ORCHESTRATOR: EMERGENCY-BYPASS` — the
 * platform's documented emergency-only escape hatch. Building a voice tool
 * that has to silently set that header on every routine call would turn an
 * emergency bypass into normal behavior, which the platform's own IF-THEN
 * rule forbids ("IF emergency bypass is used → THEN log + escalate" — not
 * "use it as a default"). The canonical, non-deprecated replacements
 * already exist as other tools: dev_route_to_subagent (C5, Wave 5) and the
 * worker/subagent start+complete routes reached by dev_run_exec_workflow /
 * dev_submit_evidence (C1, Wave 2). All three stay `status: planned`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit, developerGate } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function vtidOk(v: unknown): v is string {
  return typeof v === 'string' && /^VTID-\d{4,}$/.test(v);
}

// ---------------------------------------------------------------------------
// 1. dev_autopilot_loop_status — GET /api/v1/autopilot/loop/status
// ---------------------------------------------------------------------------

export const dev_autopilot_loop_status: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/autopilot/loop/status');
  if (!ok) return { ok: false, error: `dev_autopilot_loop_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Autopilot loop is ${body.is_running ? 'running' : 'stopped'}${body.errors_1h ? `, ${Number(body.errors_1h)} errors in the last hour` : ''}.` };
};

// ---------------------------------------------------------------------------
// 2/3. dev_start_autopilot_loop / dev_stop_autopilot_loop
// ---------------------------------------------------------------------------

async function toggleLoop(args: OrbToolArgs, id: OrbToolIdentity, action: 'start' | 'stop'): Promise<OrbToolResult> {
  const denied = developerGate(id);
  if (denied) return denied;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, action },
      text: `About to ${action} the autopilot event loop platform-wide. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/autopilot/loop/${action}`, { method: 'POST' });
  if (!ok) return { ok: true, result: { changed: false, status, detail: body }, text: `Could not ${action} the loop: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { changed: true, detail: body }, text: String(body.message ?? `Loop ${action}ed.`) };
}

export const dev_start_autopilot_loop: Handler = async (args, id) => toggleLoop(args, id, 'start');
export const dev_stop_autopilot_loop: Handler = async (args, id) => toggleLoop(args, id, 'stop');

// ---------------------------------------------------------------------------
// 4. dev_autopilot_loop_history — GET /api/v1/autopilot/loop/history
// ---------------------------------------------------------------------------

export const dev_autopilot_loop_history: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 100, 500);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/autopilot/loop/history?limit=${limit}`);
  if (!ok) return { ok: false, error: `dev_autopilot_loop_history failed (${status}): ${String(body.error ?? 'unknown')}` };
  const events = (Array.isArray(body.events) ? body.events : []) as unknown[];
  return { ok: true, result: body, text: `${events.length} loop history events.` };
};

// ---------------------------------------------------------------------------
// 5. dev_reset_loop_cursor — POST /api/v1/autopilot/loop/cursor/reset
// ---------------------------------------------------------------------------

export const dev_reset_loop_cursor: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const timestamp = typeof args.timestamp === 'string' && args.timestamp.trim() ? args.timestamp.trim() : 'now';
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, timestamp },
      text: `About to reset the autopilot loop cursor to "${timestamp}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/autopilot/loop/cursor/reset', {
    method: 'POST',
    body: { timestamp, reason: typeof args.reason === 'string' ? args.reason : undefined },
  });
  if (!ok) return { ok: true, result: { reset: false, status, detail: body }, text: `Could not reset the cursor: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { reset: true, detail: body }, text: `Loop cursor reset to ${timestamp}.` };
};

// ---------------------------------------------------------------------------
// 6. dev_controller_status — GET /api/v1/autopilot/controller/status
// ---------------------------------------------------------------------------

export const dev_controller_status: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/autopilot/controller/status');
  if (!ok) return { ok: false, error: `dev_controller_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: 'Autopilot controller status retrieved.' };
};

// ---------------------------------------------------------------------------
// 7. dev_list_controller_runs — GET /api/v1/autopilot/controller/runs
// ---------------------------------------------------------------------------

export const dev_list_controller_runs: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/autopilot/controller/runs');
  if (!ok) return { ok: false, error: `dev_list_controller_runs failed (${status}): ${String(body.error ?? 'unknown')}` };
  const runs = (Array.isArray(body.runs) ? body.runs : []) as Array<Record<string, unknown>>;
  if (runs.length === 0) return { ok: true, result: { runs: [] }, text: 'No active controller runs.' };
  return { ok: true, result: { runs }, text: `${runs.length} active controller runs.` };
};

// ---------------------------------------------------------------------------
// 8. dev_get_controller_run — GET /api/v1/autopilot/controller/runs/:vtid
// ---------------------------------------------------------------------------

export const dev_get_controller_run: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!vtidOk(args.vtid)) return { ok: false, error: 'dev_get_controller_run requires vtid (VTID-NNNN...).' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/autopilot/controller/runs/${encodeURIComponent(args.vtid)}`);
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No controller run found for ${args.vtid}.` }
      : { ok: false, error: `dev_get_controller_run failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return { ok: true, result: body.run ?? body, text: `Controller run for ${args.vtid} retrieved.` };
};

// ---------------------------------------------------------------------------
// 9. dev_validate_task — POST /api/v1/autopilot/tasks/:vtid/validate
// (not confirm-gated — validation/inspection, not a mutation of task state)
// ---------------------------------------------------------------------------

export const dev_validate_task: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!vtidOk(args.vtid)) return { ok: false, error: 'dev_validate_task requires vtid (VTID-NNNN...).' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/autopilot/tasks/${encodeURIComponent(args.vtid)}/validate`, {
    method: 'POST',
    body: { mode: typeof args.mode === 'string' ? args.mode : undefined },
  });
  if (!ok) return { ok: false, error: `dev_validate_task failed (${status}): ${String(body.error ?? 'unknown')}` };
  const validation = (body.validation ?? {}) as Record<string, unknown>;
  return { ok: true, result: validation, text: `Validation for ${args.vtid}: ${String(validation.final_status ?? 'unknown')}.` };
};

// ---------------------------------------------------------------------------
// 10. dev_list_pending_plans — GET /api/v1/autopilot/tasks/pending-plan
// ---------------------------------------------------------------------------

export const dev_list_pending_plans: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/autopilot/tasks/pending-plan');
  if (!ok) return { ok: false, error: `dev_list_pending_plans failed (${status}): ${String(body.error ?? 'unknown')}` };
  const tasks = (Array.isArray(body.data) ? body.data : []) as unknown[];
  if (tasks.length === 0) return { ok: true, result: { tasks: [] }, text: 'No tasks pending a plan.' };
  return { ok: true, result: { tasks }, text: `${tasks.length} tasks pending a plan.` };
};

// ---------------------------------------------------------------------------
// 11. dev_get_task_spec — GET /api/v1/autopilot/spec/:vtid
// ---------------------------------------------------------------------------

export const dev_get_task_spec: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!vtidOk(args.vtid)) return { ok: false, error: 'dev_get_task_spec requires vtid (VTID-NNNN...).' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/autopilot/spec/${encodeURIComponent(args.vtid)}`);
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No spec snapshot found for ${args.vtid}.` }
      : { ok: false, error: `dev_get_task_spec failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return { ok: true, result: body, text: `Spec snapshot for ${args.vtid}${body.integrity_valid === false ? ' — integrity check FAILED' : ''}.` };
};

// ---------------------------------------------------------------------------
// 12. dev_autopilot_pipeline_health — GET /api/v1/autopilot/pipeline/health
// ---------------------------------------------------------------------------

export const dev_autopilot_pipeline_health: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/autopilot/pipeline/health');
  if (!ok) return { ok: false, error: `dev_autopilot_pipeline_health failed (${status}): ${String(body.error ?? 'unknown')}` };
  return {
    ok: true,
    result: body,
    text: `Loop ${body.loop_running ? 'running' : 'stopped'}, execution ${body.execution_armed ? 'armed' : 'disarmed'}, ${Number(body.stuck_count ?? 0)} stuck tasks, ${Number(body.workers_active ?? 0)} active workers.`,
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const AUTOPILOT_CONTROLLER_TOOL_HANDLERS: Record<string, Handler> = {
  dev_autopilot_loop_status,
  dev_start_autopilot_loop,
  dev_stop_autopilot_loop,
  dev_autopilot_loop_history,
  dev_reset_loop_cursor,
  dev_controller_status,
  dev_list_controller_runs,
  dev_get_controller_run,
  dev_validate_task,
  dev_list_pending_plans,
  dev_get_task_spec,
  dev_autopilot_pipeline_health,
};

export const AUTOPILOT_CONTROLLER_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'dev_autopilot_loop_status', description: 'DEVELOPER ONLY. Autopilot event loop status.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_start_autopilot_loop', description: 'DEVELOPER ONLY. Start the autopilot event loop. TWO-STEP confirm.', parameters: { type: 'object', properties: { confirm: { type: 'boolean' } } } },
  { name: 'dev_stop_autopilot_loop', description: 'DEVELOPER ONLY. Stop the autopilot event loop. TWO-STEP confirm.', parameters: { type: 'object', properties: { confirm: { type: 'boolean' } } } },
  { name: 'dev_autopilot_loop_history', description: 'DEVELOPER ONLY. Recent autopilot loop events.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  {
    name: 'dev_reset_loop_cursor',
    description: 'DEVELOPER ONLY. Reset the autopilot loop cursor to a timestamp (or "now"). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { timestamp: { type: 'string', description: 'ISO timestamp or "now". Defaults to "now".' }, reason: { type: 'string' }, confirm: { type: 'boolean' } } },
  },
  { name: 'dev_controller_status', description: 'DEVELOPER ONLY. Autopilot controller status.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_list_controller_runs', description: 'DEVELOPER ONLY. Active controller runs.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_get_controller_run', description: 'DEVELOPER ONLY. One controller run by VTID.', parameters: { type: 'object', properties: { vtid: { type: 'string', description: 'Required.' } }, required: ['vtid'] } },
  { name: 'dev_validate_task', description: 'DEVELOPER ONLY. Run governance validation for a VTID.', parameters: { type: 'object', properties: { vtid: { type: 'string', description: 'Required.' }, mode: { type: 'string' } }, required: ['vtid'] } },
  { name: 'dev_list_pending_plans', description: 'DEVELOPER ONLY. Tasks awaiting a plan.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_get_task_spec', description: 'DEVELOPER ONLY. Spec snapshot for a VTID.', parameters: { type: 'object', properties: { vtid: { type: 'string', description: 'Required.' } }, required: ['vtid'] } },
  { name: 'dev_autopilot_pipeline_health', description: 'DEVELOPER ONLY. Autopilot pipeline health + task funnel summary.', parameters: { type: 'object', properties: {} } },
];
