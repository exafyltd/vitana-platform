/**
 * Developer action tools (VTID-ASSISTANT-ROLES).
 *
 * Extends the read-only developer voice tools (developer-tools.ts,
 * VTID-02782) with the briefing tool and GUARDED action tools so a
 * developer can drive the platform's development loop by voice from the
 * Command Hub: self-healing approve/reject/rollback, dev-autopilot
 * finding lifecycle, test runs, governance-control reads + disarm, VTID
 * allocation, and the (exafy-admin-gated) publish-to-prod.
 *
 * Every handler re-checks the caller's role server-side (developerGate).
 * Every state-changing handler goes through runGuardedAction (action
 * brake → two-step confirm → rate limit → OASIS decision audit).
 *
 * Wrapping strategy: gateway SELF-CALLS to the exact governed endpoints
 * the Command Hub buttons call — no new state machines:
 *   - /api/v1/self-healing/*      (no route auth; service-role internally)
 *   - /api/v1/testing/*           (no route auth)
 *   - /api/v1/vtid/allocate       (no route auth; allocator-gate enforced)
 *   - /api/v1/dev-autopilot/*     (requireDevRole: exafy_admin JWT or
 *                                  X-Gateway-Internal token — we pass the
 *                                  internal token because developerGate has
 *                                  already authorized the caller's role)
 *   - /api/v1/operator/publish|revert (requireAdminAuth: the USER's JWT is
 *                                  forwarded — publish stays exafy-admin
 *                                  only; the assistant never escalates)
 *   - /api/v1/governance/controls/:key (header-gated; DISARM ONLY — the
 *                                  assistant may engage brakes, never
 *                                  release them; re-arming is a deliberate
 *                                  human act in the Command Hub)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { developerGate, normalizeVtidCandidates } from './developer-tools';
import { runGuardedAction } from './action-guard';
import {
  buildDeveloperBriefing,
  renderDeveloperBriefingBlock,
} from '../assistant-briefing/developer-briefing-service';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function gatewayBaseUrl(): string {
  return process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 8080}`;
}

interface SelfCallOptions {
  method?: string;
  body?: unknown;
  /** 'none' | 'internal' (X-Gateway-Internal) | 'user' (caller's Bearer JWT) | 'operator-headers' */
  auth?: 'none' | 'internal' | 'user' | 'operator-headers';
  id?: OrbToolIdentity;
}

