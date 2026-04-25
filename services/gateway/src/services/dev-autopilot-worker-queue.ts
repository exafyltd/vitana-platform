/**
 * Dev Autopilot — worker queue client (gateway side)
 *
 * When DEV_AUTOPILOT_USE_WORKER=true, LLM calls made by the planning and
 * execute services get routed through this queue instead of hitting
 * api.anthropic.com directly. A local worker (services/autopilot-worker)
 * picks up pending rows, runs them via `claude -p` against the user's
 * Claude subscription, and writes the result back. This lets us draw on
 * the Claude Pro/Max subscription for LLM usage without needing
 * pay-per-token API credits.
 *
 * Design invariants:
 *   - Enqueue is synchronous (one Supabase INSERT).
 *   - Waiting for the result is polling-based (Supabase REST, no websockets).
 *   - Poll interval is modest (2s) because LLM runs take tens of seconds.
 *   - Timeout here is generous (6 minutes) since the gateway runs this inside
 *     a background ticker for execute (no Cloud Run 300s wall) and inside a
 *     request handler for plan (where we already cap at 240s on the API path).
 *   - A row that stays in 'running' longer than STUCK_MINUTES is marked
 *     'failed' by reclaimStuckWorkerTasks() — called on a schedule separately.
 */

import { writeAutopilotFailure, type AutopilotFailureStage } from './dev-autopilot-self-heal-log';

const LOG_PREFIX = '[dev-autopilot-worker-queue]';
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 360_000; // 6 min — generous for plan + execute
const STUCK_MINUTES = 15;
// A row sitting in 'pending' for more than this is almost certainly an
// orphan — either no worker daemon is alive to claim it, or the gateway
// container that enqueued it died before any worker noticed. The existing
// running-watchdog can't see these. Without this, the row stays pending
// forever and the failure is invisible on the Self-Healing screen.
const PENDING_STUCK_MINUTES = 15;

export interface SupaConfig { url: string; key: string; }

