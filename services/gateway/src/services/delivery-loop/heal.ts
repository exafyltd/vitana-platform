/**
 * Delivery loop, heal: a failed pipeline is detected, classified, and answered with a retry (the runner failed) or a repair (the
 * change failed), a bounded number of times, until a green pipeline verifies it or the budget is spent and a person is asked.
 *
 *   observe    scm.gitlab.pipeline.failed (the webhook stage or the poller), and the branch's own pipeline (the reconciler)
 *   reason     `decideHeal` (pure): the class of the failure, the evidence, the attempts used in the last 24 h on this branch
 *   plan       a detection row and an INTENT (retry_pipeline | run_task kind repair), recorded before it is carried out
 *   execute    `drive.ts` carries the intent out (L3, execution armed); a note on the merge request (L2)
 *   verify     `reconcile`: the branch's newest pipeline after the attempt: green verifies, red asks for the next attempt
 *
 * Why a reconciler and not only the webhook: a retried pipeline keeps its id, so its second failure is the same dedupe key and records
 * no new fact; and a lost delivery would otherwise stall a heal forever. The reconciler reads the branch's pipeline from GitLab, so the
 * loop always makes progress from GitLab's own state.
 *
 * What is never written to OASIS: the text of a log. A heal row has the fingerprint, the job names and the failure reason; the
 * instructions for the executor are built from GitLab when the intent is carried out.
 */
import { branchOf, type PipelineFact } from './facts';
import { fingerprintFailure, healKey as makeHealKey, type FailureFingerprint } from './fingerprint';
import { INTENT_TTL_MS, K, T } from './keys';
import { ownsBranch } from './controls';
import type { FailedJobFact, FailureClass, GitlabJob } from './types';
import { find, may, must, postNote, record, sinceMs, skip, type Ctx } from './context';
import { ensureIntent, intentsOf } from './intents';

/** The window attempts are counted in: a branch gets `healMaxAttempts` tries per day. */
export const HEAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long after an attempt started a branch may stay without a new pipeline before the attempt counts as failed. */
export const ATTEMPT_TIMEOUT_MS = { retry_pipeline: 20 * 60 * 1000, run_task: 60 * 60 * 1000 } as const;
export const MAX_TRACE_JOBS = 3;

export type HealDecision =
  | { kind: 'retry' }
  | { kind: 'repair' }
  | { kind: 'exhausted'; reason: 'budget_spent' | 'no_evidence' | 'unclassified_failure' };

/** Pure. What to do about a failure, given its class, whether the log gave evidence, and the attempts already used. */
export function decideHeal(i: { failureClass: FailureClass; hasEvidence: boolean; executed: number; max: number }): HealDecision {
  if (i.executed >= i.max) return { kind: 'exhausted', reason: 'budget_spent' };
  if (i.failureClass === 'unknown') return { kind: 'exhausted', reason: 'unclassified_failure' };
  if (i.failureClass === 'infra') return { kind: 'retry' };
  return i.hasEvidence ? { kind: 'repair' } : { kind: 'exhausted', reason: 'no_evidence' };
}

export const branchKey = (project: string, branch: string): string => `${project}|${branch}`;

/** A failed pipeline, from a webhook fact or from GitLab's own state. */
export interface FailedPipeline {
  project: string;
  branch: string;
  /** The pipeline's own ref (`refs/merge-requests/12/head` or a branch). */
  ref: string;
  pipeline_id: number;
  sha: string | null;
  url: string | null;
  mr_iid: number | null;
  mr_url: string | null;
  target_branch: string | null;
  lane_key: string | null;
  failed_jobs: FailedJobFact[];
  /** When the fact was recorded or the pipeline last moved; an attempt is only the cause of a failure that came after it. */
  at: string;
  source: 'fact' | 'reconcile';
}

export interface HealState {
  /** Attempts carried out on this branch in the window. */
  executed: number;
  lastStartedAt: string | null;
  /** The work key of the last started attempt. */
  lastWorkKey: string | null;
  exhausted: boolean;
  /** An intent for this branch that is open or waiting for a retry. */
  openIntent: boolean;
}

export async function healState(ctx: Ctx, project: string, branch: string): Promise<HealState> {
  const bk = branchKey(project, branch);
  const since = sinceMs(ctx, HEAL_WINDOW_MS);
  const attempts = (await find(ctx, T.healAttempt, { branch_key: bk }, { since, limit: 50 })).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const exhausted = (await find(ctx, T.healExhausted, { branch_key: bk }, { since, limit: 1 })).length > 0;
  const last = attempts[attempts.length - 1] ?? null;

  let openIntent = false;
  const requested = await find(ctx, T.requested, { branch_key: bk }, { since: sinceMs(ctx, INTENT_TTL_MS), limit: 20 });
  for (const w of new Set(requested.map((r) => String(r.metadata.work_key ?? '')))) {
    if (!w) continue;
    if ((await intentsOf(ctx, w)).some((i) => i.status === 'open' || i.status === 'retry_wait')) openIntent = true;
  }
  return { executed: attempts.length, lastStartedAt: last?.created_at ?? null, lastWorkKey: last ? String(last.metadata.work_key ?? '') : null, exhausted, openIntent };
}

