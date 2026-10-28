/**
 * VTID-04029 (operator agent W4e, gap analysis §4.6): a diff preview with
 * Approve / Reject BEFORE the Dev Autopilot agent opens a pull request.
 *
 * The agent executor (run-agent-execution.ts) pushes its branch as before
 * but, when the execution was told to hold — `metadata.require_approval`
 * on the row (the operator on-ramp stamps it from
 * OPERATOR_PR_APPROVAL_REQUIRED) or DEV_AUTOPILOT_PR_APPROVAL_REQUIRED on
 * the executor process — it returns `awaiting_approval` instead of opening
 * the PR. `stageExecutionForApproval` records the row (status
 * 'awaiting_approval', metadata.pending_approval = branch, head/base sha,
 * PR title/body, a bounded diff preview) and emits one OASIS event.
 *
 *   approve → opens the PR with the stored title/body on the pushed branch
 *             and hands the row to applyExecutionResult exactly as an
 *             auto-opened PR would (status 'ci', pr_opened event, memory row)
 *   reject  → deletes the remote branch, status 'cancelled', metadata.rejected
 *
 * Nothing here runs unless a row is actually staged; with the flags off the
 * executor's behaviour is byte-for-byte what it was. The row is deliberately
 * NOT counted against the concurrency cap while it waits (a human hold is
 * not a running task) but it DOES block a second execution of the same
 * finding (see the inflight lists in dev-autopilot-execute.ts).
 */

import { emitOasisEvent } from './oasis-event-service';
import type { CicdEventType } from '../types/cicd';
import { supa, getSupabase, applyExecTerminalSideEffects, type SupaConfig } from './dev-autopilot-execute';
import { createPullRequest } from './github-service';

const LOG_PREFIX = '[dev-autopilot-approval]';
const EXEC_VTID = 'VTID-DEV-AUTOPILOT';

const GITHUB_OWNER = process.env.DEV_AUTOPILOT_REPO_OWNER || 'exafyltd';
const GITHUB_REPO = process.env.DEV_AUTOPILOT_REPO_NAME || 'vitana-platform';
const GITHUB_BASE_BRANCH = process.env.DEV_AUTOPILOT_REPO_REF || 'main';

/** Bound on the stored unified diff (chars); the head of the patch is kept. */
export const PENDING_DIFF_MAX_CHARS = 60_000;
/** Bound on the stored `--stat` block (chars). */
export const PENDING_STAT_MAX_CHARS = 4_000;
/** Bound on the stored file list. */
export const PENDING_FILES_MAX = 200;

export interface DiffPreview {
  base_sha: string;
  head_sha: string;
  files: string[];
  files_total: number;
  stat: string;
  patch: string;
  patch_chars_total: number;
  truncated: boolean;
}

export interface PendingApproval {
  branch: string;
  base_sha: string;
  head_sha: string;
  pr_title: string;
  pr_body: string;
  session_id: string | null;
  staged_at: string;
  diff: DiffPreview;
}

/** The runner's result shape when it stopped before opening a PR. */
export interface AwaitingApprovalResult {
  ok: true;
  awaiting_approval: true;
  branch: string;
  base_sha: string;
  head_sha: string;
  pr_title: string;
  pr_body: string;
  session_id?: string;
  diff: { stat: string; patch: string; files: string[] };
}

/**
 * Whether an execution must stop before opening its PR. Row-level
 * `metadata.require_approval === true` wins; otherwise the executor
 * process's own DEV_AUTOPILOT_PR_APPROVAL_REQUIRED (exact string 'true').
 * Never in fix mode — the PR already exists (VTID-04017).
 */
export function approvalRequired(
  metadata: Record<string, unknown> | null | undefined,
  opts: { fixMode?: boolean; env?: NodeJS.ProcessEnv } = {},
): boolean {
  if (opts.fixMode) return false;
  if (metadata && metadata.require_approval === true) return true;
  if (metadata && metadata.require_approval === false) return false;
  const env = opts.env ?? process.env;
  return env.DEV_AUTOPILOT_PR_APPROVAL_REQUIRED === 'true';
}