function getSupabase(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

async function supa<T>(
  s: SupaConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const res = await fetch(`${s.url}${path}`, {
      ...init,
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `${res.status}: ${text.slice(0, 400)}` };
    if (!text) return { ok: true, status: res.status };
    try { return { ok: true, status: res.status, data: JSON.parse(text) as T }; }
    catch { return { ok: true, status: res.status }; }
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

export interface WorkerTaskInput {
  kind: 'plan' | 'execute';
  finding_id: string;
  execution_id?: string;
  prompt: string;
  model?: string;
  max_tokens?: number;
  notes?: string;
  /** Worker-owned-PR mode: after validation passes, the worker creates the
   * branch + writes files + opens the PR itself, then writes pr_url back to
   * output_payload. The gateway just reads it instead of doing GitHub work
   * itself. Removes the "Cloud Run recycles us between worker-finishes and
   * gateway-writes-PR" failure mode. */
  worker_owns_pr?: boolean;
  branch_name?: string;
  base_branch?: string;
  vtid_like?: string;
}

export interface WorkerAttemptFailure {
  attempt: number;
  stage: 'parse' | 'apply' | 'tsc' | 'jest';
  pattern_key: string;
  example_message: string;
}

export interface WorkerTaskResult {
  ok: boolean;
  text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Set when input.worker_owns_pr=true and the worker successfully published
   * a PR. The gateway reads these instead of opening a PR itself. */
  pr_url?: string;
  pr_number?: number;
  branch?: string;
  /** Per-attempt validation failures from the worker's retry loop. Populated
   * on both success (when earlier attempts failed) and final failure. The
   * prompt-gap feedback loop in dev-autopilot-execute.ts upserts these into
   * dev_autopilot_prompt_learnings. */
  attempt_failures?: WorkerAttemptFailure[];
  error?: string;
  queue_row_id?: string;
}

export function isWorkerQueueEnabled(): boolean {
  return (process.env.DEV_AUTOPILOT_USE_WORKER || '').toLowerCase() === 'true';
}

export function isWorkerOwnsPrEnabled(): boolean {
  return (process.env.AUTOPILOT_WORKER_OWNS_PR || '').toLowerCase() === 'true';
}

/**
 * Insert a pending row into the queue. Returns the row id for the poller.
 */
export async function enqueueWorkerTask(
  input: WorkerTaskInput,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'Supabase not configured' };
  const body = {
    kind: input.kind,
    finding_id: input.finding_id,
    execution_id: input.execution_id || null,
    input_payload: {
      prompt: input.prompt,
      model: input.model || 'claude-sonnet-4-6',
      max_tokens: input.max_tokens ?? 16_000,
      notes: input.notes || null,
      worker_owns_pr: input.worker_owns_pr === true,
      branch_name: input.branch_name,
      base_branch: input.base_branch,
      vtid_like: input.vtid_like,
    },
    status: 'pending',
  };
  const r = await supa<Array<{ id: string }>>(s, '/rest/v1/dev_autopilot_worker_queue', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.data || r.data.length === 0) return { ok: false, error: r.error || 'enqueue returned no row' };
  return { ok: true, id: r.data[0].id };
}

/**
 * Poll a queue row until it terminates (completed or failed) or the timeout
 * elapses. Returns the terminal result.
 */
export async function waitForWorkerTask(
  rowId: string,
  opts: { timeoutMs?: number } = {},
): Promise<WorkerTaskResult> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'Supabase not configured' };
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  // Tolerate transient fetch errors from Supabase. Cloud Run's egress
  // occasionally resets a connection mid-request with 'TypeError: fetch failed';
  // a single bad poll shouldn't force us to give up on a task the worker is
  // still working on. Only bail out if we see N consecutive failures or the
  // overall wait deadline elapses.
  const MAX_CONSECUTIVE_FAILURES = 10;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    const r = await supa<Array<{
      status: string;
      output_payload: {
        text?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        // Set by the worker when it publishes the PR itself (worker_owns_pr).
        pr_url?: string;
        pr_number?: number;
        branch?: string;
        worker_owns_pr?: boolean;
        attempt_failures?: WorkerAttemptFailure[];
      } | null;
      error_message: string | null;
    }>>(
      s,
      `/rest/v1/dev_autopilot_worker_queue?id=eq.${rowId}&select=status,output_payload,error_message&limit=1`,
    );
    if (!r.ok || !r.data || r.data.length === 0) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return {
          ok: false,
          error: `worker-queue lookup failed ${consecutiveFailures}× in a row: ${r.error || 'no row'}`,
          queue_row_id: rowId,
        };
      }
      // Back off a bit longer than the normal poll interval so transient
      // issues have a chance to clear.
      await new Promise(res => setTimeout(res, POLL_INTERVAL_MS * 2));
      continue;
    }
    consecutiveFailures = 0;
    const row = r.data[0];
    if (row.status === 'completed') {
      const op = row.output_payload || {};
      return {
        ok: true,
        text: op.text,
        usage: op.usage,
        pr_url: op.pr_url,
        pr_number: op.pr_number,
        branch: op.branch,
        attempt_failures: op.attempt_failures,
        queue_row_id: rowId,
      };
    }
    if (row.status === 'failed') {
      return {
        ok: false,
        error: row.error_message || 'worker reported failure with no message',
        attempt_failures: row.output_payload?.attempt_failures,
        queue_row_id: rowId,
      };
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, error: `worker-queue wait timed out after ${Math.round((opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) / 1000)}s`, queue_row_id: rowId };
}

/**
 * Convenience: enqueue + wait, matching the old callMessagesApi shape so the
 * planning / execute services can drop this in where they used to call the
 * Messages API directly.
 */
export async function runWorkerTask(input: WorkerTaskInput, opts: { timeoutMs?: number } = {}): Promise<WorkerTaskResult> {
  const enq = await enqueueWorkerTask(input);
  if (!enq.ok || !enq.id) return { ok: false, error: enq.error || 'enqueue failed' };
  console.log(`${LOG_PREFIX} enqueued ${input.kind} task ${enq.id.slice(0, 8)} for finding ${input.finding_id.slice(0, 8)}`);
  return waitForWorkerTask(enq.id, opts);
}

/**
 * Watchdog: mark rows stuck in 'running' past STUCK_MINUTES as 'failed' so the
 * bridge / self-heal path picks them up. Returns how many rows were reclaimed.
 *
 * Intended to be called by the same background ticker that runs the Dev
 * Autopilot executor watcher — every 30-60s is enough.
 */
