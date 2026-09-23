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
 * Persisting jobs as native agent_runs rows is P4.
 *
 * Cancel is cooperative: the job is marked cancelled and its result is
 * discarded; an agent that supports AbortSignal stops, one that does not
 * runs to the end unseen.
 */

import { randomUUID } from 'crypto';
import type { OrbSurface } from '../../orb/live/surface';
import type { AgentChannel } from './context';
import { evaluatePolicy, type PolicyDecision, type PolicyDomain, type PolicyTier } from './policy';

export interface DelegationCaller {
  user_id: string | null;
  tenant_id: string | null;
  platform_role: string | null;
  exafy_admin: boolean;
  surface: OrbSurface;
  channel: AgentChannel;
  session_id: string | null;
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

interface JobEntry { job: DelegationJob; controller: AbortController; expires: number }
const jobs = new Map<string, JobEntry>();

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
  | { status: 'done'; job_id: string; agent_id: string; result: unknown }
  | { status: 'working'; job_id: string; agent_id: string; note: string }
  | { status: 'failed'; job_id: string; agent_id: string; error: string }
  | { status: 'escalate'; agent_id: string; policy: PolicyDecision; note: string }
  | { status: 'refused'; agent_id: string; error: string; policy?: PolicyDecision };

export interface DelegateOptions {
  ackWindowMs?: number;
  now?: () => number;
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

  const policy = evaluatePolicy({ platform_role: caller.platform_role, orgs: [], channel: caller.channel }, target.domain, target.tier);
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
  const controller = new AbortController();
  const job: DelegationJob = {
    job_id: randomUUID(), agent_id: agentId, user_id: caller.user_id, surface: caller.surface,
    session_id: caller.session_id, status: 'running', request: text.slice(0, MAX_REQUEST_CHARS),
    result: null, error: null, created_at: new Date(now()).toISOString(), completed_at: null,
  };
  jobs.set(job.job_id, { job, controller, expires: now() + JOB_TTL_MS });

  const finish = (status: JobStatus, result: unknown, error: string | null) => {
    if (job.status !== 'running') return; // cancelled: discard
    job.status = status;
    job.result = result;
    job.error = error;
    job.completed_at = new Date(now()).toISOString();
  };
  const run = Promise.resolve()
    .then(() => target.run(job.request, caller, controller.signal))
    .then(
      (o) => finish(o.ok ? 'succeeded' : 'failed', o.ok ? o.result : null, o.ok ? null : o.error ?? 'agent reported failure'),
      (e: unknown) => finish('failed', null, e instanceof Error ? e.message : String(e)),
    );

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
  return { ok: true, status: 'cancelled' };
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
