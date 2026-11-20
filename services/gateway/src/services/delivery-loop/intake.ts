/**
 * Delivery loop, intake: a GitLab issue that carries the intake label becomes a task, or is told why not.
 *
 *   observe   scm.gitlab.issue.opened | labeled  (written by the webhook stage, or by the poller)
 *   reason    pure `evaluateIssue`: open, labeled, not confidential, enough to act on, labeled by a member
 *   plan      accepted: a decision row and an INTENT row (the work, recorded before it is done); rejected: a decision row
 *   execute   a note on the issue (L2 and up). The intent is carried out by `drive.ts`, only at L3 with execution armed.
 *
 * Every step is idempotent and the steps run in order, so a fact handled again (the cycle stopped at the action cap, GitLab was
 * down) completes what is missing and repeats nothing. The text of the issue is never written to OASIS: the intent names the issue
 * and `drive.ts` reads it again when the task is built, so the instructions are fresh and user text is not copied into the ledger.
 */
import { createHash } from 'crypto';
import { intakeLabelOf } from '../gitlab-events/delivery-mapper';
import type { IssueFact } from './facts';
import type { GitlabIssue, GitlabLabelEvent } from './types';
import { K, T } from './keys';
import { find, may, must, postNote, record, skip, type Ctx } from './context';
import { ensureIntent } from './intents';
import { LABEL_ACCEPTED, LABEL_REJECTED } from './labels';

export const DEFAULT_BASE_BRANCH = 'main';
/** The least access level that may start work: Developer. A Guest or Reporter can label an issue; that is not a request. */
export const MIN_REQUESTER_LEVEL = 30;
export const MIN_DESCRIPTION_CHARS = 20;

export { LABEL_ACCEPTED, LABEL_REJECTED } from './labels';

export type IssueVerdict = { accept: true; requester: { user_id: number | null; level: number } } | { accept: false; reason: IssueRejection } | { skip: string };
export type IssueRejection = 'confidential_issue' | 'too_little_to_act_on' | 'requester_unknown' | 'requester_not_a_member';

/** Words for a person, per reason. */
export const REJECTION_TEXT: Record<IssueRejection, string> = {
  confidential_issue: 'a confidential issue is not worked on automatically, because the merge request it produces is visible to the project',
  too_little_to_act_on: `the description is too short to act on (at least ${MIN_DESCRIPTION_CHARS} characters of what should change)`,
  requester_unknown: 'GitLab does not show who applied the label, so the request cannot be attributed',
  requester_not_a_member: 'the label was applied by someone who is not at least a Developer of the project',
};

/**
 * Pure. Whether the issue as it is NOW is a task for the agents. `labeledBy` is the access level of whoever applied the intake
 * label: `null` when it could not be established, `{user_id: null}` when GitLab did not show who.
 */
export function evaluateIssue(issue: GitlabIssue, intakeLabel: string, requester: { user_id: number | null; level: number | null }): IssueVerdict {
  if (issue.state !== 'opened') return { skip: 'issue_closed' };
  if (!issue.labels.includes(intakeLabel)) return { skip: 'label_removed' };
  if (issue.confidential) return { accept: false, reason: 'confidential_issue' };
  if (issue.description.trim().length < MIN_DESCRIPTION_CHARS) return { accept: false, reason: 'too_little_to_act_on' };
  if (requester.user_id === null) return { accept: false, reason: 'requester_unknown' };
  if (requester.level === null || requester.level < MIN_REQUESTER_LEVEL) return { accept: false, reason: 'requester_not_a_member' };
  return { accept: true, requester: { user_id: requester.user_id, level: requester.level } };
}

/**
 * What the author can change to get a different answer: the description, whether the issue is confidential, and who applied the label
 * and when. A rejection is recorded once per (reason, this version), so the loop's own comment (which moves `updated_at`) never makes
 * it decide again, and the author's fix always does. Only a hash is kept; the text itself never leaves GitLab.
 */
export function issueVersion(issue: GitlabIssue, labelEvents: readonly GitlabLabelEvent[], label: string): string {
  const lastAdd = [...labelEvents].filter((e) => e.label === label && e.action === 'add').sort((a, b) => a.id - b.id).pop();
  return createHash('sha1').update(`${issue.description}\u0000${issue.confidential}\u0000${lastAdd?.id ?? 'none'}`).digest('hex').slice(0, 12);
}