// ---------------------------------------------------------------------------------------------------------
// From a fact
// ---------------------------------------------------------------------------------------------------------

export async function handleFailedPipeline(ctx: Ctx, f: PipelineFact): Promise<void> {
  if (!ctx.controls.projects.includes(f.project)) return skip(ctx, 'project_not_allowed');
  if (f.tag) return skip(ctx, 'tag_pipeline');
  const branch = branchOf(f);
  if (!ownsBranch(ctx.controls, branch, 'heal')) return skip(ctx, 'branch_not_owned');

  await evaluateFailure(ctx, {
    project: f.project,
    branch: branch as string,
    ref: f.ref,
    pipeline_id: f.pipeline_id,
    sha: f.sha,
    url: f.url,
    mr_iid: f.mr_iid,
    mr_url: f.mr_url,
    target_branch: f.mr_target_branch,
    lane_key: f.lane_key,
    failed_jobs: f.failed_jobs,
    at: f.event.created_at,
    source: 'fact',
  });
}

/**
 * The common core: classify the failure, record it, and ask for the next attempt or give up. Called with a webhook fact and by the
 * reconciler, so both answer the same way. Idempotent at every step.
 */
export async function evaluateFailure(ctx: Ctx, p: FailedPipeline): Promise<void> {
  const g = ctx.deps.gitlab;

  // A merge request that is closed or merged has nothing left to repair.
  if (p.mr_iid !== null) {
    const mr = must('gitlab.getMergeRequest', await g.getMergeRequest(p.project, p.mr_iid), { allow404: true });
    if (mr === null || mr.state !== 'opened') return skip(ctx, 'mr_not_open');
  }
  // A newer pipeline on the ref means the failure is already history: whoever pushed since has moved on.
  const latest = must('gitlab.latestPipeline', await g.latestPipeline(p.project, p.ref));
  if (latest && latest.id > p.pipeline_id) return skip(ctx, 'superseded');

  const state = await healState(ctx, p.project, p.branch);
  if (state.exhausted) return skip(ctx, 'exhausted');
  if (state.openIntent) return skip(ctx, 'intent_open');
  // A failure that happened before the last attempt started is not that attempt's result.
  if (state.lastStartedAt !== null && p.at <= state.lastStartedAt && p.source === 'fact') return skip(ctx, 'before_attempt');

  const jobs = p.failed_jobs.length > 0 ? p.failed_jobs : await failedJobsFromGitlab(ctx, p);
  const fp = await fingerprintOf(ctx, p, jobs);
  const hk = makeHealKey(p.project, p.branch, fp.fingerprint);

  await record(ctx, {
    type: T.healDetected,
    status: 'info',
    message: `Pipeline ${p.pipeline_id} of ${p.branch} failed in ${p.project}: ${fp.failure_class} failure`,
    payload: {
      project: p.project, branch: p.branch, branch_key: branchKey(p.project, p.branch), ref: p.ref, pipeline_id: p.pipeline_id, sha: p.sha, url: p.url,
      mr_iid: p.mr_iid, mr_url: p.mr_url, fingerprint: fp.fingerprint, heal_key: hk, failure_class: fp.failure_class, jobs: fp.jobs, has_evidence: fp.has_evidence, source: p.source,
    },
    key: K.healDetected(p.project, p.pipeline_id),
  });
  ctx.stats.decisions += 1;

  const decision = decideHeal({ failureClass: fp.failure_class, hasEvidence: fp.has_evidence, executed: state.executed, max: ctx.controls.healMaxAttempts });

  if (decision.kind === 'exhausted') return exhaust(ctx, p, fp, hk, decision.reason, state.executed);

  const action = decision.kind === 'retry' ? 'retry_pipeline' : 'run_task';
  const workKey = decision.kind === 'retry' ? K.workRetry(hk) : K.workRepair(hk);
  if (may(ctx, 'record')) {
    await ensureIntent(
      ctx,
      workKey,
      {
        action, kind: decision.kind === 'retry' ? 'retry' : 'repair', project: p.project, branch: p.branch, branch_key: branchKey(p.project, p.branch), ref: p.ref,
        pipeline_id: p.pipeline_id, sha: p.sha, mr_iid: p.mr_iid, mr_url: p.mr_url, base_branch: p.target_branch ?? 'main', fix_branch: p.branch === 'main' ? null : p.branch,
        fingerprint: fp.fingerprint, heal_key: hk, failure_class: fp.failure_class, jobs: fp.jobs,
      },
      `${decision.kind === 'retry' ? 'Retry' : 'Repair'} requested for pipeline ${p.pipeline_id} of ${p.branch} in ${p.project}`,
      'attempt',
    );
  }

  if (p.mr_iid !== null) {
    await postNote(ctx, {
      scope: `heal:${p.project}:${p.pipeline_id}:attempt-${state.executed + 1}`,
      project: p.project,
      target: 'mr',
      iid: p.mr_iid,
      body:
        decision.kind === 'retry'
          ? `Pipeline ${p.pipeline_id} failed for a reason on GitLab's side (${fp.jobs.join(', ')}). The delivery loop retries its failed jobs (attempt ${state.executed + 1} of ${ctx.controls.healMaxAttempts}).`
          : `Pipeline ${p.pipeline_id} failed in ${fp.jobs.join(', ')}. The delivery loop prepares a repair on this branch (attempt ${state.executed + 1} of ${ctx.controls.healMaxAttempts}).`,
    });
  }
}