async function gatewayApi(
  path: string,
  opts: SelfCallOptions = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth === 'internal') {
    const internalToken = process.env.GATEWAY_INTERNAL_TOKEN || '';
    if (internalToken) headers['X-Gateway-Internal'] = internalToken;
    else if (opts.id?.user_jwt) headers['Authorization'] = `Bearer ${opts.id.user_jwt}`;
  } else if (opts.auth === 'user') {
    if (opts.id?.user_jwt) headers['Authorization'] = `Bearer ${opts.id.user_jwt}`;
  } else if (opts.auth === 'operator-headers') {
    headers['x-user-id'] = opts.id?.user_id || 'orb-assistant';
    headers['x-user-role'] = 'operator';
  }
  const res = await fetch(`${gatewayBaseUrl()}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body — keep {} */
  }
  return { ok: res.ok, status: res.status, body };
}

function failText(action: string, status: number, body: Record<string, unknown>): string {
  return `${action} did not go through (${status}): ${String(body.error ?? body.message ?? 'unknown error')}.`;
}

// ---------------------------------------------------------------------------
// T0 — dev_get_briefing
// ---------------------------------------------------------------------------

export const dev_get_briefing: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const since = typeof args.since === 'string' && args.since ? args.since : null;
    const envelope = await buildDeveloperBriefing(since);
    return {
      ok: true,
      result: envelope,
      text: renderDeveloperBriefingBlock(envelope),
    };
  } catch (err) {
    return { ok: false, error: `dev_get_briefing failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// T0 — self-healing pending approvals (the human gate of the healing loop)
// ---------------------------------------------------------------------------

export const dev_list_pending_heals: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
    const { ok, status, body } = await gatewayApi(`/api/v1/self-healing/pending-approval?limit=${limit}`);
    if (!ok || body.ok !== true) {
      return { ok: false, error: failText('Listing pending heals', status, body) };
    }
    const items = (Array.isArray(body.items) ? body.items : []) as Array<Record<string, unknown>>;
    if (items.length === 0) {
      return { ok: true, result: { items: [] }, text: 'No self-healing fixes are waiting for approval.' };
    }
    const lines = items.map((it, i) => {
      const diag = typeof it.diagnosis === 'object' && it.diagnosis
        ? String((it.diagnosis as Record<string, unknown>).summary ?? '').slice(0, 160)
        : '';
      return `${i + 1}. id ${String(it.id).slice(0, 8)}… — ${String(it.failure_class ?? 'failure')} on ${String(it.endpoint ?? 'unknown endpoint')}${it.vtid ? ` (${it.vtid})` : ''}${diag ? ` — ${diag}` : ''}`;
    });
    return {
      ok: true,
      result: { items },
      text: `${items.length} self-healing fix${items.length === 1 ? '' : 'es'} pending approval: ${lines.join(' ')} ` +
        `To act, use dev_approve_heal or dev_reject_heal with the item's full id from the result payload.`,
    };
  } catch (err) {
    return { ok: false, error: `dev_list_pending_heals failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// T0 — dev-autopilot findings + executions
// ---------------------------------------------------------------------------

export const dev_list_findings: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
    const status = String(args.status ?? 'new');
    const { ok, status: httpStatus, body } = await gatewayApi(
      `/api/v1/dev-autopilot/queue?status=${encodeURIComponent(status)}&sort=impact&limit=${limit}`,
      { auth: 'internal', id },
    );
    if (!ok || body.ok !== true) {
      return { ok: false, error: failText('Listing autopilot findings', httpStatus, body) };
    }
    const findings = (Array.isArray(body.findings) ? body.findings : []) as Array<Record<string, unknown>>;
    if (findings.length === 0) {
      return { ok: true, result: { findings: [] }, text: `No autopilot findings with status "${status}".` };
    }
    const lines = findings.map((f, i) =>
      `${i + 1}. "${String(f.title ?? '(untitled)')}" — risk ${String(f.risk_class ?? '?')}, impact ${String(f.impact_score ?? '?')}${f.auto_exec_eligible ? ', auto-exec eligible' : ''}${f.block_reason ? ` (blocked: ${String(f.block_reason)})` : ''}`);
    return {
      ok: true,
      result: { findings },
      text: `${findings.length} autopilot finding${findings.length === 1 ? '' : 's'}: ${lines.join(' ')} ` +
        `Use dev_generate_finding_plan to plan one, dev_approve_finding_execute to run it, dev_reject_finding or dev_snooze_finding otherwise (ids are in the result payload).`,
    };
  } catch (err) {
    return { ok: false, error: `dev_list_findings failed: ${String((err as Error)?.message || err)}` };
  }
};

export const dev_list_executions: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const status = String(args.status ?? 'active');
    const { ok, status: httpStatus, body } = await gatewayApi(
      `/api/v1/dev-autopilot/executions?status=${encodeURIComponent(status)}&limit=10`,
      { auth: 'internal', id },
    );
    if (!ok || body.ok !== true) {
      return { ok: false, error: failText('Listing executions', httpStatus, body) };
    }
    const executions = (Array.isArray(body.executions) ? body.executions : []) as Array<Record<string, unknown>>;
    if (executions.length === 0) {
      return { ok: true, result: { executions: [] }, text: `No autopilot executions with status "${status}".` };
    }
    const lines = executions.map((e, i) =>
      `${i + 1}. ${String(e.status)}${e.pr_number ? `, PR #${String(e.pr_number)}` : ''}${e.branch ? `, branch ${String(e.branch)}` : ''}${e.self_healing_vtid ? `, heals ${String(e.self_healing_vtid)}` : ''}`);
    return {
      ok: true,
      result: { executions },
      text: `${executions.length} execution${executions.length === 1 ? '' : 's'} (${status}): ${lines.join(' ')}`,
    };
  } catch (err) {
    return { ok: false, error: `dev_list_executions failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// T0 — testing + governance controls
// ---------------------------------------------------------------------------

export const dev_list_test_runs: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
    const [runsRes, suitesRes] = await Promise.all([
      gatewayApi(`/api/v1/testing/runs?limit=${limit}`),
      gatewayApi('/api/v1/testing/suites'),
    ]);
    if (!runsRes.ok || runsRes.body.ok !== true) {
      return { ok: false, error: failText('Listing test runs', runsRes.status, runsRes.body) };
    }
    const runs = (Array.isArray(runsRes.body.runs) ? runsRes.body.runs : []) as Array<Record<string, unknown>>;
    const suites = suitesRes.ok && Array.isArray(suitesRes.body.suites) ? suitesRes.body.suites : [];
    const lines = runs.slice(0, limit).map((r, i) =>
      `${i + 1}. ${String(r.status ?? 'unknown')}${r.project ? ` — ${String(r.project)}` : ''}${r.created_at ? ` (${String(r.created_at)})` : ''}`);
    return {
      ok: true,
      result: { runs, suites },
      text: runs.length === 0
        ? 'No recent test runs. Use dev_run_test_suite to start one.'
        : `${runs.length} recent test run${runs.length === 1 ? '' : 's'}: ${lines.join(' ')}`,
    };
  } catch (err) {
    return { ok: false, error: `dev_list_test_runs failed: ${String((err as Error)?.message || err)}` };
  }
};

