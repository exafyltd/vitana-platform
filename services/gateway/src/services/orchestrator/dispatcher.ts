/**
 * VTID-04375 (Orchestrator v2, P3): the dispatcher behind
 * `delegate_to_agent(agent_id, request)` (docs/ORCHESTRATOR-REDESIGN-PLAN.md
 * §3.4 patterns 2 and 3, §5 P3).
 *
 * Generalises `operator_delegate` (VTID-04310), which blocked a voice turn
 * for up to 25 s. A delegation here:
 *   1. resolves the target agent and checks the caller's surface is one the
 *      agent serves;
 *   2. runs the capability policy for the target's domain/tier on the
 *      caller's channel (policy.ts) — deny stops it, escalate is returned
 *      to the caller as "confirm in chat/web" without running anything;
 *   3. starts the agent as an async job and waits a bounded ack window
 *      (1.5 s for voice, plan §6 latency budget). Done in time → the result
 *      now. Not done → an acknowledgement with a job id; the result is
 *      fetched on a later turn (getJob) or cancelled (cancelJob).
 *
 * Isolation (plan P3 exit criterion "a result created as backoffice is not
 * spoken in a community session"): a job is readable and cancellable only by
 * the same user on the same surface it was created on.
 *
 * Jobs live in process memory, bounded, with a TTL. ORB sessions are pinned
 * to one gateway task, so the job is on the task that serves the session.
 * VTID-04415: with ORCHESTRATOR_DELEGATION_PERSIST_ENABLED each job is also
 * written through to `agent_runs` (delegation-run-store.ts); `findJob` /
 * `latestJob` read it when this task does not hold the job, under the same
 * owner rules. Memory stays primary; the store is fail-open.
 *
 * Cancel is cooperative: the job is marked cancelled and its result is
 * discarded; an agent that supports AbortSignal stops, one that does not
 * runs to the end unseen.
 */

import { randomUUID } from 'crypto';
import type { OrbSurface } from '../../orb/live/surface';
import type { AgentChannel, AgentOrgContext } from './context';
import { evaluatePolicy, type PolicyDecision, type PolicyDomain, type PolicyTier } from './policy';
import { defaultDelegationRunStore, type DelegationRunStore } from './delegation-run-store';

export interface DelegationCaller {
  user_id: string | null;
  tenant_id: string | null;
  platform_role: string | null;
  exafy_admin: boolean;
  surface: OrbSurface;
  channel: AgentChannel;
  session_id: string | null;
  /**
   * VTID-04400: the caller's partner-organization memberships. Commerce
   * authority comes only from these (policy.ts roleCeiling); omitted means
   * none, so a commerce agent is refused.
   */
  orgs?: AgentOrgContext[];
  /** Transport-specific data an adapter needs (e.g. the operator thread id). */
  extras?: Record<string, unknown>;
}

export interface DelegationOutcome {
  ok: boolean;
  /** Short, model-readable result; never a finished spoken sentence. */
  result: unknown;
  error?: string;
}

export interface DelegationTarget {
  agent_id: string;
  description: string;
  surfaces: readonly OrbSurface[];
  domain: PolicyDomain;
  /** Tier the delegation itself requests. The agent's own commits keep their own gates. */
  tier: Exclude<PolicyTier, 'none'>;
  run: (request: string, caller: DelegationCaller, signal: AbortSignal) => Promise<DelegationOutcome>;
}

const targets = new Map<string, DelegationTarget>();

export function registerDelegationTarget(t: DelegationTarget): void {
  targets.set(t.agent_id, t);
}

export function listDelegationTargets(surface?: OrbSurface): Array<Pick<DelegationTarget, 'agent_id' | 'description' | 'surfaces' | 'domain' | 'tier'>> {
  return [...targets.values()]
    .filter((t) => !surface || t.surfaces.includes(surface))
    .map(({ agent_id, description, surfaces, domain, tier }) => ({ agent_id, description, surfaces, domain, tier }));
}