export async function reclaimStuckWorkerTasks(): Promise<{ reclaimed: number; error?: string }> {
  const s = getSupabase();
  if (!s) return { reclaimed: 0, error: 'Supabase not configured' };
  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60 * 1000).toISOString();
  const r = await supa<Array<{ id: string }>>(
    s,
    `/rest/v1/dev_autopilot_worker_queue?status=eq.running&started_at=lt.${cutoff}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'failed',
        error_message: `reclaimed by watchdog: stuck in 'running' > ${STUCK_MINUTES}m (worker crash / scaling event)`,
        completed_at: new Date().toISOString(),
      }),
    },
  );
  if (!r.ok) return { reclaimed: 0, error: r.error };
  return { reclaimed: (r.data || []).length };
}

/**
 * Watchdog #2: rows stuck in 'pending' past PENDING_STUCK_MINUTES.
 *
 * Why this exists: when no worker daemon is alive to poll the queue (binary
 * missing, daemon crashed, host machine down), pending rows pile up
 * indefinitely. The running-watchdog above only catches rows a worker
 * already started. Without this, the failure is silent — `waitForWorkerTask`
 * eventually times out, but if the gateway container that was waiting got
 * recycled mid-flight, no caller is left to log the failure either.
 *
 * Each reclaimed row also writes a self_healing_log entry directly so the
 * Self-Healing screen surfaces "the worker queue is jammed" even when no
 * caller is around to attribute the failure.
 */
export async function reclaimStuckPendingWorkerTasks(): Promise<{ reclaimed: number; error?: string }> {
  const s = getSupabase();
  if (!s) return { reclaimed: 0, error: 'Supabase not configured' };
  const cutoff = new Date(Date.now() - PENDING_STUCK_MINUTES * 60 * 1000).toISOString();
  const stuckR = await supa<Array<{
    id: string;
    kind: string;
    finding_id: string;
    execution_id: string | null;
    created_at: string;
  }>>(
    s,
    `/rest/v1/dev_autopilot_worker_queue?status=eq.pending&created_at=lt.${cutoff}`
    + `&select=id,kind,finding_id,execution_id,created_at&limit=20`,
  );
  if (!stuckR.ok) return { reclaimed: 0, error: stuckR.error };
  if (!stuckR.data || stuckR.data.length === 0) return { reclaimed: 0 };

  let reclaimed = 0;
  for (const row of stuckR.data) {
    const ageMin = Math.round((Date.now() - new Date(row.created_at).getTime()) / 60_000);
    const errorMsg = `no worker claimed task in ${ageMin}m (worker daemon down / binary missing / network)`;
    // Conditional PATCH so we don't overwrite a row a worker just claimed
    // a moment ago.
    const patch = await supa(
      s,
      `/rest/v1/dev_autopilot_worker_queue?id=eq.${row.id}&status=eq.pending`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          error_message: errorMsg,
          completed_at: new Date().toISOString(),
        }),
      },
    );
    if (!patch.ok) continue;
    reclaimed++;
    const stage: AutopilotFailureStage = row.kind === 'plan' ? 'plan_gen' : 'execute_run';
    await writeAutopilotFailure(s, {
      stage,
      vtid: row.execution_id
        ? `VTID-DA-${row.execution_id.slice(0, 8)}`
        : `VTID-DA-FIND-${row.finding_id.slice(0, 8)}`,
      endpoint: `autopilot.worker_queue.${row.kind}`,
      failure_class: 'dev_autopilot_worker_queue_unclaimed',
      confidence: 0,
      diagnosis: {
        summary: errorMsg + ' — restart worker daemon or fix binary path; ANTHROPIC_API_KEY fallback runs only when worker spawn returns ENOENT during a live call.',
        finding_id: row.finding_id,
        execution_id: row.execution_id,
        worker_queue_id: row.id,
        age_minutes: ageMin,
        kind: row.kind,
      },
      outcome: 'escalated',
      attempt_number: 1,
    });
  }
  return { reclaimed };
}

export { LOG_PREFIX };
