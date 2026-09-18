/**
 * VTID-04030 (operator agent W4f, gap analysis §4.6): the Operator Console
 * can REVIEW, APPROVE or REJECT a Dev Autopilot execution that the agent
 * held before opening its pull request (VTID-04029, status
 * `awaiting_approval`) — from chat, not only from the Command Hub buttons.
 *
 *   autopilot_review_execution(execution_id?)   read-only: the pushed branch,
 *                                               the PR title/body it would
 *                                               open, files, --stat, a bounded
 *                                               diff; no id → list what waits
 *   autopilot_approve_execution(execution_id)   opens the PR (VTID-04029
 *                                               approveExecution) → 'ci'
 *   autopilot_reject_execution(execution_id, reason?)  deletes the branch,
 *                                               cancels (rejectExecution)
 *
 * Every handler runs the SAME caller check as autopilot_execute_task
 * (VTID-03851): the thread must carry the marker of a verified exafy_admin
 * request — an anonymous or non-admin chat turn is refused before Supabase
 * is touched, and the actor recorded on the row/OASIS event is derived from
 * that verified identity (`operator-chat:<user_id>`), never from the model.
 *
 * The execution id may be the full UUID or the 8+ character prefix the
 * Command Hub and earlier tool results show; a prefix is resolved ONLY
 * among rows currently awaiting approval and must match exactly one.
 *
 * Nothing here starts work, and nothing here adds an OASIS topic: approve
 * and reject emit the VTID-04029 events through the functions they call.
 */

import { getThreadAuth, isExecuteTaskAuthorized, describeExecuteTaskRefusal } from './operator-execute-authz';
import { supa, getSupabase, type SupaConfig } from './dev-autopilot-execute';
import { getPendingApproval, approveExecution, rejectExecution, type PendingApproval } from './dev-autopilot-approval';

const LOG_PREFIX = '[VTID-04030]';

/** Bound on the unified diff handed to the model (chars); the head is kept. */
export const REVIEW_PATCH_MAX_CHARS = 12_000;
/** Bound on the PR body handed to the model (chars). */
export const REVIEW_BODY_MAX_CHARS = 2_000;
/** Bound on the file list handed to the model. */
export const REVIEW_FILES_MAX = 60;
/** Bound on the "what is waiting" listing. */
export const REVIEW_LIST_MAX = 20;
/** A prefix shorter than this is refused as too ambiguous to resolve. */
export const EXECUTION_ID_MIN_PREFIX = 6;

export interface ApprovalToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Test seams; production callers pass nothing. */
export interface ApprovalToolDeps {
  s?: SupaConfig | null;
  getPending?: typeof getPendingApproval;
  approve?: (execId: string, actor: string) => Promise<{ ok: boolean; pr_url?: string; pr_number?: number; error?: string }>;
  reject?: (execId: string, actor: string, reason: string | undefined) => Promise<{ ok: boolean; branch_deleted?: boolean; error?: string }>;
}

interface WaitingRow {
  id: string;
  status: string;
  branch?: string | null;
  finding_id?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f-]+$/i;

type Authz = { ok: true; actor: string } | { ok: false; error: string };

/**
 * The VTID-03851 gate, reworded for the tool at hand. The refusal text is
 * operator-facing (never spoken, never translated).
 */