export const dev_get_governance_controls: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const { getAllSystemControls } = await import('../system-controls-service');
    const controls = await getAllSystemControls();
    if (!controls || controls.length === 0) {
      return { ok: true, result: { controls: [] }, text: 'No governance controls are registered in the control plane.' };
    }
    const lines = controls.map((c: any) => `${c.key}: ${c.enabled ? 'ENABLED' : 'DISABLED'}${c.reason ? ` (${c.reason})` : ''}`);
    return {
      ok: true,
      result: { controls },
      text: `${controls.length} governance controls: ${lines.join('. ')}. ` +
        'I can DISARM a control for you (dev_disarm_control) — re-arming is a human act in the Command Hub.',
    };
  } catch (err) {
    return { ok: false, error: `dev_get_governance_controls failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// T1 — reversible writes
// ---------------------------------------------------------------------------

const VALID_TEST_PROJECTS = new Set([
  'all',
  'desktop-community', 'desktop-patient', 'desktop-professional', 'desktop-staff', 'desktop-admin', 'desktop-shared',
  'mobile-community', 'mobile-patient', 'mobile-professional', 'mobile-staff', 'mobile-admin', 'mobile-shared',
  'hub-developer', 'hub-admin', 'hub-staff', 'hub-shared',
]);

export const dev_run_test_suite: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const rawProjects = Array.isArray(args.projects)
    ? (args.projects as unknown[]).map(String)
    : [String(args.project ?? args.projects ?? '')].filter(Boolean);
  const projects = rawProjects.filter((p) => VALID_TEST_PROJECTS.has(p));
  if (projects.length === 0) {
    return {
      ok: false,
      error: `dev_run_test_suite requires at least one valid project. Valid: ${[...VALID_TEST_PROJECTS].join(', ')}.`,
    };
  }
  return runGuardedAction(args, id, {
    tool: 'dev_run_test_suite',
    tier: 1,
    readBack: `This starts the E2E test run for: ${projects.join(', ')}. It consumes CI capacity but changes no product state.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi('/api/v1/testing/run', {
        method: 'POST',
        body: { projects, type: 'e2e' },
      });
      if (!ok || body.ok !== true) {
        return { ok: false, error: failText('Starting the test run', status, body) };
      }
      return {
        ok: true,
        result: body,
        text: `Test run started for ${projects.join(', ')} (via ${String(body.via ?? 'runner')}${body.run_id ? `, run ${String(body.run_id)}` : ''}). I can check dev_list_test_runs for the result in a few minutes.`,
      };
    },
  });
};

