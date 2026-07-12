/**
 * Developer voice tools — VTID / OASIS Lifecycle (Wave 2, plan section C1).
 *
 * Thin dispatch layer over the existing routes/vtid.ts, routes/oasis-tasks.ts,
 * routes/vtid-terminalize.ts and routes/worker-orchestrator.ts endpoints — no
 * new backend behaviour is introduced here. Every handler re-checks the
 * caller's role server-side via developerGate(), same as developer-tools.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import {
  developerGate,
  normalizeVtidCandidates,
  clampLimit,
  relAge,
  gatewayApiCall,
} from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

async function resolveVtid(
  args: OrbToolArgs,
  sb: SupabaseClient,
): Promise<{ vtid: string; status: string | null; is_terminal: boolean } | { error: string }> {
  const candidates = normalizeVtidCandidates(args.vtid);
  if (candidates.length === 0) {
    return { error: 'A VTID is required, e.g. "VTID-01234" or "1234".' };
  }
  const { data, error } = await sb
    .from('vtid_ledger')
    .select('vtid, status, is_terminal')
    .in('vtid', candidates)
    .limit(1);
  if (error) return { error: error.message };
  const row = ((data ?? []) as Array<{ vtid: string; status: string | null; is_terminal: boolean | null }>)[0];
  if (!row) return { error: `VTID ${candidates[0]} not found in the ledger.` };
  return { vtid: row.vtid, status: row.status, is_terminal: Boolean(row.is_terminal) };
}

// ---------------------------------------------------------------------------
// 1. dev_allocate_vtid — POST /api/v1/vtid/allocate
// ---------------------------------------------------------------------------

export const dev_allocate_vtid: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const source = String(args.source ?? 'orb-voice');
  const layer = String(args.layer ?? 'DEV');
  const module = String(args.module ?? 'TASK');
  const title = typeof args.title === 'string' ? args.title : undefined;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, layer, module, title },
      text: `About to allocate a new ${layer}/${module} VTID${title ? ` for "${title}"` : ''}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/vtid/allocate', {
    method: 'POST',
    body: { source, layer, module, title },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { allocated: false, status, detail: body }, text: `Could not allocate a VTID: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { allocated: true, vtid: body.vtid }, text: `Allocated ${String(body.vtid)}.` };
};

// ---------------------------------------------------------------------------
// 2. dev_create_task — POST /api/v1/vtid/create
// ---------------------------------------------------------------------------

export const dev_create_task: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const title = String(args.title ?? '').trim();
  if (!title) return { ok: false, error: 'dev_create_task requires a title.' };
  const task_family = String(args.task_family ?? 'DEV');
  const task_module = String(args.task_module ?? 'TASK');
  const target_roles = Array.isArray(args.target_roles) && args.target_roles.length > 0
    ? args.target_roles
    : ['DEV'];
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, title, task_family, task_module, target_roles },
      text: `About to create a new OASIS task "${title}" (${task_family}/${task_module}). Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/vtid/create', {
    method: 'POST',
    body: { task_family, task_module, title, target_roles },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the task: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { created: true, task: body }, text: `Created ${String(body.vtid ?? '(unknown vtid)')} — "${title}".` };
};

// ---------------------------------------------------------------------------
// 3. dev_update_task — PATCH /api/v1/oasis/tasks/:id
// ---------------------------------------------------------------------------

export const dev_update_task: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = await resolveVtid(args, sb);
  if ('error' in target) return { ok: false, error: target.error };
  if (target.is_terminal) {
    return { ok: false, error: `${target.vtid} is terminal and may not be modified.` };
  }
  const patch: Record<string, unknown> = {};
  if (typeof args.title === 'string') patch.title = args.title;
  if (typeof args.status === 'string') patch.status = args.status;
  if (typeof args.summary === 'string') patch.summary = args.summary;
  if (typeof args.assigned_to === 'string') patch.assigned_to = args.assigned_to;
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'dev_update_task requires at least one field to change (title, status, summary, assigned_to).' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid: target.vtid, patch },
      text: `About to update ${target.vtid}: ${JSON.stringify(patch)}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/oasis/tasks/${encodeURIComponent(target.vtid)}`, {
    method: 'PATCH',
    body: patch,
  });
  if (!ok) {
    return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update ${target.vtid}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { updated: true, task: body }, text: `${target.vtid} updated.` };
};

// ---------------------------------------------------------------------------
// 4. dev_cancel_task — DELETE (pre-start) or complete(cancelled) (in-flight)
// ---------------------------------------------------------------------------

const PRE_START_STATUSES = new Set(['scheduled', 'allocated', 'pending']);

export const dev_cancel_task: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = await resolveVtid(args, sb);
  if ('error' in target) return { ok: false, error: target.error };
  if (target.is_terminal) {
    return { ok: true, result: { already_terminal: true }, text: `${target.vtid} is already terminal — nothing to cancel.` };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid: target.vtid, current_status: target.status },
      text: `About to cancel ${target.vtid} (currently ${target.status}). Confirm, then call again with confirm=true.`,
    };
  }
  const preStart = PRE_START_STATUSES.has(String(target.status ?? ''));
  const { ok, status, body } = preStart
    ? await gatewayApiCall(`/api/v1/oasis/tasks/${encodeURIComponent(target.vtid)}`, { method: 'DELETE' })
    : await gatewayApiCall(`/api/v1/oasis/tasks/${encodeURIComponent(target.vtid)}/complete`, {
        method: 'POST',
        body: { terminal_outcome: 'cancelled' },
      });
  if (!ok) {
    return { ok: true, result: { cancelled: false, status, detail: body }, text: `Could not cancel ${target.vtid}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { cancelled: true, vtid: target.vtid }, text: `${target.vtid} cancelled.` };
};

// ---------------------------------------------------------------------------
// 5. dev_complete_task — POST /api/v1/oasis/tasks/:vtid/complete
// ---------------------------------------------------------------------------

export const dev_complete_task: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = await resolveVtid(args, sb);
  if ('error' in target) return { ok: false, error: target.error };
  const outcome = String(args.terminal_outcome ?? 'success');
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid: target.vtid, terminal_outcome: outcome },
      text: `About to complete ${target.vtid} with outcome "${outcome}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/oasis/tasks/${encodeURIComponent(target.vtid)}/complete`, {
    method: 'POST',
    body: { terminal_outcome: outcome },
  });
  if (!ok) {
    return { ok: true, result: { completed: false, status, detail: body }, text: `Could not complete ${target.vtid}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  const retried = body.status === 'scheduled' && outcome === 'failed';
  return {
    ok: true,
    result: { completed: true, detail: body },
    text: retried
      ? `${target.vtid} failed and was reset for retry (attempt ${String(body.failure_count ?? '?')}).`
      : `${target.vtid} completed with outcome ${outcome}.`,
  };
};

// ---------------------------------------------------------------------------
// 6. dev_terminalize_vtid — POST /api/v1/oasis/vtid/terminalize
// ---------------------------------------------------------------------------

export const dev_terminalize_vtid: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = await resolveVtid(args, sb);
  if ('error' in target) return { ok: false, error: target.error };
  const outcome = String(args.outcome ?? '').trim();
  if (!['success', 'failed', 'cancelled'].includes(outcome)) {
    return { ok: false, error: 'dev_terminalize_vtid requires outcome to be one of success, failed, cancelled.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid: target.vtid, outcome },
      text: `About to terminalize ${target.vtid} with outcome "${outcome}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/oasis/vtid/terminalize', {
    method: 'POST',
    body: {
      vtid: target.vtid,
      outcome,
      run_id: typeof args.run_id === 'string' ? args.run_id : undefined,
      commit_sha: typeof args.commit_sha === 'string' ? args.commit_sha : undefined,
      actor: 'manual',
    },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { terminalized: false, status, detail: body }, text: `Could not terminalize ${target.vtid}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return {
    ok: true,
    result: { terminalized: true, already_terminal: Boolean(body.already_terminal) },
    text: body.already_terminal
      ? `${target.vtid} was already terminal.`
      : `${target.vtid} terminalized with outcome ${outcome}.`,
  };
};

// ---------------------------------------------------------------------------
// 7. dev_discover_tasks — GET /api/v1/oasis/tasks/discover
// ---------------------------------------------------------------------------

export const dev_discover_tasks: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 20, 200);
  const statuses = typeof args.statuses === 'string' ? args.statuses : undefined;
  const qs = new URLSearchParams({ limit: String(limit) });
  if (statuses) qs.set('statuses', statuses);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/oasis/tasks/discover?${qs.toString()}`);
  if (!ok || body.ok !== true) {
    return { ok: false, error: `dev_discover_tasks failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const pending = (Array.isArray(body.pending) ? body.pending : []) as Array<{ vtid: string; title?: string; status?: string }>;
  if (pending.length === 0) {
    return { ok: true, result: { pending: [] }, text: 'No eligible tasks discovered right now.' };
  }
  const lines = pending.slice(0, 8).map((t) => `${t.vtid} — ${t.title || '(untitled)'} (${t.status ?? 'unknown'})`);
  return { ok: true, result: { pending }, text: `${pending.length} eligible task${pending.length === 1 ? '' : 's'}: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 8. dev_get_vtid_projection — GET /api/v1/vtid/projection
// ---------------------------------------------------------------------------

export const dev_get_vtid_projection: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 20, 200);
  const offset = Math.max(0, Number(args.offset) || 0);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/vtid/projection?limit=${limit}&offset=${offset}`);
  if (!ok || body.ok !== true) {
    return { ok: false, error: `dev_get_vtid_projection failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const rows = (Array.isArray(body.data) ? body.data : []) as Array<{
    vtid: string; title?: string; current_stage?: string; status?: string; attention_required?: boolean;
  }>;
  if (rows.length === 0) return { ok: true, result: { data: [] }, text: 'No VTIDs in the projection.' };
  const attention = rows.filter((r) => r.attention_required);
  const lines = rows.slice(0, 8).map((r) => `${r.vtid} — ${r.title || '(untitled)'} (${r.current_stage ?? r.status ?? 'unknown'})`);
  return {
    ok: true,
    result: { data: rows },
    text: `${rows.length} VTIDs${attention.length ? `, ${attention.length} need attention` : ''}: ${lines.join('. ')}`,
  };
};

// ---------------------------------------------------------------------------
// 9. dev_get_allocator_status — GET /api/v1/vtid/allocator/status
// ---------------------------------------------------------------------------

export const dev_get_allocator_status: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/vtid/allocator/status');
  if (!ok || body.ok !== true) {
    return { ok: false, error: `dev_get_allocator_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return {
    ok: true,
    result: body,
    text: `VTID allocator is ${body.enabled ? 'enabled' : 'disabled'}.${body.message ? ` ${String(body.message)}` : ''}`,
  };
};

// ---------------------------------------------------------------------------
// 10. dev_query_oasis_events — GET /api/v1/oasis/events
// ---------------------------------------------------------------------------

export const dev_query_oasis_events: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 10, 200);
  const qs = new URLSearchParams({ limit: String(limit) });
  const vtid = normalizeVtidCandidates(args.vtid)[0];
  if (vtid) qs.set('vtid', vtid);
  // The events route has no "type" column filter — "topic" is the closest
  // proxy (ilike substring), matching the actual oasis_events schema.
  const topic = String(args.type ?? args.topic ?? '').trim();
  if (topic) qs.set('topic', topic);
  if (typeof args.source === 'string' && args.source) qs.set('source', args.source);
  if (typeof args.status === 'string' && args.status) qs.set('status', args.status);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/oasis/events?${qs.toString()}`);
  if (!ok) return { ok: false, error: `dev_query_oasis_events failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray(body.data) ? body.data : []) as Array<{ type?: string; topic?: string; message?: string; created_at?: string }>;
  if (rows.length === 0) return { ok: true, result: { data: [] }, text: 'No matching OASIS events found.' };
  const lines = rows.slice(0, 8).map((r) => `${r.type || r.topic || 'event'} — ${r.message || ''} (${relAge(r.created_at)})`);
  return { ok: true, result: { data: rows }, text: `${rows.length} events: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 11. dev_execute_vtid — POST /api/v1/worker/orchestrator/route
// ---------------------------------------------------------------------------

export const dev_execute_vtid: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = await resolveVtid(args, sb);
  if ('error' in target) return { ok: false, error: target.error };
  const title = String(args.title ?? '').trim();
  if (!title) return { ok: false, error: 'dev_execute_vtid requires a title describing the work order.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid: target.vtid, title },
      text: `About to route ${target.vtid} ("${title}") to the worker orchestrator for execution. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/orchestrator/route', {
    method: 'POST',
    body: {
      vtid: target.vtid,
      title,
      task_family: typeof args.task_family === 'string' ? args.task_family : 'DEV',
      task_domain: typeof args.task_domain === 'string' ? args.task_domain : undefined,
    },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { routed: false, status, detail: body }, text: `Execution was not started for ${target.vtid}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { routed: true, detail: body }, text: `${target.vtid} routed to execution.` };
};

// ---------------------------------------------------------------------------
// 12. dev_run_exec_workflow — POST /api/v1/execute/workflow
// ---------------------------------------------------------------------------

export const dev_run_exec_workflow: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = await resolveVtid(args, sb);
  if ('error' in target) return { ok: false, error: target.error };
  const action = String(args.action ?? '').trim();
  if (!action.includes('.')) {
    return { ok: false, error: 'dev_run_exec_workflow requires an action like "domain.step".' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid: target.vtid, action },
      text: `About to validate workflow action "${action}" for ${target.vtid}. Note: this endpoint validates and logs only — it does not execute real work yet. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/execute/workflow', {
    method: 'POST',
    body: { vtid: target.vtid, action, params: (args.params as Record<string, unknown>) ?? {} },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { validated: false, status, detail: body }, text: `Workflow validation failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return {
    ok: true,
    result: { validated: true, detail: body },
    text: `Validated "${action}" for ${target.vtid} — this endpoint is validation-only today and does not execute real work.`,
  };
};

// ---------------------------------------------------------------------------
// 13. dev_submit_evidence — POST /api/v1/worker/subagent/complete
// ---------------------------------------------------------------------------

export const dev_submit_evidence: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = await resolveVtid(args, sb);
  if ('error' in target) return { ok: false, error: target.error };
  const domain = String(args.domain ?? '').trim();
  if (!['frontend', 'backend', 'memory', 'infra', 'ai', 'mixed'].includes(domain)) {
    return { ok: false, error: 'dev_submit_evidence requires domain: frontend, backend, memory, infra, ai, or mixed.' };
  }
  const runId = String(args.run_id ?? '').trim();
  if (!runId) return { ok: false, error: 'dev_submit_evidence requires a run_id.' };
  const { ok, status, body } = await gatewayApiCall('/api/v1/worker/subagent/complete', {
    method: 'POST',
    body: {
      vtid: target.vtid,
      domain,
      run_id: runId,
      result: { ok: args.result_ok !== false, files_changed: typeof args.files_changed === 'number' ? args.files_changed : undefined },
    },
  });
  if (!ok) return { ok: true, result: { submitted: false, status, detail: body }, text: `Could not submit evidence for ${target.vtid}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { submitted: true, detail: body }, text: `Evidence submitted for ${target.vtid}.` };
};

// ---------------------------------------------------------------------------
// 14/15. dev_list_work_orders / dev_get_work_order
// "Work orders" have no dedicated table — the closest live concept is task
// discovery (list) and the task ledger row itself (get), per plan gap notes.
// ---------------------------------------------------------------------------

export const dev_list_work_orders: Handler = async (args, id) => {
  const result = await dev_discover_tasks(args, id, undefined as unknown as SupabaseClient);
  if (!result.ok) return result;
  return { ...result, text: `(Work orders map to task discovery today.) ${result.text ?? ''}` };
};

export const dev_get_work_order: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = await resolveVtid(args, sb);
  if ('error' in target) return { ok: false, error: target.error };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/oasis/tasks/${encodeURIComponent(target.vtid)}`);
  if (!ok) return { ok: false, error: `dev_get_work_order failed (${status}): ${String(body.error ?? 'unknown')}` };
  return {
    ok: true,
    result: body,
    text: `${target.vtid} — ${String(body.title ?? '(untitled)')}, status ${String(body.status ?? 'unknown')}${body.is_terminal ? `, terminal (${String(body.terminal_outcome ?? 'unknown')})` : ''}.`,
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const VTID_LIFECYCLE_TOOL_HANDLERS: Record<string, Handler> = {
  dev_allocate_vtid,
  dev_create_task,
  dev_update_task,
  dev_cancel_task,
  dev_complete_task,
  dev_terminalize_vtid,
  dev_discover_tasks,
  dev_get_vtid_projection,
  dev_get_allocator_status,
  dev_query_oasis_events,
  dev_execute_vtid,
  dev_run_exec_workflow,
  dev_submit_evidence,
  dev_list_work_orders,
  dev_get_work_order,
};

export const VTID_LIFECYCLE_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_allocate_vtid',
    description: 'DEVELOPER ONLY. Allocate a new VTID. TWO-STEP: call without confirm first, then again with confirm=true after the developer agrees.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Origin tag, e.g. "orb-voice".' },
        layer: { type: 'string', description: 'Layer, e.g. DEV, ADM. Default DEV.' },
        module: { type: 'string', description: 'Module tag. Default TASK.' },
        title: { type: 'string', description: 'Optional title for the new VTID.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
    },
  },
  {
    name: 'dev_create_task',
    description: 'DEVELOPER ONLY. Create a new OASIS task/VTID with a title. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title. Required.' },
        task_family: { type: 'string', description: 'Task family, e.g. DEV, ADM, GOVRN. Default DEV.' },
        task_module: { type: 'string', description: 'Task module tag. Default TASK.' },
        target_roles: { type: 'array', items: { type: 'string' }, description: 'Target roles, e.g. ["DEV"].' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'dev_update_task',
    description: 'DEVELOPER ONLY. Patch a VTID task\'s title/status/summary/assigned_to. Refuses terminal tasks. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference, e.g. "VTID-01234" or "1234".' },
        title: { type: 'string' },
        status: { type: 'string', description: 'scheduled, in_progress, completed, pending, blocked, cancelled.' },
        summary: { type: 'string' },
        assigned_to: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid'],
    },
  },
  {
    name: 'dev_cancel_task',
    description: 'DEVELOPER ONLY. Cancel a VTID task (deletes it if not yet started, else marks it cancelled). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid'],
    },
  },
  {
    name: 'dev_complete_task',
    description: 'DEVELOPER ONLY. Mark a VTID task complete with an outcome. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference.' },
        terminal_outcome: { type: 'string', description: 'success, failed, or cancelled. Default success.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid'],
    },
  },
  {
    name: 'dev_terminalize_vtid',
    description: 'DEVELOPER ONLY. Set is_terminal + terminal_outcome on a VTID directly (idempotent). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference.' },
        outcome: { type: 'string', description: 'success, failed, or cancelled. Required.' },
        run_id: { type: 'string' },
        commit_sha: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid', 'outcome'],
    },
  },
  {
    name: 'dev_discover_tasks',
    description: 'DEVELOPER ONLY. List VTIDs eligible for worker pickup (scheduled/allocated/in_progress).',
    parameters: {
      type: 'object',
      properties: {
        statuses: { type: 'string', description: 'Comma-separated statuses to filter, e.g. "scheduled,in_progress".' },
        limit: { type: 'integer', description: 'Max rows, 1-200. Default 20.' },
      },
    },
  },
  {
    name: 'dev_get_vtid_projection',
    description: 'DEVELOPER ONLY. VTID projection view: stage, status, attention flags for every non-deleted VTID.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max rows, 1-200. Default 20.' },
        offset: { type: 'integer', description: 'Pagination offset.' },
      },
    },
  },
  {
    name: 'dev_get_allocator_status',
    description: 'DEVELOPER ONLY. Whether the VTID allocator kill-switch is on or off, and why.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_query_oasis_events',
    description: 'DEVELOPER ONLY. Query OASIS events by vtid/topic/source/status.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string' },
        type: { type: 'string', description: 'Matched against the event topic (substring).' },
        source: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'integer', description: '1-200. Default 10.' },
      },
    },
  },
  {
    name: 'dev_execute_vtid',
    description: 'DEVELOPER ONLY. Route a VTID to the worker orchestrator for execution. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference.' },
        title: { type: 'string', description: 'Work order title. Required.' },
        task_family: { type: 'string' },
        task_domain: { type: 'string', description: 'frontend, backend, memory, infra, ai, or mixed.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid', 'title'],
    },
  },
  {
    name: 'dev_run_exec_workflow',
    description: 'DEVELOPER ONLY. Validate/log a workflow action for a VTID. NOTE: this backend endpoint is validation-only today, it does not execute real work. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference.' },
        action: { type: 'string', description: 'Dotted action name, e.g. "deploy.trigger". Required.' },
        params: { type: 'object', description: 'Arbitrary params for the action.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid', 'action'],
    },
  },
  {
    name: 'dev_submit_evidence',
    description: 'DEVELOPER ONLY. Submit subagent completion evidence for a VTID (files changed, outcome).',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference.' },
        domain: { type: 'string', description: 'frontend, backend, memory, infra, ai, or mixed. Required.' },
        run_id: { type: 'string', description: 'Required.' },
        result_ok: { type: 'boolean', description: 'Whether the work succeeded. Default true.' },
        files_changed: { type: 'integer' },
      },
      required: ['vtid', 'domain', 'run_id'],
    },
  },
  {
    name: 'dev_list_work_orders',
    description: 'DEVELOPER ONLY. List pending work orders (maps to task discovery — there is no separate work-order table).',
    parameters: {
      type: 'object',
      properties: {
        statuses: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'dev_get_work_order',
    description: 'DEVELOPER ONLY. Get one task/work-order by VTID.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference. Required.' },
      },
      required: ['vtid'],
    },
  },
];
