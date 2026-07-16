/**
 * Developer voice tools — Dev-Autopilot Scanners & Findings (C7), Wave 5 of
 * docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/dev-autopilot.ts (mounted at
 * /api/v1/dev-autopilot). Every route below is gated server-side by
 * `requireDevRole` (Supabase JWT + `identity.exafy_admin === true`), so
 * these tools additionally require id.role === 'exafy_admin' and forward
 * id.user_jwt as Bearer.
 *
 * dev_trigger_scan is SKIPPED. The only ingestion route, POST
 * /api/v1/dev-autopilot/scan, is gated by `requireScanToken` (a CI-only
 * `X-DevAutopilot-Scan-Token` header matching an env var) — it's built for
 * the GitHub Actions workflow to push scanner results, not for interactive
 * use, and there is no user-facing "run a scanner now" endpoint. Faking a
 * scan token would mean fabricating CI credentials; stays `status: planned`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit, developerGate } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const NO_DEV_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_dev_session' },
  text: "This needs a signed-in exafy_admin session — I don't have one for this voice session.",
};

function requireExafyAdmin(id: OrbToolIdentity): OrbToolResult | null {
  const denied = developerGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'This tool requires an exafy_admin session (dev-autopilot is operator-only).' };
  }
  return null;
}

function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

// ---------------------------------------------------------------------------
// 1. dev_list_scanners — GET /api/v1/dev-autopilot/scanners
// ---------------------------------------------------------------------------

export const dev_list_scanners: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/dev-autopilot/scanners', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_list_scanners failed (${status}): ${String(body.error ?? 'unknown')}` };
  const scanners = (Array.isArray(body.scanners) ? body.scanners : []) as Array<Record<string, unknown>>;
  return { ok: true, result: { scanners }, text: `${scanners.length} scanners registered.` };
};

// ---------------------------------------------------------------------------
// 2. dev_list_impact_rules — GET /api/v1/dev-autopilot/impact-rules
// ---------------------------------------------------------------------------

export const dev_list_impact_rules: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/dev-autopilot/impact-rules', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_list_impact_rules failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rules = (Array.isArray(body.rules) ? body.rules : []) as Array<Record<string, unknown>>;
  return { ok: true, result: { rules }, text: `${rules.length} impact rules registered.` };
};

// ---------------------------------------------------------------------------
// 3. dev_get_auto_approve_config — GET /api/v1/dev-autopilot/auto-approve
// ---------------------------------------------------------------------------

export const dev_get_auto_approve_config: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/dev-autopilot/auto-approve', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_get_auto_approve_config failed (${status}): ${String(body.error ?? 'unknown')}` };
  const config = (body.config ?? {}) as Record<string, unknown>;
  return { ok: true, result: body, text: `Auto-approve kill switch ${config.kill_switch ? 'ON' : 'off'}, daily budget ${Number(config.daily_budget ?? 0)}.` };
};

// ---------------------------------------------------------------------------
// 4. dev_list_scan_runs — GET /api/v1/dev-autopilot/runs
// ---------------------------------------------------------------------------

export const dev_list_scan_runs: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const limit = clampLimit(args.limit, 20, 100);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/runs?limit=${limit}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_list_scan_runs failed (${status}): ${String(body.error ?? 'unknown')}` };
  const runs = (Array.isArray(body.runs) ? body.runs : []) as unknown[];
  return { ok: true, result: { runs }, text: `${runs.length} scan runs.` };
};

// ---------------------------------------------------------------------------
// 5. dev_get_scan_run — GET /api/v1/dev-autopilot/runs/:run_id
// ---------------------------------------------------------------------------

export const dev_get_scan_run: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const runId = String(args.run_id ?? '').trim();
  if (!runId) return { ok: false, error: 'dev_get_scan_run requires run_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/runs/${encodeURIComponent(runId)}`, { headers: authHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No scan run found with id ${runId}.` }
      : { ok: false, error: `dev_get_scan_run failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return { ok: true, result: body.run ?? body, text: `Scan run ${runId} retrieved.` };
};

// ---------------------------------------------------------------------------
// 6. dev_findings_queue — GET /api/v1/dev-autopilot/queue
// ---------------------------------------------------------------------------

export const dev_findings_queue: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const limit = clampLimit(args.limit, 200, 500);
  const qs = new URLSearchParams({ limit: String(limit) });
  for (const k of ['kind', 'status', 'risk', 'domain', 'sort'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/queue?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_findings_queue failed (${status}): ${String(body.error ?? 'unknown')}` };
  const findings = (Array.isArray(body.findings) ? body.findings : []) as unknown[];
  if (findings.length === 0) return { ok: true, result: { findings: [] }, text: 'No findings in the queue.' };
  return { ok: true, result: { findings }, text: `${findings.length} findings in the queue.` };
};

// ---------------------------------------------------------------------------
// 7. dev_get_finding — GET /api/v1/dev-autopilot/findings/:id
// ---------------------------------------------------------------------------

export const dev_get_finding: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_get_finding requires finding_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}`, { headers: authHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No finding found with id ${findingId}.` }
      : { ok: false, error: `dev_get_finding failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return { ok: true, result: body, text: `Finding ${findingId} retrieved.` };
};

// ---------------------------------------------------------------------------
// 8. dev_generate_finding_plan — POST /api/v1/dev-autopilot/findings/:id/generate-plan
// ---------------------------------------------------------------------------

export const dev_generate_finding_plan: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_generate_finding_plan requires finding_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, finding_id: findingId },
      text: `About to generate a fix plan for finding ${findingId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}/generate-plan`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { generated: false, status, detail: body }, text: `Could not generate a plan: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { generated: true, detail: body }, text: `Fix plan generated for finding ${findingId}.` };
};

// ---------------------------------------------------------------------------
// 9. dev_reject_finding — POST /api/v1/dev-autopilot/findings/:id/reject
// ---------------------------------------------------------------------------

export const dev_reject_finding: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_reject_finding requires finding_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, finding_id: findingId },
      text: `About to reject finding ${findingId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}/reject`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { rejected: false, status, detail: body }, text: `Could not reject the finding: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { rejected: true }, text: `Finding ${findingId} rejected.` };
};

// ---------------------------------------------------------------------------
// 10. dev_snooze_finding — POST /api/v1/dev-autopilot/findings/:id/snooze
// (read-ish per the plan's "Snooze (R)" — no confirm gate, low-risk toggle)
// ---------------------------------------------------------------------------

export const dev_snooze_finding: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_snooze_finding requires finding_id.' };
  const hours = typeof args.hours === 'number' && args.hours > 0 && args.hours <= 720 ? args.hours : undefined;
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}/snooze`, {
    method: 'POST',
    headers: authHeaders(id),
    body: { hours },
  });
  if (!ok) return { ok: true, result: { snoozed: false, status, detail: body }, text: `Could not snooze the finding: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { snoozed: true }, text: `Finding ${findingId} snoozed for ${hours ?? 24} hours.` };
};

// ---------------------------------------------------------------------------
// 11. dev_approve_auto_execute — POST /api/v1/dev-autopilot/findings/:id/approve-auto-execute
// ---------------------------------------------------------------------------

export const dev_approve_auto_execute: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_approve_auto_execute requires finding_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, finding_id: findingId },
      text: `About to approve finding ${findingId} for auto-execution — this lets it run and merge without further human review. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}/approve-auto-execute`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { approved: false, status, detail: body }, text: `Could not approve auto-execution: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { approved: true, detail: body }, text: `Finding ${findingId} approved for auto-execution.` };
};

// ---------------------------------------------------------------------------
// 12. dev_cancel_execution — POST /api/v1/dev-autopilot/executions/:id/cancel
// ---------------------------------------------------------------------------

export const dev_cancel_execution: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const executionId = String(args.execution_id ?? '').trim();
  if (!executionId) return { ok: false, error: 'dev_cancel_execution requires execution_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, execution_id: executionId },
      text: `About to cancel execution ${executionId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/executions/${encodeURIComponent(executionId)}/cancel`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { cancelled: false, status, detail: body }, text: `Could not cancel the execution: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { cancelled: true }, text: `Execution ${executionId} cancelled.` };
};

// ---------------------------------------------------------------------------
// 13. dev_list_executions — GET /api/v1/dev-autopilot/executions
// ---------------------------------------------------------------------------

export const dev_list_executions: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const limit = clampLimit(args.limit, 100, 500);
  const qs = new URLSearchParams({ limit: String(limit) });
  if (typeof args.status === 'string' && args.status) qs.set('status', args.status);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/executions?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_list_executions failed (${status}): ${String(body.error ?? 'unknown')}` };
  const executions = (Array.isArray(body.executions) ? body.executions : []) as unknown[];
  return { ok: true, result: { executions }, text: `${executions.length} executions.` };
};

// ---------------------------------------------------------------------------
// 14. dev_get_execution_lineage — GET /api/v1/dev-autopilot/executions/:id/lineage
// ---------------------------------------------------------------------------

export const dev_get_execution_lineage: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const executionId = String(args.execution_id ?? '').trim();
  if (!executionId) return { ok: false, error: 'dev_get_execution_lineage requires execution_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/dev-autopilot/executions/${encodeURIComponent(executionId)}/lineage`, { headers: authHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No execution found with id ${executionId}.` }
      : { ok: false, error: `dev_get_execution_lineage failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const lineage = (Array.isArray(body.lineage) ? body.lineage : []) as unknown[];
  return { ok: true, result: body, text: `Lineage for ${executionId}: ${lineage.length} related executions.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DEV_AUTOPILOT_SCANNERS_TOOL_HANDLERS: Record<string, Handler> = {
  dev_list_scanners,
  dev_list_impact_rules,
  dev_get_auto_approve_config,
  dev_list_scan_runs,
  dev_get_scan_run,
  dev_findings_queue,
  dev_get_finding,
  dev_generate_finding_plan,
  dev_reject_finding,
  dev_snooze_finding,
  dev_approve_auto_execute,
  dev_cancel_execution,
  dev_list_executions,
  dev_get_execution_lineage,
};

export const DEV_AUTOPILOT_SCANNERS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'dev_list_scanners', description: 'EXAFY_ADMIN ONLY. List dev-autopilot scanners.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_list_impact_rules', description: 'EXAFY_ADMIN ONLY. List impact rules.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_get_auto_approve_config', description: 'EXAFY_ADMIN ONLY. Auto-approve config, budget, and autonomy progress.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_list_scan_runs', description: 'EXAFY_ADMIN ONLY. Recent scan runs.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'dev_get_scan_run', description: 'EXAFY_ADMIN ONLY. One scan run by id.', parameters: { type: 'object', properties: { run_id: { type: 'string', description: 'Required.' } }, required: ['run_id'] } },
  { name: 'dev_findings_queue', description: 'EXAFY_ADMIN ONLY. Findings queue.', parameters: { type: 'object', properties: { kind: { type: 'string' }, status: { type: 'string' }, risk: { type: 'string' }, domain: { type: 'string' }, sort: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'dev_get_finding', description: 'EXAFY_ADMIN ONLY. One finding + plan versions.', parameters: { type: 'object', properties: { finding_id: { type: 'string', description: 'Required.' } }, required: ['finding_id'] } },
  {
    name: 'dev_generate_finding_plan',
    description: 'EXAFY_ADMIN ONLY. Generate a fix plan for a finding. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { finding_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['finding_id'] },
  },
  {
    name: 'dev_reject_finding',
    description: 'EXAFY_ADMIN ONLY. Reject a finding. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { finding_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['finding_id'] },
  },
  {
    name: 'dev_snooze_finding',
    description: 'EXAFY_ADMIN ONLY. Snooze a finding for N hours (default 24, max 720).',
    parameters: { type: 'object', properties: { finding_id: { type: 'string', description: 'Required.' }, hours: { type: 'number' } }, required: ['finding_id'] },
  },
  {
    name: 'dev_approve_auto_execute',
    description: 'EXAFY_ADMIN ONLY. Approve a finding for autonomous execution + merge, no further review. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { finding_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['finding_id'] },
  },
  {
    name: 'dev_cancel_execution',
    description: 'EXAFY_ADMIN ONLY. Cancel a running execution. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { execution_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['execution_id'] },
  },
  { name: 'dev_list_executions', description: 'EXAFY_ADMIN ONLY. List executions (defaults to active only).', parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'dev_get_execution_lineage', description: 'EXAFY_ADMIN ONLY. Execution lineage (root + all descendants).', parameters: { type: 'object', properties: { execution_id: { type: 'string', description: 'Required.' } }, required: ['execution_id'] } },
];