export const dev_generate_finding_plan: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_generate_finding_plan requires finding_id (from dev_list_findings).' };
  return runGuardedAction(args, id, {
    tool: 'dev_generate_finding_plan',
    tier: 1,
    readBack: `This asks the autopilot planner to generate an implementation plan for finding ${findingId.slice(0, 8)}…. It writes a plan version but executes nothing.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi(
        `/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}/generate-plan`,
        { method: 'POST', auth: 'internal', id },
      );
      if (!ok || body.ok !== true) {
        return { ok: false, error: failText('Plan generation', status, body) };
      }
      return { ok: true, result: body, text: 'Plan generated. Say "read me the plan" or approve execution with dev_approve_finding_execute.' };
    },
  });
};

export const dev_snooze_finding: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_snooze_finding requires finding_id.' };
  const hours = Math.max(1, Math.min(720, Number(args.hours) || 24));
  return runGuardedAction(args, id, {
    tool: 'dev_snooze_finding',
    tier: 1,
    readBack: `This snoozes finding ${findingId.slice(0, 8)}… for ${hours} hours — it comes back automatically afterwards.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi(
        `/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}/snooze`,
        { method: 'POST', body: { hours }, auth: 'internal', id },
      );
      if (!ok || body.ok !== true) return { ok: false, error: failText('Snoozing the finding', status, body) };
      return { ok: true, result: body, text: `Finding snoozed for ${hours} hours.` };
    },
  });
};

export const dev_allocate_vtid: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const title = String(args.title ?? '').trim();
  if (!title) return { ok: false, error: 'dev_allocate_vtid requires a title for the task.' };
  return runGuardedAction(args, id, {
    tool: 'dev_allocate_vtid',
    tier: 1,
    readBack: `This allocates the next VTID in the global ledger, titled "${title}". Allocation is permanent (VTIDs are never reused) but the task starts as scheduled/draft.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi('/api/v1/vtid/allocate', {
        method: 'POST',
        body: { source: 'orb-voice', layer: 'DEV', module: 'TASK', title },
      });
      if (!ok || body.ok !== true) {
        if (status === 409) {
          return { ok: false, error: 'The VTID allocator is disabled (governance gate). A human must enable it before new VTIDs can be minted.' };
        }
        return { ok: false, error: failText('VTID allocation', status, body) };
      }
      return { ok: true, result: body, text: `Allocated ${String(body.vtid)} — "${title}". Next step would be generating and approving its spec before any execution.` };
    },
  });
};

// ---------------------------------------------------------------------------
// T2 — destructive / outward-facing
// ---------------------------------------------------------------------------

function uuidish(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
}

export const dev_approve_heal: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const healId = uuidish(args.id);
  if (!healId) return { ok: false, error: 'dev_approve_heal requires the pending item\'s full UUID id (from dev_list_pending_heals result payload).' };
  return runGuardedAction(args, id, {
    tool: 'dev_approve_heal',
    tier: 2,
    readBack: `This APPROVES self-healing fix ${healId.slice(0, 8)}… — the fix spec is dispatched into the autonomous execution pipeline (branch, PR, CI, deploy to staging). It can be rolled back afterwards with dev_rollback_heal.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi('/api/v1/self-healing/approve', {
        method: 'POST',
        body: { id: healId, operator: id.user_id },
      });
      if (!ok || body.ok !== true) return { ok: false, error: failText('Approving the fix', status, body) };
      return { ok: true, result: body, text: `Fix approved${body.vtid ? ` — tracking ${String(body.vtid)}` : ''}. I can monitor it with dev_list_active_healing.` };
    },
  });
};