/** Test helper. */
export function clearDelegationTargets(): void {
  targets.clear();
}

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface DelegationJob {
  job_id: string;
  agent_id: string;
  user_id: string | null;
  surface: OrbSurface;
  session_id: string | null;
  status: JobStatus;
  request: string;
  result: unknown;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export const ACK_WINDOW_MS: Readonly<Record<AgentChannel, number>> = Object.freeze({
  voice: 1_500, chat: 8_000, web: 8_000, system: 30_000, ci: 30_000,
});
export const JOB_TTL_MS = 60 * 60 * 1000;
export const MAX_JOBS = 1_000;
export const MAX_REQUEST_CHARS = 4_000;

interface JobEntry { job: DelegationJob; controller: AbortController; expires: number; persisted: Promise<void>; done: Promise<void> }
const jobs = new Map<string, JobEntry>();

// undefined = not resolved yet (read the env on first use); null = off.
let runStore: DelegationRunStore | null | undefined;

/** Inject the run store (tests), or pass undefined to re-read the env. */
export function setDelegationRunStore(store: DelegationRunStore | null | undefined): void {
  runStore = store;
}

function activeRunStore(): DelegationRunStore | null {
  if (runStore === undefined) runStore = defaultDelegationRunStore();
  return runStore;
}

function persistFinish(entry: JobEntry): void {
  const store = activeRunStore();
  if (!store) return;
  const snapshot = { ...entry.job };
  // After the insert, never before: a job can finish inside the ack window.
  entry.persisted = entry.persisted.then(() => store.recordFinish(snapshot)).catch(() => undefined);
}

function prune(now: number): void {
  for (const [id, e] of jobs) if (e.expires <= now) jobs.delete(id);
  if (jobs.size < MAX_JOBS) return;
  // Oldest finished first, then oldest running.
  const order = [...jobs.entries()].sort(([, a], [, b]) =>
    Number(a.job.status === 'running') - Number(b.job.status === 'running') || a.job.created_at.localeCompare(b.job.created_at));
  for (const [id, e] of order) {
    if (jobs.size < MAX_JOBS) break;
    if (e.job.status === 'running') e.controller.abort();
    jobs.delete(id);
  }
}

/** Test helper. */
export function resetDelegationJobs(): void {
  for (const e of jobs.values()) e.controller.abort();
  jobs.clear();
}

export type DelegateResponse =
  | { status: 'done'; job_id: string; agent_id: string; result: unknown; reused?: boolean }
  | { status: 'working'; job_id: string; agent_id: string; note: string; reused?: boolean }
  | { status: 'failed'; job_id: string; agent_id: string; error: string }
  | { status: 'escalate'; agent_id: string; policy: PolicyDecision; note: string }
  | { status: 'refused'; agent_id: string; error: string; policy?: PolicyDecision };

export interface DelegateOptions {
  ackWindowMs?: number;
  now?: () => number;
  /**
   * VTID-04603: reuse, instead of starting, a job for the same agent, user,
   * surface and session that is still running or finished less than this many
   * ms ago. Live staging showed the model asking a specialist twice in one
   * turn (reworded), doubling cost and latency. 0/undefined = never reuse.
   */
  reuseWithinMs?: number;
}

/** VTID-04603: a job this call may reuse, or null. */
export function findReusableJob(
  agentId: string,
  caller: Pick<DelegationCaller, 'user_id' | 'surface' | 'session_id'>,
  withinMs: number,
  nowMs: number,
): JobEntry | null {
  if (!withinMs || withinMs <= 0 || !caller.user_id || !caller.session_id) return null;
  let best: JobEntry | null = null;
  for (const e of jobs.values()) {
    const j = e.job;
    if (j.agent_id !== agentId || j.user_id !== caller.user_id || j.surface !== caller.surface || j.session_id !== caller.session_id) continue;
    if (j.status === 'cancelled' || j.status === 'failed') continue;
    if (j.status !== 'running') {
      const done = j.completed_at ? Date.parse(j.completed_at) : NaN;
      if (!Number.isFinite(done) || nowMs - done > withinMs) continue;
    }
    if (!best || j.created_at > best.job.created_at) best = e;
  }
  return best;
}

export async function delegateToAgent(
  agentId: string,
  request: string,
  caller: DelegationCaller,
  opts: DelegateOptions = {},
): Promise<DelegateResponse> {
  const target = targets.get(agentId);
  if (!target) {
    const known = listDelegationTargets(caller.surface).map((t) => t.agent_id);
    return { status: 'refused', agent_id: agentId, error: `unknown agent '${agentId}'${known.length ? `; available here: ${known.join(', ')}` : ''}` };
  }
  if (!target.surfaces.includes(caller.surface)) {
    return { status: 'refused', agent_id: agentId, error: `agent '${agentId}' is not available on the ${caller.surface} surface` };
  }
  if (!caller.user_id) {
    return { status: 'refused', agent_id: agentId, error: 'sign in to delegate work to an agent' };
  }
  const text = (request || '').trim();
  if (!text) return { status: 'refused', agent_id: agentId, error: 'request is required' };

  const policy = evaluatePolicy({ platform_role: caller.platform_role, orgs: caller.orgs ?? [], channel: caller.channel }, target.domain, target.tier);
  if (policy.decision === 'deny') {
    return { status: 'refused', agent_id: agentId, error: policy.reason, policy };
  }
  if (policy.decision === 'escalate') {
    return {
      status: 'escalate', agent_id: agentId, policy,
      note: 'This needs confirmation on a screen, not by voice. Tell the user where to confirm it.',
    };
  }

  const now = opts.now ?? Date.now;
  prune(now());

  const reuse = findReusableJob(agentId, caller, opts.reuseWithinMs ?? 0, now());
  if (reuse) {
    const waitMs = opts.ackWindowMs ?? ACK_WINDOW_MS[caller.channel] ?? ACK_WINDOW_MS.web;
    if (reuse.job.status === 'running') {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        reuse.done,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); (timer as { unref?: () => void }).unref?.(); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    const j = reuse.job;
    if (j.status === 'succeeded') return { status: 'done', job_id: j.job_id, agent_id: agentId, result: j.result, reused: true };
    if (j.status === 'failed') return { status: 'failed', job_id: j.job_id, agent_id: agentId, error: j.error ?? 'failed' };
    return {
      status: 'working', job_id: j.job_id, agent_id: agentId, reused: true,
      note: 'The same lookup is already running. Do not ask again; fetch the result later with this job id.',
    };
  }

  const controller = new AbortController();
  const job: DelegationJob = {
    job_id: randomUUID(), agent_id: agentId, user_id: caller.user_id, surface: caller.surface,
    session_id: caller.session_id, status: 'running', request: text.slice(0, MAX_REQUEST_CHARS),
    result: null, error: null, created_at: new Date(now()).toISOString(), completed_at: null,
  };
  const store = activeRunStore();
  const entry: JobEntry = {
    job, controller, expires: now() + JOB_TTL_MS,
    persisted: store
      ? store.recordStart({ ...job }, { tenant_id: caller.tenant_id, platform_role: caller.platform_role, channel: caller.channel }, target.tier)
        .catch(() => undefined)
      : Promise.resolve(),
    done: Promise.resolve(),
  };
  jobs.set(job.job_id, entry);

  const finish = (status: JobStatus, result: unknown, error: string | null) => {
    if (job.status !== 'running') return; // cancelled: discard
    job.status = status;
    job.result = result;
    job.error = error;
    job.completed_at = new Date(now()).toISOString();
    persistFinish(entry);
  };
  const run = Promise.resolve()
    .then(() => target.run(job.request, caller, controller.signal))
    .then(
      (o) => finish(o.ok ? 'succeeded' : 'failed', o.ok ? o.result : null, o.ok ? null : o.error ?? 'agent reported failure'),
      (e: unknown) => finish('failed', null, e instanceof Error ? e.message : String(e)),
    );
  entry.done = run;

  const waitMs = opts.ackWindowMs ?? ACK_WINDOW_MS[caller.channel] ?? ACK_WINDOW_MS.web;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    run,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); (timer as { unref?: () => void }).unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);

  if (job.status === 'succeeded') return { status: 'done', job_id: job.job_id, agent_id: agentId, result: job.result };
  if (job.status === 'failed') return { status: 'failed', job_id: job.job_id, agent_id: agentId, error: job.error ?? 'failed' };
  return {
    status: 'working', job_id: job.job_id, agent_id: agentId,
    note: 'The agent is still working. Acknowledge briefly and move on; fetch the result later with the job id when the user asks or the conversation allows.',
  };
}

