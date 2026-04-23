/**
 * Supabase queue operations (worker side).
 *
 * Shape mirrors the columns in the 20260421230500 migration. Both the gateway
 * (enqueue + poll for result) and this worker (claim + complete/fail) use the
 * SUPABASE_SERVICE_ROLE key, so no RLS policies are needed.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  // Fail loud at boot — the worker is useless without these.
  console.error('[autopilot-worker] SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
  process.exit(1);
}

export interface QueueRow {
  id: string;
  kind: 'plan' | 'execute';
  finding_id: string;
  execution_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input_payload: {
    prompt: string;
    model?: string;
    max_tokens?: number;
    notes?: string;
    /** Tells the worker to publish the validated files to GitHub itself
     * (branch + commits + open PR) instead of returning text and letting
     * the gateway do those steps. Set by the gateway when the
     * worker-owned-PR feature flag is on. */
    worker_owns_pr?: boolean;
    /** Pre-computed branch name (gateway-side so it matches what the
     * watcher / execution row recorded). Defaults to
     * `dev-autopilot/<execId-prefix>` if absent. */
    branch_name?: string;
    /** Base branch to fork from. Defaults to 'main'. */
    base_branch?: string;
    /** Used in commit messages so the audit trail mentions the execution
     * id (gateway also uses this for the safe-merge token's audit log). */
    vtid_like?: string;
  };
  output_payload: Record<string, unknown> | null;
  error_message: string | null;
  attempts: number;
  worker_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

async function supa<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...init,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
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

/**
 * Try to atomically claim the oldest pending row. Returns undefined when the
 * queue is empty or someone else got the row first.
 *
 * Supabase PostgREST doesn't support SELECT…FOR UPDATE SKIP LOCKED in one
 * call, so we do a two-step: read the oldest id, then PATCH it with a guard
 * on status='pending'. If the PATCH matches no row, we lost the race.
 */
export async function claimNextTask(workerId: string): Promise<QueueRow | undefined> {
  // 1. Find the oldest pending row.
  const peek = await supa<QueueRow[]>(
    '/rest/v1/dev_autopilot_worker_queue?status=eq.pending&order=created_at.asc&limit=1',
  );
  if (!peek.ok || !peek.data || peek.data.length === 0) return undefined;
  const row = peek.data[0];

  // 2. Atomic claim via WHERE status=pending guard.
  const claim = await supa<QueueRow[]>(
    `/rest/v1/dev_autopilot_worker_queue?id=eq.${row.id}&status=eq.pending`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'running',
        worker_id: workerId,
        started_at: new Date().toISOString(),
        attempts: (row.attempts || 0) + 1,
      }),
    },
  );
  if (!claim.ok || !claim.data || claim.data.length === 0) return undefined;
  return claim.data[0];
}

export async function completeTask(
  rowId: string,
  output: { text: string; usage?: { input_tokens?: number; output_tokens?: number }; extra?: Record<string, unknown> },
): Promise<{ ok: boolean; error?: string }> {
  const r = await supa(
    `/rest/v1/dev_autopilot_worker_queue?id=eq.${rowId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        output_payload: {
          text: output.text,
          usage: output.usage || null,
          ...(output.extra || {}),
        },
        completed_at: new Date().toISOString(),
        error_message: null,
      }),
    },
  );
  return { ok: r.ok, error: r.error };
}

export async function failTask(rowId: string, error: string): Promise<{ ok: boolean; error?: string }> {
  const r = await supa(
    `/rest/v1/dev_autopilot_worker_queue?id=eq.${rowId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'failed',
        error_message: error.slice(0, 4000),
        completed_at: new Date().toISOString(),
      }),
    },
  );
  return { ok: r.ok, error: r.error };
}

/**
 * Pending + running counts — used by the /health endpoint and startup log.
 */
export async function queueDepth(): Promise<{ pending: number; running: number } | { error: string }> {
  const [p, r] = await Promise.all([
    supa<QueueRow[]>(`/rest/v1/dev_autopilot_worker_queue?status=eq.pending&select=id`),
    supa<QueueRow[]>(`/rest/v1/dev_autopilot_worker_queue?status=eq.running&select=id`),
  ]);
  if (!p.ok) return { error: p.error || 'pending count failed' };
  if (!r.ok) return { error: r.error || 'running count failed' };
  return { pending: (p.data || []).length, running: (r.data || []).length };
}
