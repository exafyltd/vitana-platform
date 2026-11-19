/**
 * Delivery loop, poll: GitLab's own state as the facts the webhook would have recorded.
 *
 * Two reasons it exists. The settings schema forbids a webhook on a rehearsal project (a rehearsal project never talks to a gateway),
 * so there the poller is the only intake. And a webhook delivery can be lost (a gateway deploy, a GitLab retry window that ran out), so
 * on the projects that do have one the poller is a net under it that costs a few reads.
 *
 * It writes the SAME rows under the SAME dedupe keys as the webhook stage (`gitlab:<project>:pipeline:<id>:failed`), so a fact seen
 * by both is one row (the ledger's idempotent insert); the issue facts have a key of their own and the intake handler, which is
 * idempotent by issue, makes a second fact for one issue harmless. The window is `since` (the poller's last successful poll, with an
 * overlap), so a quiet project costs one read per kind.
 */
import { intakeLabelOf } from '../gitlab-events/delivery-mapper';
import { ownsBranch } from './controls';
import { T } from './keys';
import { find, may, must, record, type Ctx } from './context';
import { issueVersion } from './intake';
import type { GitlabPipeline } from './types';

export const POLL_OVERLAP_MS = 2 * 60 * 1000;
/** The first poll after a start looks this far back; the keys make a repeat free. */
export const POLL_FIRST_WINDOW_MS = 6 * 60 * 60 * 1000;
export const MAX_POLLED_PIPELINES = 30;

export interface PollState {
  /** Per project and kind: where the next poll starts, ISO. Held in the process; a restart looks back POLL_FIRST_WINDOW_MS once. */
  since: Map<string, string>;
}
export const newPollState = (): PollState => ({ since: new Map() });

const MR_REF_RE = /^refs\/merge-requests\/(\d+)\/head$/;

export async function pollProjects(ctx: Ctx, state: PollState): Promise<void> {
  if (!may(ctx, 'record')) return;
  for (const project of ctx.controls.projects) {
    await pollIssues(ctx, state, project);
    await pollPipelines(ctx, state, project, 'failed');
    await pollPipelines(ctx, state, project, 'success');
  }
}

function window(ctx: Ctx, state: PollState, key: string): { since: string; startedAt: string } {
  const now = ctx.deps.now();
  return { since: state.since.get(key) ?? new Date(now - POLL_FIRST_WINDOW_MS).toISOString(), startedAt: new Date(now - POLL_OVERLAP_MS).toISOString() };
}

async function pollIssues(ctx: Ctx, state: PollState, project: string): Promise<void> {
  const k = `issues:${project}`;
  const w = window(ctx, state, k);
  const intake = intakeLabelOf(ctx.env);
  const issues = must('gitlab.listIssues', await ctx.deps.gitlab.listIssues(project, { labels: [intake], state: 'opened', updatedAfter: w.since })) ?? [];
  for (const i of issues) {
    // An issue the loop accepted is not announced again.
    if ((await find(ctx, T.intakeAccepted, { project, issue_iid: i.iid }, { limit: 1 })).length > 0) continue;

    // The fact is keyed by the VERSION of the issue (what its author can change: the description, confidentiality, who applied the
    // label), never by `updated_at`: the loop's own note and label move `updated_at`, and a key that followed it would make the poller
    // announce every answered issue as new on every poll, forever. An edit that matters is a new version, hence a new fact.
    const events = must('gitlab.listIssueLabelEvents', await ctx.deps.gitlab.listIssueLabelEvents(project, i.iid)) ?? [];
    const version = issueVersion(i, events, intake);
    const rejected = await find(ctx, T.intakeRejected, { project, issue_iid: i.iid }, { limit: 5 });
    if (rejected.some((r) => r.metadata.version === version)) continue; // answered, and nothing the answer was about has changed

    const r = await record(ctx, {
      type: T.issueLabeled,
      status: 'info',
      message: `Polled issue #${i.iid} in ${project} (intake label present)`,
      payload: { gitlab_event: 'issue', source: 'poll', project_path: project, issue_iid: i.iid, issue_id: i.id, state: i.state, url: i.web_url, confidential: i.confidential, intake_label: intake, labels: i.labels.filter((l) => l === intake || /^(agent|delivery|priority)-/.test(l)).slice(0, 10), host: 'gitlab', version },
      key: `gitlab:${project}:issue:${i.iid}:poll:${version}`,
    });
    if (!r.duplicate) ctx.stats.polled += 1;
  }
  state.since.set(k, w.startedAt);
}

async function pollPipelines(ctx: Ctx, state: PollState, project: string, status: 'failed' | 'success'): Promise<void> {
  const k = `pipelines:${status}:${project}`;
  const w = window(ctx, state, k);
  const pipelines = (must('gitlab.listPipelines', await ctx.deps.gitlab.listPipelines(project, { status, updatedAfter: w.since })) ?? []).slice(-MAX_POLLED_PIPELINES);

  for (const p of pipelines) {
    const where = await whereRan(ctx, project, p);
    if (!where) continue;
    if (!ownsBranch(ctx.controls, where.branch, status === 'failed' ? 'heal' : 'review')) continue;
    const failedJobs =
      status === 'failed'
        ? (must('gitlab.listPipelineJobs', await ctx.deps.gitlab.listPipelineJobs(project, p.id, { failedOnly: true })) ?? [])
            .filter((j) => !j.allow_failure)
            .slice(0, 20)
            .map((j) => ({ id: j.id, name: j.name, stage: j.stage, failure_reason: j.failure_reason, exit_code: null }))
        : undefined;
    const r = await record(ctx, {
      type: status === 'failed' ? ('scm.gitlab.pipeline.failed' as const) : ('scm.gitlab.pipeline.succeeded' as const),
      status: status === 'failed' ? 'warning' : 'success',
      message: `Polled pipeline ${p.id} ${status === 'failed' ? 'failed' : 'succeeded'} on ${where.branch} in ${project}`,
      payload: {
        gitlab_event: 'pipeline', source: 'poll', host: 'gitlab', project_path: project, pipeline_id: p.id, status, ref: p.ref, sha: p.sha, url: p.web_url, tag: false,
        merge_request_iid: where.mr?.iid ?? null, mr_source_branch: where.mr?.source_branch ?? null, mr_target_branch: where.mr?.target_branch ?? null, mr_url: where.mr?.web_url ?? null,
        ...(failedJobs ? { failed_jobs: failedJobs } : {}),
      },
      // The webhook stage's key for the same fact: one row however many sources saw it.
      key: `gitlab:${project}:pipeline:${p.id}:${status}`,
    });
    if (!r.duplicate) ctx.stats.polled += 1;
  }
  state.since.set(k, w.startedAt);
}

/** The branch a pipeline ran on and its merge request: a branch pipeline is its ref, a merge request pipeline is read from the merge request. */
async function whereRan(ctx: Ctx, project: string, p: GitlabPipeline): Promise<{ branch: string; mr: { iid: number; source_branch: string; target_branch: string; web_url: string } | null } | null> {
  const m = MR_REF_RE.exec(p.ref);
  if (!m) return p.ref.startsWith('refs/') ? null : { branch: p.ref, mr: null };
  const mr = must('gitlab.getMergeRequest', await ctx.deps.gitlab.getMergeRequest(project, Number(m[1])), { allow404: true });
  if (mr === null) return null;
  return { branch: mr.source_branch, mr: { iid: mr.iid, source_branch: mr.source_branch, target_branch: mr.target_branch, web_url: mr.web_url } };
}