async function failedJobsFromGitlab(ctx: Ctx, p: FailedPipeline): Promise<FailedJobFact[]> {
  const jobs: GitlabJob[] = must('gitlab.listPipelineJobs', await ctx.deps.gitlab.listPipelineJobs(p.project, p.pipeline_id, { failedOnly: true })) ?? [];
  return jobs.filter((j) => !j.allow_failure).map((j) => ({ id: j.id, name: j.name, stage: j.stage, failure_reason: j.failure_reason, exit_code: null }));
}

/**
 * The fingerprint of the failure, reading the tail of the log of each failed job that has one (at most MAX_TRACE_JOBS). A log that
 * GitLab no longer has (404) is no evidence; any other failure to read one is the world's, not the failure's, and stops the step so
 * a GitLab outage is never mistaken for "this failure has no evidence".
 */
async function fingerprintOf(ctx: Ctx, p: FailedPipeline, jobs: FailedJobFact[]): Promise<FailureFingerprint> {
  const traces: Record<string, string> = {};
  for (const j of jobs.filter((x) => x.id !== null && x.failure_reason === 'script_failure').slice(0, MAX_TRACE_JOBS)) {
    const t = await ctx.deps.gitlab.getJobTrace(p.project, j.id as number);
    if (t.ok) traces[String(j.id)] = t.data;
    else if (t.status !== 404) must('gitlab.getJobTrace', t);
  }
  return fingerprintFailure({ project: p.project, failedJobs: jobs, traces });
}

async function exhaust(ctx: Ctx, p: FailedPipeline, fp: FailureFingerprint, hk: string, reason: string, attempts: number): Promise<void> {
  const day = Math.floor(ctx.deps.now() / HEAL_WINDOW_MS);
  const written = await record(ctx, {
    type: T.healExhausted,
    status: 'warning',
    message: `Repair of ${p.branch} in ${p.project} stopped: ${reason}`,
    payload: { project: p.project, branch: p.branch, branch_key: branchKey(p.project, p.branch), heal_key: hk, fingerprint: fp.fingerprint, failure_class: fp.failure_class, jobs: fp.jobs, reason, attempts, mr_iid: p.mr_iid, mr_url: p.mr_url, pipeline_id: p.pipeline_id },
    key: `${K.healExhausted(hk)}:${day}`,
  });
  if (!written.duplicate) ctx.stats.exhausted += 1;
  if (p.mr_iid !== null) {
    await postNote(ctx, {
      scope: `heal:exhausted:${hk}:${day}`,
      project: p.project,
      target: 'mr',
      iid: p.mr_iid,
      body: `The delivery loop stops repairing this branch: ${EXHAUSTED_TEXT[reason] ?? reason}${attemptsText(attempts)} A person needs to look at pipeline ${p.pipeline_id}.`,
    });
  }
}

const EXHAUSTED_TEXT: Record<string, string> = {
  budget_spent: 'the attempts for today are used up.',
  no_evidence: 'the log of the failed job gave nothing to repair from.',
  unclassified_failure: 'GitLab does not say why the job failed, so the loop cannot tell a retry from a repair.',
};
const attemptsText = (n: number): string => (n > 0 ? ` (${n} attempt${n === 1 ? '' : 's'} made.)` : '');

// ---------------------------------------------------------------------------------------------------------
// From GitLab's state: verify and move on
// ---------------------------------------------------------------------------------------------------------

/**
 * For every branch with a started attempt that has no end yet, reads the branch's newest pipeline: green verifies the heal, red is the
 * attempt's result (ask for the next one or give up), anything still running is waited for, and a branch that shows no pipeline after
 * the attempt's timeout counts as a failed attempt. Bounded to the attempts of the last 24 h.
 */