export const dev_reject_heal: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const healId = uuidish(args.id);
  if (!healId) return { ok: false, error: 'dev_reject_heal requires the pending item\'s full UUID id.' };
  const reason = String(args.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'dev_reject_heal requires a reason — ask the developer why.' };
  return runGuardedAction(args, id, {
    tool: 'dev_reject_heal',
    tier: 2,
    readBack: `This REJECTS self-healing fix ${healId.slice(0, 8)}… with reason "${reason}". The diagnosis is closed and the fix is not executed.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi('/api/v1/self-healing/reject', {
        method: 'POST',
        body: { id: healId, operator: id.user_id, reason },
      });
      if (!ok || body.ok !== true) return { ok: false, error: failText('Rejecting the fix', status, body) };
      return { ok: true, result: body, text: `Fix rejected. Reason recorded: ${reason}.` };
    },
  });
};

export const dev_rollback_heal: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const candidates = normalizeVtidCandidates(args.vtid);
  if (candidates.length === 0) return { ok: false, error: 'dev_rollback_heal requires the healing VTID (e.g. "VTID-03412").' };
  const vtid = candidates[0];
  return runGuardedAction(args, id, {
    tool: 'dev_rollback_heal',
    tier: 2,
    readBack: `This ROLLS BACK self-healing fix ${vtid} to its pre-fix snapshot. The fix's changes are reverted.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi(
        `/api/v1/self-healing/rollback/${encodeURIComponent(vtid)}`,
        { method: 'POST' },
      );
      if (!ok || body.ok !== true) {
        if (status === 404) return { ok: false, error: `No pre-fix snapshot exists for ${vtid} — it cannot be rolled back automatically.` };
        return { ok: false, error: failText('Rollback', status, body) };
      }
      return { ok: true, result: body, text: `${vtid} rolled back to its pre-fix snapshot.` };
    },
  });
};

export const dev_approve_finding_execute: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_approve_finding_execute requires finding_id.' };
  return runGuardedAction(args, id, {
    tool: 'dev_approve_finding_execute',
    tier: 2,
    readBack: `This APPROVES finding ${findingId.slice(0, 8)}… for AUTONOMOUS EXECUTION: the autopilot writes code on a branch, opens a PR, watches CI, and merges toward staging. The pipeline refuses findings that already have an open PR (stranded-PR guard). One finding at a time — no batch approvals by voice.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi(
        `/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}/approve-auto-execute`,
        { method: 'POST', auth: 'internal', id },
      );
      if (!ok || body.ok !== true) return { ok: false, error: failText('Approving execution', status, body) };
      return { ok: true, result: body, text: 'Execution approved and queued. I can track it with dev_list_executions.' };
    },
  });
};

export const dev_reject_finding: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const findingId = String(args.finding_id ?? '').trim();
  if (!findingId) return { ok: false, error: 'dev_reject_finding requires finding_id.' };
  return runGuardedAction(args, id, {
    tool: 'dev_reject_finding',
    tier: 2,
    readBack: `This REJECTS autopilot finding ${findingId.slice(0, 8)}… — it is closed and will not be proposed again.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi(
        `/api/v1/dev-autopilot/findings/${encodeURIComponent(findingId)}/reject`,
        { method: 'POST', auth: 'internal', id },
      );
      if (!ok || body.ok !== true) return { ok: false, error: failText('Rejecting the finding', status, body) };
      return { ok: true, result: body, text: 'Finding rejected.' };
    },
  });
};

