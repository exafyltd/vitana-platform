/**
 * VTID-04446 (Orchestrator v2, P4): run leases on the native ledger
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.3 "Leases, not heartbeats-as-truth",
 * §5 P4 exit "a live run is never reclaimed while stepping").
 *
 * The Dev Autopilot running-watchdog (`backgroundExecutorTick` step 0b) used
 * one rule for every execution: `status=running` with `updated_at` older than
 * 20 minutes is dead. That rule reclaimed a LIVE agent run once (VTID-04011)
 * and, the other way round, lets a task that died two minutes in hold its
 * slot for another 18.
 *
 * With this module a claimed execution gets a lease row in `agent_runs`
 * (plane `dev_autopilot`, `idempotency_key = dev_autopilot:<execution id>`,
 * `metadata.mirror_of` pointing back at the execution):
 *
 *   - claim   → lease written with the LEGACY window (20 min). A run that
 *               never renews (single-shot, an executor image older than this
 *               change) keeps exactly the old 20-minute semantics.
 *   - renew   → every agent heartbeat (60 s) moves the lease to now + TTL
 *               (5 min default) and takes ownership, so a live run's lease is
 *               always ahead of the clock while it is stepping.
 *   - release → when the running phase ends (applyExecutionResult, or the
 *               watchdog's own reclaim) the lease is cleared and the row
 *               closed with the running phase's outcome.
 *
 * The watchdog then asks the lease, not the clock: a live lease is never
 * reclaimed; an expired lease is reclaimed as soon as it expires (about five
 * minutes after a dead task's last beat instead of 20); an execution with no
 * lease row falls back to the legacy 20-minute rule unchanged.
 *
 * Gated on `ORCHESTRATOR_RUN_LEASE_ENABLED` (exact 'true'): with the flag
 * unset nothing is written or read and the watchdog is byte-for-byte what it
 * was. The flag belongs on BOTH the gateway and the executor task. If only the
 * gateway has it, nothing is lost: the lease keeps its 20-minute claim window
 * (the legacy rule), and the gateway's sweep closes leases whose execution
 * already left `running`. Every call is fail-open: a ledger error is logged
 * and the watchdog falls back to the legacy rule for that row.
 *
 * Mirror rows are excluded from `agent_runs_unified` by migration
 * `20260923210000_vtid_04446_run_leases.sql` (the execution already appears
 * there through its own projection); apply that before enabling the flag.
 */

export const RUN_LEASE_ENABLED_ENV = 'ORCHESTRATOR_RUN_LEASE_ENABLED';
export const RUN_LEASE_TTL_ENV = 'ORCHESTRATOR_RUN_LEASE_TTL_MS';
export const DEV_RUN_PLANE = 'dev_autopilot';
export const DEFAULT_RUN_LEASE_TTL_MS = 5 * 60_000;
export const MIN_RUN_LEASE_TTL_MS = 2 * 60_000;
export const MAX_RUN_LEASE_TTL_MS = 30 * 60_000;
/** The watchdog's pre-lease rule, kept as the window of a lease nobody has renewed yet. */
export const LEGACY_STUCK_EXECUTION_MS = 20 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOG_PREFIX = '[run-lease]';

/** The REST seam: `supa(s, path, init)` from dev-autopilot-execute, bound to a config. */
export type LeaseRest = <T>(path: string, init?: RequestInit) => Promise<{ ok: boolean; data?: T; status: number; error?: string }>;

export function isRunLeaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RUN_LEASE_ENABLED_ENV] === 'true';
}

/** Lease TTL for a renewed run; garbage or out-of-range values fall back or clamp. */
export function runLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env[RUN_LEASE_TTL_ENV] || '', 10);
  if (!Number.isFinite(n)) return DEFAULT_RUN_LEASE_TTL_MS;
  return Math.min(MAX_RUN_LEASE_TTL_MS, Math.max(MIN_RUN_LEASE_TTL_MS, n));
}

/** Who holds a lease: the environment, the host and the process. */
export function leaseOwnerId(env: NodeJS.ProcessEnv = process.env, host?: string, pid: number = process.pid): string {
  let h = host;
  if (!h) {
    try { h = require('os').hostname(); } catch { h = 'unknown-host'; }
  }
  const where = env.VITANA_ENV || env.NODE_ENV || 'unknown';
  return `${where}:${h}:${pid}`.slice(0, 200);
}

export function devRunKey(executionId: string): string {
  return `${DEV_RUN_PLANE}:${executionId}`;
}

export interface LeaseState {
  lease_owner: string | null;
  lease_until: string | null;
}

/** Pure: is this lease still ahead of the clock? */
export function isLeaseLive(lease: Pick<LeaseState, 'lease_until'> | null | undefined, now: Date = new Date()): boolean {
  if (!lease || !lease.lease_until) return false;
  const t = Date.parse(lease.lease_until);
  return Number.isFinite(t) && t > now.getTime();
}