export async function reconcileHeals(ctx: Ctx): Promise<void> {
  const since = sinceMs(ctx, HEAL_WINDOW_MS);
  const attempts = (await find(ctx, T.healAttempt, {}, { since, limit: 100 })).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const latestByBranch = new Map<string, (typeof attempts)[number]>();
  for (const a of attempts) latestByBranch.set(String(a.metadata.branch_key), a);

  for (const [bk, attempt] of latestByBranch) {
    const m = attempt.metadata;
    const project = String(m.project);
    const branch = String(m.branch);
    if (!ctx.controls.projects.includes(project)) continue;

    if (!ownsBranch(ctx.controls, branch, 'heal')) continue;

    // Ended already: verified, or given up, after this attempt. (A newer intent for the branch is handled by evaluateFailure's own guard.)
    const hk = String(m.heal_key ?? '');
    if (hk && (await find(ctx, T.healVerified, { heal_key: hk }, { since: attempt.created_at, limit: 1 })).length > 0) continue;
    if ((await find(ctx, T.healExhausted, { branch_key: bk }, { since: attempt.created_at, limit: 1 })).length > 0) continue;

    const ref = String(m.ref ?? branch);
    const latest = must('gitlab.latestPipeline', await ctx.deps.gitlab.latestPipeline(project, ref));
    const action = m.action === 'retry_pipeline' ? 'retry_pipeline' : 'run_task';
    const timedOut = ctx.deps.now() - Date.parse(attempt.created_at) > ATTEMPT_TIMEOUT_MS[action];

    const movedAfter = latest !== null && (Date.parse(latest.updated_at || latest.created_at) > Date.parse(attempt.created_at) || latest.id > Number(m.pipeline_id ?? 0));

    if (latest && movedAfter && latest.status === 'success') {
      await verify(ctx, attempt.metadata, latest.id, latest.sha);
      continue;
    }
    const from = (id: number, sha: string | null, url: string | null): FailedPipeline => ({
      project, branch, ref, pipeline_id: id, sha, url,
      mr_iid: typeof m.mr_iid === 'number' ? m.mr_iid : null, mr_url: typeof m.mr_url === 'string' ? m.mr_url : null, target_branch: typeof m.base_branch === 'string' ? m.base_branch : null,
      lane_key: null, failed_jobs: [], at: new Date(ctx.deps.now()).toISOString(), source: 'reconcile',
    });
    if (latest && movedAfter && latest.status === 'failed') {
      await evaluateFailure(ctx, from(latest.id, latest.sha, latest.web_url));
      continue;
    }
    const stillRunning = latest !== null && movedAfter && IN_PROGRESS.has(latest.status);
    if (timedOut && !stillRunning) {
      // Nothing came of the attempt: no pipeline ran after it. It counts as spent; the failing pipeline is judged again, and the budget
      // ends the loop of attempts.
      await evaluateFailure(ctx, from(latest?.id ?? Number(m.pipeline_id ?? 0), latest?.sha ?? null, latest?.web_url ?? null));
    }
  }
}

const IN_PROGRESS: ReadonlySet<string> = new Set(['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled']);

/** A green pipeline after an attempt: the heal is verified. Idempotent by the heal key. */
async function verify(ctx: Ctx, attempt: Record<string, unknown>, pipelineId: number, sha: string): Promise<void> {
  const hk = String(attempt.heal_key ?? '');
  const written = await record(ctx, {
    type: T.healVerified,
    status: 'success',
    message: `Pipeline ${pipelineId} of ${String(attempt.branch)} is green after the repair in ${String(attempt.project)}`,
    payload: {
      project: attempt.project, branch: attempt.branch, branch_key: attempt.branch_key, heal_key: hk, fingerprint: attempt.fingerprint, work_key: attempt.work_key,
      attempts: attempt.attempt, pipeline_id: pipelineId, sha, failed_sha: attempt.sha ?? null, changed: typeof attempt.sha === 'string' ? attempt.sha !== sha : null,
      mr_iid: attempt.mr_iid ?? null, mr_url: attempt.mr_url ?? null, action: attempt.action, failure_class: attempt.failure_class, jobs: attempt.jobs ?? [],
    },
    key: `${K.healVerified(hk)}:${String(attempt.intent_key ?? pipelineId)}`,
  });
  if (!written.duplicate) ctx.stats.verified += 1;
  if (typeof attempt.mr_iid === 'number') {
    await postNote(ctx, {
      scope: `heal:verified:${hk}:${String(attempt.intent_key ?? '')}`,
      project: String(attempt.project),
      target: 'mr',
      iid: attempt.mr_iid,
      body: `Pipeline ${pipelineId} is green again. The delivery loop records what it learned from it.`,
    });
  }
}
