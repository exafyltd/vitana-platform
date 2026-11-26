/**
 * Delivery loop, review: a merge request of a branch the loop owns is reviewed once its pipeline is green, and a verdict of "changes"
 * becomes a rework, a bounded number of times, then a person.
 *
 *   observe   scm.gitlab.pipeline.succeeded on an owned branch with an open merge request that is not a draft
 *   reason    `decideReview` (pure): reviewed for this head already? rounds of rework used?
 *   plan      a review row, the reviewer's verdict, and for "changes" a rework INTENT recorded before it is carried out
 *   execute   the verdict as a note on the merge request (L2 and up); the rework by `drive.ts` (L3, armed)
 *
 * What a verdict is worth: it is about ONE head commit. A verdict on a head that has moved on is recorded and ignored, and a rework
 * intent whose merge request head moved is closed without action by `drive.ts`. The loop does not merge: acceptance here is a note
 * and a row; the merge bot lands lane merge requests on its own review commit, and a merge of any other merge request is the project's.
 */
import type { PipelineFact } from './facts';
import { branchOf } from './facts';
import { ownsBranch } from './controls';
import { K, T } from './keys';
import { LoopError, find, may, must, postNote, record, skip, spend, type Ctx } from './context';
import { ensureIntent } from './intents';
import { branchKey } from './heal';
import type { ReviewVerdict } from './ports';

export const MAX_FINDINGS = 12;
export const MAX_DIFF_CHARS = 120_000;

export type ReviewDecision = { kind: 'review' } | { kind: 'skip'; reason: string };

/** Pure. Whether this head of this merge request needs a review now. */
export function decideReview(i: { draft: boolean; state: string; head: string | null; pipelineSha: string | null; alreadyReviewed: boolean }): ReviewDecision {
  if (i.state !== 'opened') return { kind: 'skip', reason: 'mr_not_open' };
  if (i.draft) return { kind: 'skip', reason: 'mr_is_draft' };
  if (!i.head) return { kind: 'skip', reason: 'no_head' };
  // The green pipeline must be the one of the head: a green pipeline of an older commit proves nothing about this one.
  if (i.pipelineSha !== null && i.pipelineSha !== i.head) return { kind: 'skip', reason: 'pipeline_not_for_head' };
  if (i.alreadyReviewed) return { kind: 'skip', reason: 'already_reviewed' };
  return { kind: 'review' };
}

export type VerdictDecision = { kind: 'accepted' } | { kind: 'rework'; round: number } | { kind: 'escalate' };

/** Pure. What follows a verdict. */
export function decideVerdict(i: { verdict: 'accept' | 'changes'; reworkRounds: number; maxRounds: number }): VerdictDecision {
  if (i.verdict === 'accept') return { kind: 'accepted' };
  return i.reworkRounds < i.maxRounds ? { kind: 'rework', round: i.reworkRounds + 1 } : { kind: 'escalate' };
}

export async function handleGreenPipeline(ctx: Ctx, f: PipelineFact): Promise<void> {
  if (!ctx.deps.reviewer) return skip(ctx, 'no_reviewer');
  if (!ctx.controls.projects.includes(f.project)) return skip(ctx, 'project_not_allowed');
  if (f.tag || f.mr_iid === null) return skip(ctx, 'no_merge_request');
  const branch = branchOf(f);
  if (!ownsBranch(ctx.controls, branch, 'review') || branch === 'main') return skip(ctx, 'branch_not_owned');
  // Reviewing is a model call and a note: it is a prepare step (L2).
  if (!may(ctx, 'prepare')) return skip(ctx, 'review_needs_l2');

  const g = ctx.deps.gitlab;
  const mr = must('gitlab.getMergeRequest', await g.getMergeRequest(f.project, f.mr_iid), { allow404: true });
  if (mr === null) return skip(ctx, 'mr_gone');
  const head = mr.sha;
  const reviewed = head !== null && (await find(ctx, T.reviewVerdict, { project: f.project, mr_iid: mr.iid, head }, { limit: 1 })).length > 0;
  const d = decideReview({ draft: mr.draft, state: mr.state, head, pipelineSha: f.sha, alreadyReviewed: reviewed });
  if (d.kind === 'skip') return skip(ctx, d.reason);
  const headSha = head as string;

  await record(ctx, {
    type: T.reviewRequested,
    status: 'info',
    message: `Review of !${mr.iid} at ${headSha.slice(0, 8)} requested in ${f.project}`,
    payload: { project: f.project, mr_iid: mr.iid, head: headSha, branch, pipeline_id: f.pipeline_id },
    key: K.reviewRequested(f.project, mr.iid, headSha),
  });
  ctx.stats.decisions += 1;

  const diffs = must('gitlab.getMergeRequestDiffs', await g.getMergeRequestDiffs(f.project, mr.iid)) ?? [];
  let budget = MAX_DIFF_CHARS;
  const bounded = diffs.map((d2) => {
    const text = d2.diff.slice(0, Math.max(0, budget));
    budget -= text.length;
    return { ...d2, diff: text };
  });

  await spend(ctx); // the model call is a side effect with a cost
  const r = await ctx.deps.reviewer.review({ project: f.project, mr, diffs: bounded });
  // The reviewer is down: that is the world's failure, not this fact's. The fact is handled again next cycle and is never set aside for it.
  if (!r.ok) throw new LoopError('reviewer', r.error);
  ctx.stats.reviews += 1;
  await verdictOf(ctx, f.project, mr.iid, String(branch), headSha, r.data);
}