export const dev_cancel_execution: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const executionId = String(args.execution_id ?? '').trim();
  if (!executionId) return { ok: false, error: 'dev_cancel_execution requires execution_id (from dev_list_executions).' };
  return runGuardedAction(args, id, {
    tool: 'dev_cancel_execution',
    tier: 2,
    readBack: `This CANCELS in-flight autopilot execution ${executionId.slice(0, 8)}…. Work already pushed to its branch remains, but the pipeline stops driving it.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi(
        `/api/v1/dev-autopilot/executions/${encodeURIComponent(executionId)}/cancel`,
        { method: 'POST', auth: 'internal', id },
      );
      if (!ok || body.ok !== true) return { ok: false, error: failText('Cancelling the execution', status, body) };
      return { ok: true, result: body, text: 'Execution cancelled.' };
    },
  });
};

export const dev_publish_to_prod: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!id.user_jwt) {
    return { ok: false, error: 'Publishing requires your own credentials in the session — the publish endpoint verifies YOU are an authorized super-admin. Use the Command Hub PUBLISH button instead.' };
  }
  const mode = String(args.mode ?? 'full') === 'canary' ? 'canary' : 'full';
  return runGuardedAction(args, id, {
    tool: 'dev_publish_to_prod',
    tier: 2,
    readBack: `This PUBLISHES the currently active STAGING build to PRODUCTION (mode: ${mode}) — the same governed promote as the Command Hub PUBLISH button. Confirm the staging build has been verified before saying yes. Prod can be reverted afterwards with the Command Hub revert card.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi('/api/v1/operator/publish', {
        method: 'POST',
        body: { mode },
        auth: 'user',
        id,
      });
      if (!ok || body.ok !== true) {
        if (status === 401 || status === 403) {
          return { ok: false, error: 'The publish endpoint refused your credentials — publishing to production requires super-admin (exafy_admin) rights.' };
        }
        return { ok: false, error: failText('Publish', status, body) };
      }
      return { ok: true, result: body, text: `Publish to production dispatched (${mode}). Verify prod per the deployment protocol once the promote completes.` };
    },
  });
};

/** Disarm-only keys the assistant may touch. Re-arming is human-only. */
const DISARMABLE_CONTROL_KEYS = new Set([
  'autopilot_execution_enabled',
  'vtid_allocator_enabled',
  'assistant_actions_enabled',
  'unified_conversation_enabled',
  'vitana_brain_enabled',
  'vitana_brain_orb_enabled',
]);

export const dev_disarm_control: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const key = String(args.key ?? '').trim().toLowerCase();
  if (!DISARMABLE_CONTROL_KEYS.has(key)) {
    return { ok: false, error: `dev_disarm_control can only DISARM one of: ${[...DISARMABLE_CONTROL_KEYS].join(', ')}. Re-arming any control is a human act in the Command Hub.` };
  }
  const reason = String(args.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'dev_disarm_control requires a reason — it is recorded in the governance audit.' };
  return runGuardedAction(args, id, {
    tool: 'dev_disarm_control',
    tier: 2,
    readBack: `This DISARMS governance control "${key}" with reason "${reason}". Everything gated by it halts immediately. The assistant CANNOT re-arm it — a human must, from the Command Hub.`,
    execute: async () => {
      const { ok, status, body } = await gatewayApi(
        `/api/v1/governance/controls/${encodeURIComponent(key)}`,
        {
          method: 'POST',
          body: { enabled: false, reason: `[orb-voice ${id.user_id}] ${reason}` },
          auth: 'operator-headers',
          id,
        },
      );
      if (!ok || body.ok !== true) return { ok: false, error: failText('Disarming the control', status, body) };
      return { ok: true, result: body, text: `Control ${key} is now DISARMED. Reason recorded. A human must re-arm it from the Command Hub.` };
    },
  });
};

// ---------------------------------------------------------------------------
// Exports — handlers + Vertex/Gemini function declarations
// ---------------------------------------------------------------------------