function clip(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…[truncated: ${s.length - max} more chars]`, truncated: true };
}

export function boundDiffPreview(input: { stat: string; patch: string; files: string[]; baseSha: string; headSha: string }): DiffPreview {
  const stat = clip(input.stat || '', PENDING_STAT_MAX_CHARS);
  const patch = clip(input.patch || '', PENDING_DIFF_MAX_CHARS);
  const files = Array.isArray(input.files) ? input.files.filter((f) => typeof f === 'string' && f) : [];
  return {
    base_sha: input.baseSha,
    head_sha: input.headSha,
    files: files.slice(0, PENDING_FILES_MAX),
    files_total: files.length,
    stat: stat.text,
    patch: patch.text,
    patch_chars_total: (input.patch || '').length,
    truncated: stat.truncated || patch.truncated || files.length > PENDING_FILES_MAX,
  };
}

export function buildPendingApproval(result: AwaitingApprovalResult, now: () => Date = () => new Date()): PendingApproval {
  return {
    branch: result.branch,
    base_sha: result.base_sha,
    head_sha: result.head_sha,
    pr_title: result.pr_title,
    pr_body: result.pr_body,
    session_id: result.session_id || null,
    staged_at: now().toISOString(),
    diff: boundDiffPreview({ stat: result.diff.stat, patch: result.diff.patch, files: result.diff.files, baseSha: result.base_sha, headSha: result.head_sha }),
  };
}

export function isAwaitingApprovalResult(r: unknown): r is AwaitingApprovalResult {
  return !!r && typeof r === 'object' && (r as { ok?: unknown }).ok === true && (r as { awaiting_approval?: unknown }).awaiting_approval === true
    && typeof (r as { branch?: unknown }).branch === 'string' && typeof (r as { head_sha?: unknown }).head_sha === 'string';
}

interface ExecRowLite {
  id: string;
  status: string;
  branch?: string | null;
  finding_id?: string;
  metadata?: Record<string, unknown> | null;
}

async function loadRow(s: SupaConfig, execId: string): Promise<ExecRowLite | null> {
  const r = await supa<ExecRowLite[]>(s, `/rest/v1/dev_autopilot_executions?id=eq.${encodeURIComponent(execId)}&select=id,status,branch,finding_id,metadata&limit=1`);
  return r.ok && r.data && r.data[0] ? r.data[0] : null;
}

/**
 * Record the hold: status 'awaiting_approval', the preview under
 * metadata.pending_approval (merged, never replacing the row's metadata —
 * VTID-04011), one OASIS event so the steps feed and the Command Hub see it.
 */
export async function stageExecutionForApproval(s: SupaConfig, execId: string, result: AwaitingApprovalResult): Promise<{ ok: boolean; error?: string }> {
  const row = await loadRow(s, execId);
  const existingMeta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const pending = buildPendingApproval(result);
  const patch = await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${encodeURIComponent(execId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'awaiting_approval',
      branch: result.branch,
      execution_session_id: result.session_id || null,
      metadata: { ...existingMeta, pending_approval: pending },
    }),
  });
  if (!patch.ok) {
    console.error(`${LOG_PREFIX} stage ${execId.slice(0, 8)} failed: ${patch.error}`);
    return { ok: false, error: patch.error };
  }
  await emitOasisEvent({
    vtid: EXEC_VTID,
    type: 'dev_autopilot.execution.awaiting_approval' as CicdEventType,
    source: 'dev-autopilot',
    status: 'info',
    message: `Execution ${execId.slice(0, 8)} pushed ${result.branch}@${result.head_sha.slice(0, 8)} (${pending.diff.files_total} file(s)) — awaiting approval before a PR is opened`,
    payload: { execution_id: execId, branch: result.branch, head_sha: result.head_sha, files: pending.diff.files_total, truncated: pending.diff.truncated },
  }).catch(() => undefined);
  console.log(`${LOG_PREFIX} ${execId.slice(0, 8)} awaiting approval on ${result.branch}@${result.head_sha.slice(0, 8)} (${pending.diff.files_total} files, patch ${pending.diff.patch_chars_total} chars)`);
  return { ok: true };
}

export async function getPendingApproval(execId: string, s: SupaConfig | null = getSupabase()): Promise<{ ok: boolean; status?: string; pending?: PendingApproval | null; error?: string }> {
  if (!s) return { ok: false, error: 'Supabase not configured' };
  const row = await loadRow(s, execId);
  if (!row) return { ok: false, error: 'execution not found' };
  const pending = row.metadata && typeof row.metadata.pending_approval === 'object' ? (row.metadata.pending_approval as PendingApproval) : null;
  return { ok: true, status: row.status, pending };
}

/**
 * Approve: open the PR on the pushed branch with the stored title/body,
 * then hand the row to applyExecutionResult (status 'ci', pr_opened event,
 * memory row) exactly as an auto-opened PR would. The row must still be
 * 'awaiting_approval'; a second click is refused, not re-applied.
 */
export async function approveExecution(
  execId: string,
  actor: string,
  deps: { s?: SupaConfig | null; openPr?: (title: string, body: string, branch: string) => Promise<{ number: number; html_url: string }> } = {},
): Promise<{ ok: boolean; pr_url?: string; pr_number?: number; error?: string }> {
  const s = deps.s === undefined ? getSupabase() : deps.s;
  if (!s) return { ok: false, error: 'Supabase not configured' };
  const row = await loadRow(s, execId);
  if (!row) return { ok: false, error: 'execution not found' };
  if (row.status !== 'awaiting_approval') return { ok: false, error: `execution is ${row.status}, not awaiting_approval` };
  const pending = row.metadata && typeof row.metadata.pending_approval === 'object' ? (row.metadata.pending_approval as PendingApproval) : null;
  if (!pending || !pending.branch) return { ok: false, error: 'no pending_approval on the execution' };

  const openPr = deps.openPr ?? ((title: string, body: string, branch: string) => createPullRequest(`${GITHUB_OWNER}/${GITHUB_REPO}`, title, body, branch, GITHUB_BASE_BRANCH));
  let pr: { number: number; html_url: string };
  try {
    pr = await openPr(pending.pr_title, `${pending.pr_body}\n\n_Approved by ${actor} (VTID-04029 diff review)._`, pending.branch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} approve ${execId.slice(0, 8)}: open PR failed: ${msg}`);
    return { ok: false, error: `open PR failed: ${msg.slice(0, 300)}` };
  }

  await emitOasisEvent({
    vtid: EXEC_VTID,
    type: 'dev_autopilot.execution.approved' as CicdEventType,
    source: 'dev-autopilot',
    status: 'success',
    message: `Execution ${execId.slice(0, 8)} approved by ${actor} — PR #${pr.number} opened`,
    payload: { execution_id: execId, actor, pr_url: pr.html_url, pr_number: pr.number, branch: pending.branch, head_sha: pending.head_sha },
  }).catch(() => undefined);

  // Merge the decision into metadata first so applyExecutionResult's own
  // PATCH (which does not touch metadata on the success path) keeps it.
  await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${encodeURIComponent(execId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ metadata: { ...(row.metadata || {}), approved: { by: actor, at: new Date().toISOString(), head_sha: pending.head_sha } } }),
  });
  // Lazy: dev-autopilot-execute imports this module (stage), so the reverse
  // edge is resolved at call time, never at module load.
  const { applyExecutionResult } = require('./dev-autopilot-execute') as typeof import('./dev-autopilot-execute');
  await applyExecutionResult(s, execId, { ok: true, pr_url: pr.html_url, pr_number: pr.number, branch: pending.branch, session_id: pending.session_id || undefined });
  return { ok: true, pr_url: pr.html_url, pr_number: pr.number };
}