/** The user who applied the label most recently, from the label events; the author when GitLab shows none. */
export function labelApplier(events: readonly GitlabLabelEvent[], label: string, author: number | null): number | null {
  const adds = events.filter((e) => e.label === label && e.action === 'add' && e.user_id !== null).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  return adds.length > 0 ? adds[adds.length - 1].user_id : author;
}

export async function handleIssue(ctx: Ctx, f: IssueFact): Promise<void> {
  if (!ctx.controls.projects.includes(f.project)) return skip(ctx, 'project_not_allowed');
  const g = ctx.deps.gitlab;
  const key = K.accepted(f.project, f.iid);

  // A decision already recorded for this issue: only the steps after it are left to complete.
  const earlier = await find(ctx, T.intakeAccepted, { project: f.project, issue_iid: f.iid }, { limit: 1 });
  if (earlier.length > 0) {
    const workKey = String(earlier[0].metadata.work_key ?? K.workIntake(f.project, f.iid));
    await afterAcceptance(ctx, f, workKey);
    return skip(ctx, 'already_accepted');
  }
  const issue = must('gitlab.getIssue', await g.getIssue(f.project, f.iid), { allow404: true });
  if (issue === null) return skip(ctx, 'issue_gone');

  const intake = intakeLabelOf(ctx.env);
  const labelEvents = must('gitlab.listIssueLabelEvents', await g.listIssueLabelEvents(f.project, f.iid)) ?? [];
  const userId = labelApplier(labelEvents, intake, issue.author_id);
  const level = userId === null ? null : must('gitlab.getMemberAccessLevel', await g.getMemberAccessLevel(f.project, userId));

  const verdict = evaluateIssue(issue, intake, { user_id: userId, level });
  if ('skip' in verdict) return skip(ctx, verdict.skip);

  if (!verdict.accept) {
    const version = issueVersion(issue, labelEvents, intake);
    const written = await record(ctx, {
      type: T.intakeRejected,
      status: 'info',
      message: `Issue #${f.iid} in ${f.project} was not accepted: ${verdict.reason}`,
      payload: { project: f.project, issue_iid: f.iid, url: f.url, reason: verdict.reason, version },
      key: K.rejected(f.project, f.iid, verdict.reason, version),
    });
    if (!written.duplicate) ctx.stats.decisions += 1;
    return afterRejection(ctx, f, verdict.reason, version);
  }

  const workKey = K.workIntake(f.project, f.iid);
  await record(ctx, {
    type: T.intakeAccepted,
    status: 'info',
    message: `Issue #${f.iid} in ${f.project} accepted as a task`,
    payload: { project: f.project, issue_iid: f.iid, url: f.url, work_key: workKey, requester_level: verdict.requester.level, fact: f.event.id },
    key,
  });
  ctx.stats.decisions += 1;
  await afterAcceptance(ctx, f, workKey);
}

/**
 * The intent and the note of an accepted issue. Both are idempotent: an intent still in progress (or already carried out) is kept, and
 * one that went dead (it expired, or failed for good) is replaced when the issue is labeled again.
 */
async function afterAcceptance(ctx: Ctx, f: IssueFact, workKey: string): Promise<void> {
  if (may(ctx, 'record')) {
    await ensureIntent(
      ctx,
      workKey,
      { action: 'run_task', kind: 'intake', project: f.project, issue_iid: f.iid, base_branch: DEFAULT_BASE_BRANCH },
      `Work requested for issue #${f.iid} in ${f.project}`,
    );
  }
  await postNote(ctx, {
    scope: `intake:accepted:${f.project}:${f.iid}`,
    project: f.project,
    target: 'issue',
    iid: f.iid,
    body: 'The delivery loop accepted this issue as a task. A change is prepared on a branch of its own and opened as a merge request that closes this issue; review and merge stay with the project.',
    addLabels: [LABEL_ACCEPTED],
  });
}

async function afterRejection(ctx: Ctx, f: IssueFact, reason: IssueRejection, version: string): Promise<void> {
  await postNote(ctx, {
    scope: `intake:rejected:${f.project}:${f.iid}:${reason}:${version}`,
    project: f.project,
    target: 'issue',
    iid: f.iid,
    body: `The delivery loop did not accept this issue as a task: ${REJECTION_TEXT[reason] ?? reason}. Change that and apply the label again to ask once more.`,
    addLabels: [LABEL_REJECTED],
  });
}