function owned(jobId: string, caller: Pick<DelegationCaller, 'user_id' | 'surface'>): JobEntry | null {
  const e = jobs.get(jobId);
  if (!e) return null;
  if (!caller.user_id || e.job.user_id !== caller.user_id || e.job.surface !== caller.surface) return null;
  return e;
}

/** A job, only for the same user on the same surface. Anything else reads as not found. */
export function getJob(jobId: string, caller: Pick<DelegationCaller, 'user_id' | 'surface'>): DelegationJob | null {
  const e = owned(jobId, caller);
  return e ? { ...e.job } : null;
}

/** The caller's jobs on this surface, newest first. */
export function listJobs(caller: Pick<DelegationCaller, 'user_id' | 'surface'>, limit = 10): DelegationJob[] {
  if (!caller.user_id) return [];
  return [...jobs.values()]
    .map((e) => e.job)
    .filter((j) => j.user_id === caller.user_id && j.surface === caller.surface)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((j) => ({ ...j }));
}

export function cancelJob(jobId: string, caller: Pick<DelegationCaller, 'user_id' | 'surface'>): { ok: boolean; status: JobStatus | null; error?: string } {
  const e = owned(jobId, caller);
  if (!e) return { ok: false, status: null, error: 'job not found' };
  if (e.job.status !== 'running') return { ok: false, status: e.job.status, error: `job already ${e.job.status}` };
  e.job.status = 'cancelled';
  e.job.completed_at = new Date().toISOString();
  e.controller.abort();
  persistFinish(e);
  return { ok: true, status: 'cancelled' };
}