async function verdictOf(ctx: Ctx, project: string, mrIid: number, branch: string, head: string, v: ReviewVerdict): Promise<void> {
  const findings = v.findings.slice(0, MAX_FINDINGS).map((x) => String(x).slice(0, 400));
  await record(ctx, {
    type: T.reviewVerdict,
    status: v.verdict === 'accept' ? 'success' : 'warning',
    message: `Review of !${mrIid} at ${head.slice(0, 8)}: ${v.verdict}`,
    payload: { project, mr_iid: mrIid, head, verdict: v.verdict, model: v.model, findings: findings.length, summary: v.summary.slice(0, 300) },
    key: K.reviewVerdict(project, mrIid, head),
  });
  if (v.reviewed_head !== head) return; // a verdict on another commit is kept as a record and acted on by no one

  const rounds = (await find(ctx, T.reviewRework, { project, mr_iid: mrIid }, { limit: 10 })).length;
  const d = decideVerdict({ verdict: v.verdict, reworkRounds: rounds, maxRounds: ctx.controls.reworkMaxRounds });

  if (d.kind === 'accepted') {
    await postNote(ctx, { scope: `review:accepted:${project}:${mrIid}:${head}`, project, target: 'mr', iid: mrIid, body: `Review of ${head.slice(0, 8)}: accepted. ${v.summary.slice(0, 500)} Merging stays with the project.` });
    return;
  }
  const list = findings.map((f, n) => `${n + 1}. ${f}`).join('\n');
  if (d.kind === 'escalate') {
    await postNote(ctx, {
      scope: `review:escalate:${project}:${mrIid}:${head}`,
      project, target: 'mr', iid: mrIid,
      body: `Review of ${head.slice(0, 8)}: changes are still needed after ${rounds} round${rounds === 1 ? '' : 's'} of rework, so the loop stops here and a person is needed.\n\n${list}`,
    });
    return;
  }
  await record(ctx, {
    type: T.reviewRework,
    status: 'info',
    message: `Rework round ${d.round} requested for !${mrIid} in ${project}`,
    payload: { project, mr_iid: mrIid, head, round: d.round, findings: findings.length },
    key: K.reviewRework(project, mrIid, d.round),
  });
  if (may(ctx, 'record')) {
    // One unit of work per ROUND: a started round-1 intent must not stand in for round 2.
    await ensureIntent(
      ctx,
      `${K.workRework(project, mrIid)}:round-${d.round}`,
      { action: 'run_task', kind: 'rework', project, branch, branch_key: branchKey(project, branch), fix_branch: branch, mr_iid: mrIid, base_branch: 'main', reviewed_head: head, round: d.round, findings },
      `Rework requested for !${mrIid} in ${project}`,
    );
  }
  await postNote(ctx, {
    scope: `review:changes:${project}:${mrIid}:${head}`,
    project, target: 'mr', iid: mrIid,
    body: `Review of ${head.slice(0, 8)}: changes are needed (round ${d.round} of ${ctx.controls.reworkMaxRounds}).\n\n${list}\n\nThe delivery loop prepares the rework on this branch.`,
  });
}
