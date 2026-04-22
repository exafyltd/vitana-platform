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

const LOG_PREFIX = '[dev-autopilot-worker-queue]';
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 360_000; // 6 min — generous for plan + execute
const STUCK_MINUTES = 15;

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
}

export interface WorkerTaskResult {
  ok: boolean;
  text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: string;
  queue_row_id?: string;
}

export function isWorkerQueueEnabled(): boolean {
  return (process.env.DEV_AUTOPILOT_USE_WORKER || '').toLowerCase() === 'true';
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
      output_payload: { text?: string; usage?: { input_tokens?: number; output_tokens?: number } } | null;
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
      return {
        ok: true,
        text: row.output_payload?.text,
        usage: row.output_payload?.usage,
        queue_row_id: rowId,
      };
    }
    if (row.status === 'failed') {
      return {
        ok: false,
        error: row.error_message || 'worker reported failure with no message',
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

export { LOG_PREFIX };