export const DEVELOPER_ACTION_TOOL_HANDLERS: Record<string, Handler> = {
  dev_get_briefing,
  dev_list_pending_heals,
  dev_list_findings,
  dev_list_executions,
  dev_list_test_runs,
  dev_get_governance_controls,
  dev_run_test_suite,
  dev_generate_finding_plan,
  dev_snooze_finding,
  dev_allocate_vtid,
  dev_approve_heal,
  dev_reject_heal,
  dev_rollback_heal,
  dev_approve_finding_execute,
  dev_reject_finding,
  dev_cancel_execution,
  dev_publish_to_prod,
  dev_disarm_control,
};

const CONFIRM_PARAM = {
  confirm: { type: 'boolean', description: 'Set true ONLY after the user explicitly confirmed the read-back. First call MUST omit this.' },
};

export const DEVELOPER_ACTION_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_get_briefing',
    description: [
      'DEVELOPER ONLY. Fetch the current developer briefing: platform status, what changed since the',
      'last session, ranked immediate-attention items, and the recommended next step.',
      'Call when the developer asks "what\'s the status", "brief me", "what changed", "was ist der Stand",',
      'or mid-session to refresh ("what changed while we talked?"). Speak it per the briefing-first protocol.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Optional ISO timestamp for the since-last-session window.' },
      },
    },
  },
  {
    name: 'dev_list_pending_heals',
    description: [
      'DEVELOPER ONLY. List self-healing fixes waiting for human approval, with endpoint, failure class',
      'and diagnosis summary. Call when the developer asks "what heals are pending", "show the pending',
      'fixes", "welche Fixes warten". Then offer dev_approve_heal / dev_reject_heal.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max items, 1-20. Use 5.' } },
    },
  },
  {
    name: 'dev_list_findings',
    description: [
      'DEVELOPER ONLY. List dev-autopilot findings (self-improvement queue) ranked by impact.',
      'Call when the developer asks "what did the autopilot find", "show the findings", "improvement queue".',
      'Then offer plan/approve/reject/snooze per finding.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Finding status filter, default "new".' },
        limit: { type: 'integer', description: 'Max items, 1-20. Use 5.' },
      },
    },
  },
  {
    name: 'dev_list_executions',
    description: [
      'DEVELOPER ONLY. List dev-autopilot executions (status "active" = in flight; or "failed"/"completed"/"all").',
      'Call when the developer asks "what is the autopilot executing", "any failed executions".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', description: 'active (default), failed, completed, or all.' } },
    },
  },
  {
    name: 'dev_list_test_runs',
    description: [
      'DEVELOPER ONLY. List recent E2E test runs and available suites.',
      'Call when the developer asks "how are the tests", "did the E2E pass", "test status".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max runs, 1-20. Use 5.' } },
    },
  },
  {
    name: 'dev_get_governance_controls',
    description: [
      'DEVELOPER ONLY. Read the governance control plane: every kill-switch key with its armed/disarmed state.',
      'Call when the developer asks "are the kill switches armed", "governance status", "is execution armed".',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_run_test_suite',
    description: [
      'DEVELOPER ONLY. Start an E2E test run for one or more projects (e.g. hub-developer, desktop-community, all).',
      'TWO-STEP: first call WITHOUT confirm to get the read-back; call again with confirm=true after an explicit yes.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        projects: { type: 'array', items: { type: 'string' }, description: 'Project ids, e.g. ["hub-developer"] or ["all"].' },
        ...CONFIRM_PARAM,
      },
      required: ['projects'],
    },
  },
  {
    name: 'dev_generate_finding_plan',
    description: [
      'DEVELOPER ONLY. Ask the autopilot planner to generate an implementation plan for a finding.',
      'TWO-STEP confirm. finding_id comes from dev_list_findings.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'The finding id (UUID) from dev_list_findings.' },
        ...CONFIRM_PARAM,
      },
      required: ['finding_id'],
    },
  },
  {
    name: 'dev_snooze_finding',
    description: 'DEVELOPER ONLY. Snooze an autopilot finding for N hours (default 24). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'The finding id.' },
        hours: { type: 'integer', description: 'Snooze duration in hours, 1-720. Default 24.' },
        ...CONFIRM_PARAM,
      },
      required: ['finding_id'],
    },
  },
  {
    name: 'dev_allocate_vtid',
    description: [
      'DEVELOPER ONLY. Allocate the next VTID in the global ledger with a title.',
      'Call when the developer says "create a task for …", "allocate a VTID for …". TWO-STEP confirm.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title.' },
        ...CONFIRM_PARAM,
      },
      required: ['title'],
    },
  },
  {
    name: 'dev_approve_heal',
    description: [
      'DEVELOPER ONLY. APPROVE a pending self-healing fix — dispatches it into autonomous execution.',
      'TWO-STEP confirm: read back what the fix does first. id = the full UUID from dev_list_pending_heals.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Full UUID of the pending self_healing_log item.' },
        ...CONFIRM_PARAM,
      },
      required: ['id'],
    },
  },
  {
    name: 'dev_reject_heal',
    description: 'DEVELOPER ONLY. REJECT a pending self-healing fix with a required reason. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Full UUID of the pending item.' },
        reason: { type: 'string', description: 'Why it is rejected. Required.' },
        ...CONFIRM_PARAM,
      },
      required: ['id', 'reason'],
    },
  },
  {
    name: 'dev_rollback_heal',
    description: [
      'DEVELOPER ONLY. ROLL BACK an executed self-healing fix to its pre-fix snapshot.',
      'Call when the developer says "roll back that fix", "revert the healing on VTID X". TWO-STEP confirm.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'The healing VTID, e.g. "VTID-03412".' },
        ...CONFIRM_PARAM,
      },
      required: ['vtid'],
    },
  },
  {
    name: 'dev_approve_finding_execute',
    description: [
      'DEVELOPER ONLY. Approve an autopilot finding for AUTONOMOUS EXECUTION (code → branch → PR → CI → merge).',
      'One finding at a time — never batch by voice. TWO-STEP confirm with full read-back.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'The finding id.' },
        ...CONFIRM_PARAM,
      },
      required: ['finding_id'],
    },
  },
  {
    name: 'dev_reject_finding',
    description: 'DEVELOPER ONLY. Reject an autopilot finding so it is not proposed again. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        finding_id: { type: 'string', description: 'The finding id.' },
        ...CONFIRM_PARAM,
      },
      required: ['finding_id'],
    },
  },
  {
    name: 'dev_cancel_execution',
    description: 'DEVELOPER ONLY. Cancel an in-flight autopilot execution. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        execution_id: { type: 'string', description: 'Execution id from dev_list_executions.' },
        ...CONFIRM_PARAM,
      },
      required: ['execution_id'],
    },
  },
  {
    name: 'dev_publish_to_prod',
    description: [
      'DEVELOPER ONLY (and only for super-admins — the endpoint verifies the caller\'s own credentials).',
      'Promote the verified STAGING build to PRODUCTION — the same governed action as the Command Hub PUBLISH button.',
      'Before proposing this, confirm staging has been verified. TWO-STEP confirm with full read-back.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: '"full" (default) or "canary".' },
        ...CONFIRM_PARAM,
      },
    },
  },
  {
    name: 'dev_disarm_control',
    description: [
      'DEVELOPER ONLY. DISARM (never arm) a governance kill-switch control, with a required reason.',
      'Call when the developer says "stop the autopilot", "hit the kill switch", "disable assistant actions".',
      'The assistant can only disarm — re-arming is a human act in the Command Hub. TWO-STEP confirm.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Control key, e.g. autopilot_execution_enabled, vtid_allocator_enabled, assistant_actions_enabled.' },
        reason: { type: 'string', description: 'Why it is being disarmed. Required — recorded in the audit.' },
        ...CONFIRM_PARAM,
      },
      required: ['key', 'reason'],
    },
  },
];
