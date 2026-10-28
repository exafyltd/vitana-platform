/**
 * Developer voice tools — Worker Orchestrator (C5), Wave 5 of
 * docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/worker-orchestrator.ts (mounted at '/' —
 * no path prefix, no HTTP-level auth middleware). `developerGate()` is
 * therefore the ONLY real access control for these tools; treat it as
 * mandatory on every handler.
 *
 * dev_get_task_progress is SKIPPED — the only progress-related route,
 * POST /api/v1/worker/orchestrator/tasks/:vtid/progress, is write-only (it
 * reports/emits a progress event and extends the claim); there is no GET
 * that returns current progress state, so building a "read progress" tool
 * against it would misrepresent a write as a read. Stays `status: planned`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit, developerGate } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// 1. dev_list_workers — GET /api/v1/worker/orchestrator/workers
// ---------------------------------------------------------------------------

export const dev_list_workers: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/orchestrator/workers');
  if (!ok) return { ok: false, error: `dev_list_workers failed (${status}): ${String(body.error ?? 'unknown')}` };
  const workers = (Array.isArray(body.workers) ? body.workers : []) as Array<Record<string, unknown>>;
  if (workers.length === 0) return { ok: true, result: { workers: [] }, text: 'No active workers registered.' };
  return { ok: true, result: { workers }, text: `${workers.length} active workers.` };
};

// ---------------------------------------------------------------------------
// 2. dev_orchestrator_stats — GET /api/v1/worker/orchestrator/stats
// ---------------------------------------------------------------------------

export const dev_orchestrator_stats: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/orchestrator/stats');
  if (!ok) return { ok: false, error: `dev_orchestrator_stats failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body.stats ?? body, text: 'Orchestrator stats retrieved.' };
};

// ---------------------------------------------------------------------------
// 3. dev_list_pending_worker_tasks — GET /api/v1/worker/orchestrator/tasks/pending
// ---------------------------------------------------------------------------

export const dev_list_pending_worker_tasks: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 100, 200);
  const qs = new URLSearchParams({ limit: String(limit) });
  if (typeof args.worker_id === 'string' && args.worker_id) qs.set('worker_id', args.worker_id);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/worker/orchestrator/tasks/pending?${qs.toString()}`);
  if (!ok) return { ok: false, error: `dev_list_pending_worker_tasks failed (${status}): ${String(body.error ?? 'unknown')}` };
  const tasks = (Array.isArray(body.tasks) ? body.tasks : []) as Array<Record<string, unknown>>;
  if (tasks.length === 0) return { ok: true, result: { tasks: [] }, text: 'No pending worker tasks.' };
  return { ok: true, result: { tasks }, text: `${tasks.length} pending worker tasks.` };
};

// ---------------------------------------------------------------------------
// 4. dev_release_claim — POST /api/v1/worker/orchestrator/tasks/:vtid/release
// ---------------------------------------------------------------------------

export const dev_release_claim: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const vtid = String(args.vtid ?? '').trim();
  const workerId = String(args.worker_id ?? '').trim();
  if (!vtid || !workerId) return { ok: false, error: 'dev_release_claim requires vtid and worker_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid, worker_id: workerId },
      text: `About to release the claim on ${vtid} held by ${workerId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/worker/orchestrator/tasks/${encodeURIComponent(vtid)}/release`, {
    method: 'POST',
    body: { worker_id: workerId, reason: typeof args.reason === 'string' ? args.reason : undefined },
  });
  if (!ok) return { ok: true, result: { released: false, status, detail: body }, text: `Could not release the claim: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { released: true, detail: body }, text: `Claim on ${vtid} released.` };
};

// ---------------------------------------------------------------------------
// 5. dev_list_subagents — GET /api/v1/worker/subagents (legacy registry)
// ---------------------------------------------------------------------------

export const dev_list_subagents: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/subagents');
  if (!ok) return { ok: false, error: `dev_list_subagents failed (${status}): ${String(body.error ?? 'unknown')}` };
  const subagents = (Array.isArray(body.subagents) ? body.subagents : []) as Array<Record<string, unknown>>;
  if (subagents.length === 0) return { ok: true, result: { subagents: [] }, text: 'No subagents registered.' };
  return { ok: true, result: { subagents }, text: `${subagents.length} subagents.` };
};

// ---------------------------------------------------------------------------
// 6. dev_list_worker_skills — GET /api/v1/worker/skills
// ---------------------------------------------------------------------------

export const dev_list_worker_skills: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/skills');
  if (!ok) return { ok: false, error: `dev_list_worker_skills failed (${status}): ${String(body.error ?? 'unknown')}` };
  const skills = (Array.isArray(body.skills) ? body.skills : []) as unknown[];
  return { ok: true, result: body, text: `${skills.length} worker skills registered.` };
};

// ---------------------------------------------------------------------------
// 7. dev_cleanup_stale_claims — POST /api/v1/worker/orchestrator/cleanup
// ---------------------------------------------------------------------------

export const dev_cleanup_stale_claims: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true },
      text: `About to expire all stale worker claims platform-wide. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/orchestrator/cleanup', { method: 'POST' });
  if (!ok) return { ok: true, result: { cleaned: false, status, detail: body }, text: `Cleanup failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { cleaned: true, expired_count: body.expired_count }, text: `${Number(body.expired_count ?? 0)} stale claims expired.` };
};

// ---------------------------------------------------------------------------
// 8. dev_orchestrator_health — GET /api/v1/worker/orchestrator/health
// ---------------------------------------------------------------------------

export const dev_orchestrator_health: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/orchestrator/health');
  if (!ok) return { ok: false, error: `dev_orchestrator_health failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Orchestrator service: ${String(body.service ?? 'worker-orchestrator')}, ${Object.keys((body.subagents as object) ?? {}).length} subagent lanes.` };
};

// ---------------------------------------------------------------------------
// 9. dev_route_to_subagent — POST /api/v1/worker/orchestrator/route
// ---------------------------------------------------------------------------

const TASK_DOMAINS = ['frontend', 'backend', 'memory', 'infra', 'ai', 'mixed'];

export const dev_route_to_subagent: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const vtid = String(args.vtid ?? '').trim();
  const title = String(args.title ?? '').trim();
  if (!/^VTID-\d{4,}$/.test(vtid) || !title) {
    return { ok: false, error: 'dev_route_to_subagent requires vtid (VTID-NNNN...) and title.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid, title },
      text: `About to route ${vtid} ("${title}") to a subagent for execution. Confirm, then call again with confirm=true.`,
    };
  }
  const taskDomain = typeof args.task_domain === 'string' && TASK_DOMAINS.includes(args.task_domain) ? args.task_domain : undefined;
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/orchestrator/route', {
    method: 'POST',
    body: {
      vtid,
      title,
      task_family: typeof args.task_family === 'string' ? args.task_family : undefined,
      task_domain: taskDomain,
      target_paths: Array.isArray(args.target_paths) ? args.target_paths : undefined,
      spec_content: typeof args.spec_content === 'string' ? args.spec_content : undefined,
    },
  });
  if (!ok) {
    const err = String(body.error ?? '');
    if (err.includes('EXECUTION_DISARMED')) {
      return { ok: true, result: { routed: false, reason: 'execution_disarmed' }, text: `Execution is currently disarmed platform-wide — nothing can be routed to a subagent right now.` };
    }
    if (err.includes('GOVERNANCE_BLOCKED')) {
      return { ok: true, result: { routed: false, reason: 'governance_blocked', detail: body }, text: `Governance blocked this route: ${err}.` };
    }
    return { ok: true, result: { routed: false, status, detail: body }, text: `Could not route to a subagent: ${err || `gateway returned ${status}`}.` };
  }
  return { ok: true, result: { routed: true, detail: body }, text: `${vtid} routed to a subagent.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const WORKER_ORCHESTRATOR_TOOL_HANDLERS: Record<string, Handler> = {
  dev_list_workers,
  dev_orchestrator_stats,
  dev_list_pending_worker_tasks,
  dev_release_claim,
  dev_list_subagents,
  dev_list_worker_skills,
  dev_cleanup_stale_claims,
  dev_orchestrator_health,
  dev_route_to_subagent,
};

export const WORKER_ORCHESTRATOR_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'dev_list_workers', description: 'DEVELOPER ONLY. List registered orchestrator workers.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_orchestrator_stats', description: 'DEVELOPER ONLY. Worker connector stats.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_list_pending_worker_tasks', description: 'DEVELOPER ONLY. Pending worker task queue.', parameters: { type: 'object', properties: { worker_id: { type: 'string' }, limit: { type: 'number' } } } },
  {
    name: 'dev_release_claim',
    description: 'DEVELOPER ONLY. Release a stuck VTID claim. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { vtid: { type: 'string', description: 'Required.' }, worker_id: { type: 'string', description: 'Required.' }, reason: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['vtid', 'worker_id'] },
  },
  { name: 'dev_list_subagents', description: 'DEVELOPER ONLY. List legacy subagent registry entries.', parameters: { type: 'object', properties: {} } },
  { name: 'dev_list_worker_skills', description: 'DEVELOPER ONLY. Worker skills + preflight chains.', parameters: { type: 'object', properties: {} } },
  {
    name: 'dev_cleanup_stale_claims',
    description: 'DEVELOPER ONLY. Expire all stale worker claims platform-wide. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { confirm: { type: 'boolean' } } },
  },
  { name: 'dev_orchestrator_health', description: 'DEVELOPER ONLY. Orchestrator service health + subagent lanes.', parameters: { type: 'object', properties: {} } },
  {
    name: 'dev_route_to_subagent',
    description: 'DEVELOPER ONLY. Route a VTID work order to a subagent for execution. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID-NNNN format. Required.' },
        title: { type: 'string', description: 'Required.' },
        task_family: { type: 'string' },
        task_domain: { type: 'string', description: 'frontend, backend, memory, infra, ai, or mixed.' },
        target_paths: { type: 'array', items: { type: 'string' } },
        spec_content: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['vtid', 'title'],
    },
  },
];