export interface DevExecutionForLease {
  id: string;
  finding_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Pure: the `agent_runs` row written when an execution is claimed. */
export function buildDevRunLeaseRow(
  exec: DevExecutionForLease,
  owner: string,
  opts: { vtid?: string | null; now?: Date; initialWindowMs?: number } = {},
): Record<string, unknown> {
  const now = opts.now ?? new Date();
  const window = opts.initialWindowMs ?? LEGACY_STUCK_EXECUTION_MS;
  const executor = typeof exec.metadata?.executor === 'string' ? (exec.metadata.executor as string) : null;
  return {
    agent_id: executor === 'agent' ? 'autopilot-agent-executor' : 'dev-autopilot-executor',
    plane: DEV_RUN_PLANE,
    status: 'running',
    vtid: opts.vtid ?? null,
    idempotency_key: devRunKey(exec.id),
    lease_owner: owner,
    lease_until: new Date(now.getTime() + window).toISOString(),
    created_via: 'system',
    intent: `dev_autopilot execution ${exec.id}`,
    metadata: {
      mirror_of: { table: 'dev_autopilot_executions', id: exec.id },
      finding_id: exec.finding_id ?? null,
      executor,
      source: 'VTID-04446',
    },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

/** Pure: path + body of a renew. Scoped to a running row, so a closed lease is never reopened. */
export function renewRequest(executionId: string, owner: string, ttlMs: number, now: Date = new Date()): { path: string; body: Record<string, unknown> } {
  return {
    path: `/rest/v1/agent_runs?idempotency_key=eq.${encodeURIComponent(devRunKey(executionId))}&status=eq.running`,
    body: {
      lease_owner: owner,
      lease_until: new Date(now.getTime() + ttlMs).toISOString(),
      updated_at: now.toISOString(),
    },
  };
}

export type RunPhaseOutcome = 'succeeded' | 'failed' | 'cancelled';

/** Pure: the running phase's outcome from an executor result. Held-for-approval is a finished running phase. */
export function runPhaseOutcome(result: { ok: boolean; cancelled?: boolean }): RunPhaseOutcome {
  if (result.cancelled) return 'cancelled';
  return result.ok ? 'succeeded' : 'failed';
}

/** Pure: path + body of a release. */
export function releaseRequest(
  executionId: string,
  outcome: RunPhaseOutcome,
  error: string | null = null,
  now: Date = new Date(),
): { path: string; body: Record<string, unknown> } {
  return {
    path: `/rest/v1/agent_runs?idempotency_key=eq.${encodeURIComponent(devRunKey(executionId))}&status=eq.running`,
    body: {
      status: outcome,
      lease_owner: null,
      lease_until: null,
      error: error ? error.slice(0, 1_000) : null,
      completed_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
  };
}

const warn = (what: string, detail: unknown) =>
  console.warn(`${LOG_PREFIX} ${what} failed:`, detail instanceof Error ? detail.message : detail);

/**
 * Write the lease when an execution is claimed. Gated on the flag. An existing
 * row for the same execution (a retried claim) is overwritten — the claim on
 * `dev_autopilot_executions` is already atomic, so the claimer is the owner.
 */
export async function acquireDevRunLease(
  rest: LeaseRest,
  exec: DevExecutionForLease,
  opts: { vtid?: string | null; env?: NodeJS.ProcessEnv; owner?: string; now?: Date } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (!isRunLeaseEnabled(env) || !UUID_RE.test(exec.id)) return false;
  try {
    const row = buildDevRunLeaseRow(exec, opts.owner ?? leaseOwnerId(env), { vtid: opts.vtid, now: opts.now });
    const r = await rest('/rest/v1/agent_runs?on_conflict=idempotency_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok) { warn('acquire', r.error); return false; }
    return true;
  } catch (err) { warn('acquire', err); return false; }
}

/** Move the lease ahead of the clock. Gated; a renew against no row updates nothing. */
export async function renewDevRunLease(
  rest: LeaseRest,
  executionId: string,
  opts: { env?: NodeJS.ProcessEnv; owner?: string; now?: Date } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (!isRunLeaseEnabled(env) || !UUID_RE.test(executionId)) return false;
  try {
    const { path, body } = renewRequest(executionId, opts.owner ?? leaseOwnerId(env), runLeaseTtlMs(env), opts.now);
    const r = await rest(path, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) { warn('renew', r.error); return false; }
    return true;
  } catch (err) { warn('renew', err); return false; }
}

/** Close the lease when the running phase ends. Idempotent (scoped to status=running); callers gate on the flag. */
export async function releaseDevRunLease(
  rest: LeaseRest,
  executionId: string,
  outcome: RunPhaseOutcome,
  error: string | null = null,
  now?: Date,
): Promise<boolean> {
  if (!UUID_RE.test(executionId)) return false;
  try {
    const { path, body } = releaseRequest(executionId, outcome, error, now);
    const r = await rest(path, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) { warn('release', r.error); return false; }
    return true;
  } catch (err) { warn('release', err); return false; }
}

/**
 * Read the leases for a set of executions. Returns null when the read fails —
 * the caller must then treat every row as having no lease (legacy rule).
 */
export async function readDevRunLeases(
  rest: LeaseRest,
  executionIds: string[],
): Promise<Map<string, LeaseState> | null> {
  const ids = executionIds.filter((id) => UUID_RE.test(id));
  const out = new Map<string, LeaseState>();
  if (ids.length === 0) return out;
  try {
    const keys = ids.map((id) => `"${devRunKey(id)}"`).join(',');
    const r = await rest<Array<{ idempotency_key: string; lease_owner: string | null; lease_until: string | null }>>(
      `/rest/v1/agent_runs?idempotency_key=in.(${encodeURIComponent(keys)})&status=eq.running&select=idempotency_key,lease_owner,lease_until`,
    );
    if (!r.ok) { warn('read', r.error); return null; }
    for (const row of r.data || []) {
      const id = row.idempotency_key.slice(DEV_RUN_PLANE.length + 1);
      out.set(id, { lease_owner: row.lease_owner, lease_until: row.lease_until });
    }
    return out;
  } catch (err) { warn('read', err); return null; }
}

export type WatchdogDecision =
  | { action: 'skip'; reason: 'lease_live' | 'fresh' }
  | { action: 'reclaim'; reason: 'lease_expired' | 'legacy_stale' };

/**
 * Pure: should the running-watchdog reclaim this execution?
 *
 *   - live lease             → never (the run is stepping, whatever updated_at says);
 *   - expired lease          → reclaim;
 *   - no lease (flag off, a row claimed before the flag, a failed read)
 *                            → the legacy rule: `updated_at` older than 20 min.
 */
export function decideWatchdogReclaim(
  row: { updated_at: string },
  lease: LeaseState | null | undefined,
  now: Date = new Date(),
  legacyMs: number = LEGACY_STUCK_EXECUTION_MS,
): WatchdogDecision {
  if (lease) {
    return isLeaseLive(lease, now) ? { action: 'skip', reason: 'lease_live' } : { action: 'reclaim', reason: 'lease_expired' };
  }
  const t = Date.parse(row.updated_at);
  if (Number.isFinite(t) && now.getTime() - t > legacyMs) return { action: 'reclaim', reason: 'legacy_stale' };
  return { action: 'skip', reason: 'fresh' };
}

/**
 * The window the watchdog uses to pick candidates. With leases on it looks at
 * rows whose `updated_at` is older than the renew TTL (a heartbeating run bumps
 * it every minute, so a live one is never even a candidate); off, the legacy
 * 20 minutes.
 */
export function watchdogCandidateWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return isRunLeaseEnabled(env) ? runLeaseTtlMs(env) : LEGACY_STUCK_EXECUTION_MS;
}

/** Pure: the running phase's outcome from where the execution row went next. */
export function outcomeFromExecutionStatus(status: string | null | undefined): RunPhaseOutcome {
  if (!status) return 'failed';
  if (['failed', 'failed_escalated', 'reverted'].includes(status)) return 'failed';
  if (['cancelled', 'rejected', 'archived', 'auto_archived'].includes(status)) return 'cancelled';
  return 'succeeded';
}

export const LEASE_SWEEP_LIMIT = 20;

/**
 * Close expired leases whose execution already left `running` — the case an
 * executor task without the flag leaves behind (it never releases). Bounded,
 * fail-open. Returns how many were closed.
 */
export async function sweepOrphanDevRunLeases(rest: LeaseRest, now: Date = new Date()): Promise<number> {
  try {
    const r = await rest<Array<{ idempotency_key: string }>>(
      `/rest/v1/agent_runs?plane=eq.${DEV_RUN_PLANE}&status=eq.running&lease_until=lt.${encodeURIComponent(now.toISOString())}`
      + `&metadata->mirror_of=not.is.null&select=idempotency_key&limit=${LEASE_SWEEP_LIMIT}`,
    );
    if (!r.ok) { warn('sweep read', r.error); return 0; }
    const ids = (r.data || []).map((x) => x.idempotency_key.slice(DEV_RUN_PLANE.length + 1)).filter((id) => UUID_RE.test(id));
    if (ids.length === 0) return 0;
    const e = await rest<Array<{ id: string; status: string }>>(
      `/rest/v1/dev_autopilot_executions?id=in.(${ids.join(',')})&select=id,status`,
    );
    if (!e.ok) { warn('sweep executions', e.error); return 0; }
    const statusById = new Map((e.data || []).map((x) => [x.id, x.status]));
    let closed = 0;
    for (const id of ids) {
      const st = statusById.get(id);
      if (st === 'running') continue; // the watchdog decides running rows
      const ok = await releaseDevRunLease(rest, id, outcomeFromExecutionStatus(st), st ? null : 'execution row missing', now);
      if (ok) closed += 1;
    }
    return closed;
  } catch (err) { warn('sweep', err); return 0; }
}
