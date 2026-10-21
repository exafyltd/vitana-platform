/**
 * Developer voice tools — Testing & QA (C10), Wave 5 of
 * docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/testing.ts (mounted at /api/v1/testing,
 * no HTTP auth — developerGate() is the real gate), routes/test-contracts.ts
 * (mounted at /api/v1/test-contracts, requireDevAccess = exafy_admin),
 * routes/orb-tools-selfcheck.ts (requireAuth + requireExafyAdmin), and
 * routes/voice-lab.ts's /probe (requireAuth).
 *
 * dev_run_e2e shares its exact backend (POST /api/v1/testing/run) with
 * dev_run_test_suite — there is no separate "trigger E2E workflow" route.
 * Rather than duplicating business logic under a second name, it defaults
 * `projects` to `['all']` when the caller doesn't specify a subset, giving
 * it a distinct voice affordance ("run the full E2E suite") without
 * inventing a second endpoint.
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
  text: "This needs a signed-in session — I don't have one for this voice session.",
};

function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

function requireExafyAdmin(id: OrbToolIdentity): OrbToolResult | null {
  const denied = developerGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'This tool requires an exafy_admin session.' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1/5. dev_run_test_suite / dev_run_e2e — both POST /api/v1/testing/run
// ---------------------------------------------------------------------------

async function runSuite(args: OrbToolArgs, id: OrbToolIdentity, defaultProjects: string[]): Promise<OrbToolResult> {
  const denied = developerGate(id);
  if (denied) return denied;
  const projects = Array.isArray(args.projects) && args.projects.length > 0 ? args.projects : defaultProjects;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, projects },
      text: `About to run the test suite for: ${projects.join(', ')}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/testing/run', {
    method: 'POST',
    body: {
      projects,
      type: typeof args.type === 'string' ? args.type : undefined,
      community_url: typeof args.community_url === 'string' ? args.community_url : undefined,
    },
  });
  if (!ok) return { ok: true, result: { started: false, status, detail: body }, text: `Could not start the test run: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return {
    ok: true,
    result: { started: true, detail: body },
    text: body.run_id ? `Test run ${body.run_id} started.` : `Test run dispatched via ${String(body.via ?? 'CI')}.`,
  };
}

export const dev_run_test_suite: Handler = async (args, id) => runSuite(args, id, Array.isArray(args.projects) ? args.projects : []);
export const dev_run_e2e: Handler = async (args, id) => runSuite(args, id, ['all']);

// ---------------------------------------------------------------------------
// 2. dev_list_test_suites — GET /api/v1/testing/suites
// ---------------------------------------------------------------------------

export const dev_list_test_suites: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/testing/suites');
  if (!ok) return { ok: false, error: `dev_list_test_suites failed (${status}): ${String(body.error ?? 'unknown')}` };
  const suites = (Array.isArray(body.suites) ? body.suites : []) as unknown[];
  return { ok: true, result: body, text: `${suites.length} test suites available.` };
};

// ---------------------------------------------------------------------------
// 3. dev_list_test_runs — GET /api/v1/testing/runs
// ---------------------------------------------------------------------------

export const dev_list_test_runs: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 50, 100);
  const qs = new URLSearchParams({ limit: String(limit) });
  if (typeof args.type === 'string' && args.type) qs.set('type', args.type);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/testing/runs?${qs.toString()}`);
  if (!ok) return { ok: false, error: `dev_list_test_runs failed (${status}): ${String(body.error ?? 'unknown')}` };
  const runs = (Array.isArray(body.runs) ? body.runs : []) as unknown[];
  if (runs.length === 0) return { ok: true, result: { runs: [] }, text: 'No test runs found.' };
  return { ok: true, result: { runs }, text: `${runs.length} test runs.` };
};

// ---------------------------------------------------------------------------
// 4. dev_get_test_run — GET /api/v1/testing/runs/:id
// ---------------------------------------------------------------------------

export const dev_get_test_run: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const runId = String(args.run_id ?? '').trim();
  if (!runId) return { ok: false, error: 'dev_get_test_run requires run_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/testing/runs/${encodeURIComponent(runId)}`);
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No test run found with id ${runId}.` }
      : { ok: false, error: `dev_get_test_run failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const results = (Array.isArray(body.results) ? body.results : []) as Array<{ status?: string }>;
  const failed = results.filter((r) => r.status && r.status !== 'passed').length;
  return { ok: true, result: body, text: `Run ${runId}: ${results.length} results, ${failed} not passed.` };
};

// ---------------------------------------------------------------------------
// 6. dev_orb_monitor_status — GET /api/v1/testing/orb-monitor/status
// ---------------------------------------------------------------------------

export const dev_orb_monitor_status: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/testing/orb-monitor/status');
  if (!ok) return { ok: false, error: `dev_orb_monitor_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  const runs = (Array.isArray(body.runs) ? body.runs : []) as Array<{ conclusion?: string }>;
  return { ok: true, result: body, text: `${runs.length} recent ORB monitor runs; latest: ${String(runs[0]?.conclusion ?? 'unknown')}.` };
};

// ---------------------------------------------------------------------------
// 7. dev_trigger_orb_monitor — POST /api/v1/testing/orb-monitor/trigger
// ---------------------------------------------------------------------------

export const dev_trigger_orb_monitor: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true },
      text: `About to trigger the ORB monitor workflow. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/testing/orb-monitor/trigger', { method: 'POST' });
  if (!ok) return { ok: true, result: { triggered: false, status, detail: body }, text: `Could not trigger the ORB monitor: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { triggered: true }, text: `ORB monitor workflow triggered.` };
};

// ---------------------------------------------------------------------------
// 8. dev_list_test_contracts — GET /api/v1/test-contracts (exafy_admin)
// ---------------------------------------------------------------------------

export const dev_list_test_contracts: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const qs = new URLSearchParams();
  for (const k of ['service', 'environment', 'owner', 'status', 'contract_type'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/test-contracts?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_list_test_contracts failed (${status}): ${String(body.error ?? 'unknown')}` };
  const contracts = (Array.isArray(body.contracts) ? body.contracts : []) as unknown[];
  return { ok: true, result: { contracts }, text: `${contracts.length} test contracts.` };
};

// ---------------------------------------------------------------------------
// 9. dev_run_orb_selfcheck — POST /api/v1/admin/orb-tools/selfcheck (exafy_admin)
// ---------------------------------------------------------------------------

export const dev_run_orb_selfcheck: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const targetUserId = String(args.user_id ?? id.user_id ?? '').trim();
  if (!targetUserId) return { ok: false, error: 'dev_run_orb_selfcheck requires user_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, user_id: targetUserId },
      text: `About to run the ORB tools selfcheck against real data for user ${targetUserId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/orb-tools/selfcheck', {
    method: 'POST',
    headers: authHeaders(id),
    body: { user_id: targetUserId, tools: Array.isArray(args.tools) ? args.tools : undefined },
  });
  if (!ok) return { ok: true, result: { ran: false, status, detail: body }, text: `Selfcheck failed to run: ${String(body.error ?? `gateway returned ${status}`)}.` };
  const summary = (body.summary ?? {}) as Record<string, unknown>;
  return { ok: true, result: body, text: `Selfcheck: ${Number(summary.passed ?? 0)} of ${Number(summary.total ?? 0)} tools passed.` };
};

// ---------------------------------------------------------------------------
// 10. dev_voice_lab_probe — POST /api/v1/voice-lab/probe (requireAuth)
// ---------------------------------------------------------------------------

export const dev_voice_lab_probe: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/voice-lab/probe', { method: 'POST', headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_voice_lab_probe failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: body.ok === false ? `Probe failed: ${String(body.failure_mode_code ?? 'unknown')}.` : `Voice-lab probe passed.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const TESTING_QA_TOOL_HANDLERS: Record<string, Handler> = {
  dev_run_test_suite,
  dev_list_test_suites,
  dev_list_test_runs,
  dev_get_test_run,
  dev_run_e2e,
  dev_orb_monitor_status,
  dev_trigger_orb_monitor,
  dev_list_test_contracts,
  dev_run_orb_selfcheck,
  dev_voice_lab_probe,
};

export const TESTING_QA_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_run_test_suite',
    description: 'DEVELOPER ONLY. Run one or more named test suites/projects. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { projects: { type: 'array', items: { type: 'string' }, description: 'Required — suite/project names.' }, type: { type: 'string' }, community_url: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['projects'] },
  },
  { name: 'dev_list_test_suites', description: 'DEVELOPER ONLY. List available test suites/projects.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_list_test_runs', description: 'DEVELOPER ONLY. Recent test runs.', parameters: { type: 'object', properties: { type: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'dev_get_test_run', description: 'DEVELOPER ONLY. One test run + its results.', parameters: { type: 'object', properties: { run_id: { type: 'string', description: 'Required.' } }, required: ['run_id'] } },
  {
    name: 'dev_run_e2e',
    description: 'DEVELOPER ONLY. Run the full E2E test suite. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { projects: { type: 'array', items: { type: 'string' }, description: 'Optional subset; defaults to all.' }, confirm: { type: 'boolean' } } },
  },
  { name: 'dev_orb_monitor_status', description: 'DEVELOPER ONLY. Recent ORB monitor workflow runs.', parameters: { type: 'object', properties: {} } },
  {
    name: 'dev_trigger_orb_monitor',
    description: 'DEVELOPER ONLY. Trigger the ORB monitor workflow. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { confirm: { type: 'boolean' } } },
  },
  { name: 'dev_list_test_contracts', description: 'EXAFY_ADMIN ONLY. List registered test contracts.', parameters: { type: 'object', properties: { service: { type: 'string' }, environment: { type: 'string' }, owner: { type: 'string' }, status: { type: 'string' }, contract_type: { type: 'string' } } } },
  {
    name: 'dev_run_orb_selfcheck',
    description: 'EXAFY_ADMIN ONLY. Run the curated ORB tools selfcheck against real user data. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { user_id: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' } } },
  },
  { name: 'dev_voice_lab_probe', description: 'DEVELOPER ONLY. Run a synthetic voice-lab probe.', parameters: { type: 'object', properties: {} } },
];