/**
 * VTID-04415: `getJob`, falling back to the run ledger when this task does
 * not hold the job (the session that started it ran on another task). Same
 * owner rules: same user, same surface.
 */
export async function findJob(jobId: string, caller: Pick<DelegationCaller, 'user_id' | 'surface'>): Promise<DelegationJob | null> {
  const local = getJob(jobId, caller);
  if (local || !caller.user_id) return local;
  const store = activeRunStore();
  if (!store) return null;
  const row = await store.find(jobId, { user_id: caller.user_id, surface: caller.surface });
  return row && row.user_id === caller.user_id && row.surface === caller.surface ? { ...row } : null;
}

/** VTID-04415: the caller's most recent job on this surface, here or in the run ledger. */
export async function latestJob(caller: Pick<DelegationCaller, 'user_id' | 'surface'>): Promise<DelegationJob | null> {
  const local = listJobs(caller, 1)[0] ?? null;
  if (!caller.user_id) return local;
  const store = activeRunStore();
  if (!store) return local;
  const row = await store.latest({ user_id: caller.user_id, surface: caller.surface });
  if (!row || row.user_id !== caller.user_id || row.surface !== caller.surface) return local;
  if (!local) return { ...row };
  // Newest wins; a local copy of the same job is fresher than the row.
  if (row.job_id === local.job_id) return local;
  return row.created_at > local.created_at ? { ...row } : local;
}

/** Admin view: counts by agent and status, no request text or results. */
export function jobStats(): { total: number; by_agent: Record<string, Record<JobStatus, number>> } {
  const by_agent: Record<string, Record<JobStatus, number>> = {};
  for (const { job } of jobs.values()) {
    by_agent[job.agent_id] ??= { running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    by_agent[job.agent_id][job.status]++;
  }
  return { total: jobs.size, by_agent };
}