async function deleteRemoteBranch(branch: string): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.GITHUB_SAFE_MERGE_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: 'no GitHub token in this process' };
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    // 422 = ref already gone: the goal state.
    if (res.ok || res.status === 422 || res.status === 404) return { ok: true };
    return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reject: delete the pushed branch (best effort — a failure is recorded, it
 * never blocks the decision), status 'cancelled', metadata.rejected.
 */
export async function rejectExecution(
  execId: string,
  actor: string,
  reason: string | undefined,
  deps: { s?: SupaConfig | null; deleteBranch?: (branch: string) => Promise<{ ok: boolean; error?: string }> } = {},
): Promise<{ ok: boolean; branch_deleted?: boolean; error?: string }> {
  const s = deps.s === undefined ? getSupabase() : deps.s;
  if (!s) return { ok: false, error: 'Supabase not configured' };
  const row = await loadRow(s, execId);
  if (!row) return { ok: false, error: 'execution not found' };
  if (row.status !== 'awaiting_approval') return { ok: false, error: `execution is ${row.status}, not awaiting_approval` };
  const pending = row.metadata && typeof row.metadata.pending_approval === 'object' ? (row.metadata.pending_approval as PendingApproval) : null;
  const branch = pending?.branch || row.branch || null;

  let branchDeleted = false;
  let deleteError: string | undefined;
  if (branch) {
    const d = await (deps.deleteBranch ?? deleteRemoteBranch)(branch);
    branchDeleted = d.ok;
    deleteError = d.error;
    if (!d.ok) console.warn(`${LOG_PREFIX} reject ${execId.slice(0, 8)}: branch ${branch} not deleted: ${d.error}`);
  }

  const cleanReason = (reason || '').trim().slice(0, 500) || null;
  const patch = await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${encodeURIComponent(execId)}&status=eq.awaiting_approval`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      metadata: {
        ...(row.metadata || {}),
        rejected: { by: actor, at: new Date().toISOString(), reason: cleanReason, branch, branch_deleted: branchDeleted, ...(deleteError ? { delete_error: deleteError.slice(0, 200) } : {}) },
      },
    }),
  });
  if (!patch.ok) return { ok: false, error: patch.error };
  // VTID-04378: a rejected hold is terminal — close the finding's ledger VTID
  // as cancelled (the raw PATCH above used to leave it IN PROGRESS forever).
  applyExecTerminalSideEffects(s, execId, 'cancelled');

  await emitOasisEvent({
    vtid: EXEC_VTID,
    type: 'dev_autopilot.execution.rejected' as CicdEventType,
    source: 'dev-autopilot',
    status: 'warning',
    message: `Execution ${execId.slice(0, 8)} rejected by ${actor}${cleanReason ? `: ${cleanReason}` : ''}`,
    payload: { execution_id: execId, actor, reason: cleanReason, branch, branch_deleted: branchDeleted },
  }).catch(() => undefined);
  return { ok: true, branch_deleted: branchDeleted };
}