export function authorizeApprovalTool(toolName: string, threadId: string): Authz {
  const auth = getThreadAuth(threadId);
  const z = isExecuteTaskAuthorized(auth);
  if (!z.ok) {
    return {
      ok: false,
      error: describeExecuteTaskRefusal(z.reason)
        .replace('autopilot_execute_task', toolName)
        .replace('no execution was queued', 'nothing was changed'),
    };
  }
  return { ok: true, actor: `operator-chat:${auth!.user_id}` };
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function pendingOf(row: WaitingRow): PendingApproval | null {
  const p = row.metadata && typeof row.metadata.pending_approval === 'object' ? (row.metadata.pending_approval as PendingApproval) : null;
  return p && typeof p.branch === 'string' ? p : null;
}

/** Every execution currently held, newest first (bounded). */
export async function listAwaitingApproval(s: SupaConfig): Promise<{ ok: boolean; rows?: WaitingRow[]; error?: string }> {
  const r = await supa<WaitingRow[]>(
    s,
    `/rest/v1/dev_autopilot_executions?status=eq.awaiting_approval&select=id,status,branch,finding_id,updated_at,metadata&order=updated_at.desc&limit=${REVIEW_LIST_MAX}`,
  );
  if (!r.ok) return { ok: false, error: r.error || `list failed (${r.status})` };
  return { ok: true, rows: Array.isArray(r.data) ? r.data : [] };
}

/** finding_id → activated VTID, one batched read; fails open to an empty map. */
async function vtidsForFindings(s: SupaConfig, findingIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(findingIds.filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    const r = await supa<Array<{ id: string; activated_vtid: string | null }>>(
      s,
      `/rest/v1/autopilot_recommendations?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,activated_vtid`,
    );
    if (r.ok && Array.isArray(r.data)) {
      for (const f of r.data) if (f.activated_vtid) out.set(f.id, String(f.activated_vtid));
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} vtid lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/**
 * Resolve a full UUID as-is; resolve a prefix only among the rows currently
 * awaiting approval, and only when exactly one matches.
 */
export async function resolveExecutionId(s: SupaConfig, raw: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const wanted = (raw || '').trim().toLowerCase();
  if (!wanted) return { ok: false, error: 'execution_id is required (the full UUID or its 8+ character prefix).' };
  if (UUID_RE.test(wanted)) return { ok: true, id: wanted };
  if (!PREFIX_RE.test(wanted) || wanted.replace(/-/g, '').length < EXECUTION_ID_MIN_PREFIX) {
    return { ok: false, error: `execution_id "${raw}" is not a UUID and is too short to resolve as a prefix (at least ${EXECUTION_ID_MIN_PREFIX} hex characters).` };
  }
  const listed = await listAwaitingApproval(s);
  if (!listed.ok) return { ok: false, error: listed.error || 'could not list executions awaiting approval' };
  const hits = (listed.rows || []).filter(r => r.id.toLowerCase().startsWith(wanted));
  if (hits.length === 1) return { ok: true, id: hits[0].id };
  if (hits.length === 0) return { ok: false, error: `no execution awaiting approval starts with "${raw}" — call autopilot_review_execution with no id to list what is waiting.` };
  return { ok: false, error: `"${raw}" is ambiguous — it matches ${hits.length} executions awaiting approval (${hits.map(h => h.id.slice(0, 12)).join(', ')}); give a longer prefix.` };
}

function summarizeWaiting(row: WaitingRow, vtid: string | null) {
  const p = pendingOf(row);
  return {
    execution_id: row.id,
    execution_short: row.id.slice(0, 8),
    status: row.status,
    vtid,
    branch: p?.branch ?? row.branch ?? null,
    pr_title: p?.pr_title ?? null,
    staged_at: p?.staged_at ?? row.updated_at ?? null,
    files_total: p?.diff?.files_total ?? (p?.diff?.files?.length ?? null),
    patch_chars_total: p?.diff?.patch_chars_total ?? null,
  };
}

/**
 * autopilot_review_execution — read-only. No id: the list of held
 * executions. With an id: the stored preview, bounded for the model.
 */
export async function executeReviewExecution(
  args: { execution_id?: string },
  threadId: string,
  deps: ApprovalToolDeps = {},
): Promise<ApprovalToolResult> {
  const authz = authorizeApprovalTool('autopilot_review_execution', threadId);
  if (!authz.ok) {
    console.warn(`${LOG_PREFIX} review REFUSED thread=${threadId}`);
    return { ok: false, error: authz.error };
  }
  const s = deps.s === undefined ? getSupabase() : deps.s;
  if (!s) return { ok: false, error: 'Supabase not configured — cannot read executions.' };

  const rawId = typeof args?.execution_id === 'string' ? args.execution_id.trim() : '';
  if (!rawId) {
    const listed = await listAwaitingApproval(s);
    if (!listed.ok) return { ok: false, error: listed.error };
    const rows = listed.rows || [];
    const vtids = await vtidsForFindings(s, rows.map(r => r.finding_id || '').filter(Boolean));
    const waiting = rows.map(r => summarizeWaiting(r, (r.finding_id && vtids.get(r.finding_id)) || null));
    return {
      ok: true,
      data: {
        count: waiting.length,
        waiting,
        message: waiting.length === 0
          ? 'No Dev Autopilot execution is waiting for approval right now.'
          : `${waiting.length} execution(s) waiting for approval — call autopilot_review_execution with an execution_id to see the diff.`,
      },
    };
  }

  const resolved = await resolveExecutionId(s, rawId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const r = await (deps.getPending ?? getPendingApproval)(resolved.id, s);
  if (!r.ok) return { ok: false, error: r.error || 'execution not found' };
  if (r.status !== 'awaiting_approval' || !r.pending) {
    return {
      ok: true,
      data: {
        execution_id: resolved.id,
        execution_short: resolved.id.slice(0, 8),
        status: r.status,
        awaiting_approval: false,
        message: `Execution ${resolved.id.slice(0, 8)} is ${r.status}, not awaiting_approval — there is nothing to approve or reject.`,
      },
    };
  }
  const p = r.pending;
  const body = clip(p.pr_body || '', REVIEW_BODY_MAX_CHARS);
  const patch = clip(p.diff?.patch || '', REVIEW_PATCH_MAX_CHARS);
  const files = Array.isArray(p.diff?.files) ? p.diff.files : [];
  return {
    ok: true,
    data: {
      execution_id: resolved.id,
      execution_short: resolved.id.slice(0, 8),
      status: r.status,
      awaiting_approval: true,
      branch: p.branch,
      base_sha: p.base_sha,
      head_sha: p.head_sha,
      staged_at: p.staged_at,
      pr_title: p.pr_title,
      pr_body: body.text,
      pr_body_truncated: body.truncated,
      files: files.slice(0, REVIEW_FILES_MAX),
      files_total: p.diff?.files_total ?? files.length,
      stat: p.diff?.stat || '',
      patch: patch.text,
      patch_chars_total: p.diff?.patch_chars_total ?? (p.diff?.patch || '').length,
      patch_truncated: patch.truncated || p.diff?.truncated === true,
      message: `Execution ${resolved.id.slice(0, 8)} is waiting for approval on branch ${p.branch}. Approve with autopilot_approve_execution or reject with autopilot_reject_execution — only on the user's explicit decision.`,
    },
  };
}

/** autopilot_approve_execution — opens the PR through VTID-04029's approveExecution. */
export async function executeApproveExecution(
  args: { execution_id: string },
  threadId: string,
  deps: ApprovalToolDeps = {},
): Promise<ApprovalToolResult> {
  const authz = authorizeApprovalTool('autopilot_approve_execution', threadId);
  if (!authz.ok) {
    console.warn(`${LOG_PREFIX} approve REFUSED thread=${threadId}`);
    return { ok: false, error: authz.error };
  }
  const s = deps.s === undefined ? getSupabase() : deps.s;
  if (!s) return { ok: false, error: 'Supabase not configured — cannot approve.' };
  const resolved = await resolveExecutionId(s, typeof args?.execution_id === 'string' ? args.execution_id : '');
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const r = await (deps.approve ?? ((id, actor) => approveExecution(id, actor, { s })))(resolved.id, authz.actor);
  if (!r.ok) {
    console.warn(`${LOG_PREFIX} approve ${resolved.id.slice(0, 8)} failed: ${r.error}`);
    return { ok: false, error: `approve failed: ${r.error}` };
  }
  console.log(`${LOG_PREFIX} approve ${resolved.id.slice(0, 8)} by ${authz.actor} → PR #${r.pr_number}`);
  return {
    ok: true,
    data: {
      execution_id: resolved.id,
      execution_short: resolved.id.slice(0, 8),
      status: 'ci',
      pr_url: r.pr_url,
      pr_number: r.pr_number,
      approved_by: authz.actor,
      message: `Approved — PR #${r.pr_number} opened (${r.pr_url}); the execution is now in CI.`,
    },
  };
}

/** autopilot_reject_execution — deletes the branch and cancels through VTID-04029's rejectExecution. */
export async function executeRejectExecution(
  args: { execution_id: string; reason?: string },
  threadId: string,
  deps: ApprovalToolDeps = {},
): Promise<ApprovalToolResult> {
  const authz = authorizeApprovalTool('autopilot_reject_execution', threadId);
  if (!authz.ok) {
    console.warn(`${LOG_PREFIX} reject REFUSED thread=${threadId}`);
    return { ok: false, error: authz.error };
  }
  const s = deps.s === undefined ? getSupabase() : deps.s;
  if (!s) return { ok: false, error: 'Supabase not configured — cannot reject.' };
  const resolved = await resolveExecutionId(s, typeof args?.execution_id === 'string' ? args.execution_id : '');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 500) : undefined;

  const r = await (deps.reject ?? ((id, actor, why) => rejectExecution(id, actor, why, { s })))(resolved.id, authz.actor, reason);
  if (!r.ok) {
    console.warn(`${LOG_PREFIX} reject ${resolved.id.slice(0, 8)} failed: ${r.error}`);
    return { ok: false, error: `reject failed: ${r.error}` };
  }
  console.log(`${LOG_PREFIX} reject ${resolved.id.slice(0, 8)} by ${authz.actor} (branch_deleted=${r.branch_deleted === true})`);
  return {
    ok: true,
    data: {
      execution_id: resolved.id,
      execution_short: resolved.id.slice(0, 8),
      status: 'cancelled',
      branch_deleted: r.branch_deleted === true,
      reason: reason ?? null,
      rejected_by: authz.actor,
      message: `Rejected — execution ${resolved.id.slice(0, 8)} is cancelled${r.branch_deleted ? ' and its branch was deleted' : ' (branch deletion did not succeed; recorded on the row)'}. No PR was opened.`,
    },
  };
}
