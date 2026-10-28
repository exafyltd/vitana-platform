/**
 * VTID-04034 (W4j): cancel a queued or running Dev Autopilot execution from
 * the Operator Console.
 *
 *   autopilot_cancel_execution(execution_id?, reason?)
 *     no id   → the executions that CAN be cancelled right now (cooling /
 *               running, newest first) so the model can ask which one;
 *     an id   → VTID-04032's cancelExecution: a cooling row is cancelled at
 *               once; a running row is marked cancelled, its ECS task stopped
 *               best effort and the agent stops at its next turn boundary.
 *
 * Same posture as VTID-04030's approval tools: the VTID-03851 caller gate
 * runs before any Supabase read, the actor written on the row and the
 * `dev_autopilot.execution.cancelled` event is `operator-chat:<verified
 * user_id>` (never a model argument), a prefix resolves only among
 * cancellable rows and must be unique, and every refusal from the cancel
 * function is passed through verbatim — never reported as success.
 */

import { authorizeApprovalTool, EXECUTION_ID_MIN_PREFIX } from './operator-approval-tools';
import { supa, getSupabase, cancelExecution, CANCELLABLE_STATUSES, type SupaConfig } from './dev-autopilot-execute';

const LOG_PREFIX = '[VTID-04034]';

/** Bound on the "what can be cancelled" listing. */
export const CANCEL_LIST_MAX = 20;

export interface CancelToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Test seams; production callers pass nothing. */
export interface CancelToolDeps {
  s?: SupaConfig | null;
  cancel?: (execId: string, opts: { actor: string; reason?: string }) => Promise<{ ok: boolean; error?: string; was?: string; ecs_task_stopped?: boolean; ecs_task_error?: string }>;
}

interface CancellableRow {
  id: string;
  status: string;
  branch?: string | null;
  finding_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  self_healing_vtid?: string | null;
  metadata?: Record<string, unknown> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f-]+$/i;

/** Every execution that can be cancelled right now, newest first (bounded). */
export async function listCancellable(s: SupaConfig): Promise<{ ok: boolean; rows?: CancellableRow[]; error?: string }> {
  const r = await supa<CancellableRow[]>(
    s,
    `/rest/v1/dev_autopilot_executions?status=in.(${CANCELLABLE_STATUSES.join(',')})&select=id,status,branch,finding_id,created_at,updated_at,self_healing_vtid,metadata&order=updated_at.desc&limit=${CANCEL_LIST_MAX}`,
  );
  if (!r.ok) return { ok: false, error: r.error || `list failed (${r.status})` };
  return { ok: true, rows: Array.isArray(r.data) ? r.data : [] };
}

/**
 * Resolve a full UUID as-is; resolve a prefix only among the rows that can
 * be cancelled, and only when exactly one matches.
 */
export async function resolveCancellableExecutionId(s: SupaConfig, raw: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const wanted = (raw || '').trim().toLowerCase();
  if (UUID_RE.test(wanted)) return { ok: true, id: wanted };
  if (!PREFIX_RE.test(wanted) || wanted.replace(/-/g, '').length < EXECUTION_ID_MIN_PREFIX) {
    return { ok: false, error: `execution_id "${raw}" is not a UUID and is too short to resolve as a prefix (at least ${EXECUTION_ID_MIN_PREFIX} hex characters).` };
  }
  const listed = await listCancellable(s);
  if (!listed.ok) return { ok: false, error: listed.error || 'could not list cancellable executions' };
  const hits = (listed.rows || []).filter(r => r.id.toLowerCase().startsWith(wanted));
  if (hits.length === 1) return { ok: true, id: hits[0].id };
  if (hits.length === 0) return { ok: false, error: `no cooling/running execution starts with "${raw}" — call autopilot_cancel_execution with no id to list what can be cancelled.` };
  return { ok: false, error: `"${raw}" is ambiguous — it matches ${hits.length} cancellable executions (${hits.map(h => h.id.slice(0, 12)).join(', ')}); give a longer prefix.` };
}

function summarizeCancellable(row: CancellableRow) {
  const md = row.metadata || {};
  return {
    execution_id: row.id,
    execution_short: row.id.slice(0, 8),
    status: row.status,
    vtid: row.self_healing_vtid ?? null,
    executor: typeof md.executor === 'string' ? md.executor : null,
    claimed_env: typeof md.claimed_env === 'string' ? md.claimed_env : null,
    branch: row.branch ?? null,
    started_at: row.created_at ?? null,
    last_update_at: row.updated_at ?? null,
    ecs_task: typeof md.ecs_task_arn === 'string' ? String(md.ecs_task_arn).split('/').pop() : null,
  };
}

/**
 * autopilot_cancel_execution — with no id, the cancellable list (read-only);
 * with an id, the cancel itself through VTID-04032's cancelExecution.
 */
export async function executeCancelExecution(
  args: { execution_id?: string; reason?: string },
  threadId: string,
  deps: CancelToolDeps = {},
): Promise<CancelToolResult> {
  const authz = authorizeApprovalTool('autopilot_cancel_execution', threadId);
  if (!authz.ok) {
    console.warn(`${LOG_PREFIX} cancel REFUSED thread=${threadId}`);
    return { ok: false, error: authz.error };
  }
  const s = deps.s === undefined ? getSupabase() : deps.s;
  if (!s) return { ok: false, error: 'Supabase not configured — cannot cancel.' };

  const rawId = typeof args?.execution_id === 'string' ? args.execution_id.trim() : '';
  if (!rawId) {
    const listed = await listCancellable(s);
    if (!listed.ok) return { ok: false, error: listed.error };
    const rows = listed.rows || [];
    return {
      ok: true,
      data: {
        cancellable: rows.map(summarizeCancellable),
        count: rows.length,
        message: rows.length === 0
          ? 'Nothing is cooling or running right now — there is no execution to cancel.'
          : `${rows.length} execution(s) can be cancelled — name one (id or 8+ character prefix) to cancel it; nothing was cancelled.`,
      },
    };
  }

  const resolved = await resolveCancellableExecutionId(s, rawId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 500) : undefined;

  const r = await (deps.cancel ?? ((id, o) => cancelExecution(id, o)))(resolved.id, { actor: authz.actor, reason });
  if (!r.ok) {
    console.warn(`${LOG_PREFIX} cancel ${resolved.id.slice(0, 8)} failed: ${r.error}`);
    return { ok: false, error: `cancel failed: ${r.error}` };
  }
  console.log(`${LOG_PREFIX} cancel ${resolved.id.slice(0, 8)} by ${authz.actor} (was=${r.was}, ecs_task_stopped=${r.ecs_task_stopped === true})`);
  const running = r.was === 'running';
  const taskNote = !running ? ''
    : r.ecs_task_stopped === true ? ' Its ECS task was stopped.'
    : r.ecs_task_error ? ` Stopping its ECS task was refused (${r.ecs_task_error}); the agent stops itself at its next turn boundary.`
    : ' The agent stops itself at its next turn boundary.';
  return {
    ok: true,
    data: {
      execution_id: resolved.id,
      execution_short: resolved.id.slice(0, 8),
      status: 'cancelled',
      was: r.was ?? null,
      ecs_task_stopped: r.ecs_task_stopped ?? null,
      ecs_task_error: r.ecs_task_error ?? null,
      reason: reason ?? null,
      cancelled_by: authz.actor,
      message: `Cancelled — execution ${resolved.id.slice(0, 8)} (was ${r.was}).${taskNote} Nothing will be pushed or opened for it.`,
    },
  };
}
