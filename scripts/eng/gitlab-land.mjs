// The merge bot of the self-hosted GitLab (plan eng-gitlab-m2 §3.4, lane merge-bot). Free tier: no merge trains, no required
// approvals. One timer tick looks at the open merge requests of every project with `landing: true`, oldest first, and does at
// most one thing per project: land one, bring one up to date, or wait for the oldest one's pipeline.
//
//   node scripts/eng/gitlab-land.mjs run    [--dry-run]            one tick (the systemd timer runs it every minute)
//   node scripts/eng/gitlab-land.mjs merge  <project> <iid> [--dry-run]   decide and act on one merge request now
//   node scripts/eng/gitlab-land.mjs status                        what the bot would do for every open merge request; writes nothing
//   options: --settings <gitlab-settings.json>  --url <GitLab URL>  --token-file <file>  --workdir <dir>  --git-base <URL>
//            --services <services.json>  --queue-projects <a,b>   (queue mode, below)
//            --marker-file <delivery cutover marker>  --ci-dir <dir>   (read through gitlab-settings.mjs loadEffectiveProjects)
//
// The decisions are the ones the GitHub pipeline uses: `land-guard.mjs` (`laneKeyOf`, `localAfter`, `reviewCurrent`,
// `checksVerdict`, `protectedTouched`, `mergeDecision`) and `queue.mjs` (`commitsInRange`, `PROTECTED_GATE_PATHS`) are imported
// and not edited, so the rules cannot drift between the two systems. What is new here is only where the facts come from:
//  - Review: the newest review commit of the lane on the merge request (trailers Collab-Review / Collab-Verdict /
//    Collab-Reviewer / Collab-Reviewed-Head) must be an `accept`, and it must have been PUSHED by the `agent-reviewer` account
//    (project push events: commit_from..commit_to contains it), so a builder cannot forge it. `reviewCurrent` then decides
//    whether it still counts for the head (lane-file entries and clean merges of main only).
//  - Checks: the jobs of the pipeline for exactly the head SHA, each turned into a check run by `jobToCheckRun` and read by
//    `checksVerdict`; every name in the project's `required_jobs` must also be present and `success`.
//  - Landing: PUT .../merge pinned to the head `sha`, squash, with the title (VTID first) and description as the message,
//    `retries: 0` (an action is never repeated by the client) and, after any error, a re-read of the merge request before the
//    bot decides the merge failed.
//  - Behind main: `origin/main` is merged INTO the source branch (never a rebase, so the reviewed head stays an ancestor), as
//    `bot-land`, and the bot waits for the next tick. A merge that conflicts needs a human: that merge request is skipped (one
//    comment per head), not waited for, and the younger ones go on in the same tick.
//  - The turn: the oldest merge request that is waiting for its pipeline, or whose merge GitLab refuses, keeps the turn for 60
//    minutes (counted from its pipeline's creation) and then loses it to the next one. The bot keeps no state between ticks.
// Fails closed: any API or git error lands nothing. `--dry-run` writes nothing to GitLab. A comment is written once per
// (head, reason). Logs are JSON lines without tokens; git gets the token through GIT_ASKPASS, never on a command line, and
// every git command starts with `-c credential.helper=` so that no configured helper can store it.
// Dependency-free Node 20.
//
// Queue mode (plan agentic-delivery §3.5, lane merge-queue): the two projects of the cut (`vitana-platform`, `vitana-v1`;
// `--queue-projects a,b` changes the list, an empty value turns it off) and any project entry that carries `queue` (true, or
// { positions: 1..12 }) are landed by the merge queue of the cut instead of the one-at-a-time loop above, once they have
// `landing: true`. See the section "queue mode" below: cross-repo review source (review-source.mjs), order, red-main pause,
// hot files, the train of up to 8 positions, plan merge requests, the squash trailers, the queue labels and the assist
// trigger (assist-trigger.mjs). In queue mode the train holds the turn: a position whose merge GitLab refuses keeps it for
// 60 minutes from its pipeline's creation and is then dropped, so the positions behind it are rebuilt without it.
// `--services <config/delivery/services.json>` names the service list the assist rules come from.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, projectId, redact } from './gitlab-api.mjs';
import { laneKeyOf, localAfter, reviewCurrent, checksVerdict, protectedTouched, mergeDecision } from '../collab/land-guard.mjs';
import { commitsInRange, PROTECTED_GATE_PATHS, GOVERNANCE_PATHS } from '../collab/queue.mjs';
import { crossRepoReview } from './review-source.mjs';
import { loadAssistRules, matchingRules, assistActions, assistRuns, triggerAssist } from './assist-trigger.mjs';
import * as gitlabSettings from './gitlab-settings.mjs';

export const DEFAULTS = Object.freeze({
  reviewerUser: 'agent-reviewer',
  botUser: 'bot-land',
  botEmail: 'bot-land@gitlab.vitanaland.com',
  pipelineWaitMinutes: 60,
  eventPages: 5,
  tokenFile: '/etc/vitana/bot-land-token',
  workdir: '/var/lib/vitana-land',
  settings: '/opt/vitana/platform/infra/gitlab-engineering/settings/gitlab-settings.json',
  url: 'http://127.0.0.1',
  services: '/opt/vitana/platform/config/delivery/services.json',
  queueProjects: Object.freeze(['vitana-platform', 'vitana-v1']),
});

const SHA = /^[0-9a-f]{40}$/;
const BRANCH_OK = /^[A-Za-z0-9._/-]{1,200}$/;
const REVIEWER_RE = /^agent:vitana-lane-reviewer \(/;
const VTID_TITLE = /^VTID-\d{5}\b/;
const MAX_BUFFER = 64 * 1024 * 1024;

// ── pure functions ───────────────────────────────────────────────────────────

const STATUS_TO_QUEUED = new Set(['created', 'pending', 'scheduled', 'preparing', 'waiting_for_resource', 'waiting_for_callback']);
const STATUS_RUNNING = new Set(['running', 'canceling']);

/**
 * One GitLab job as the check run `checksVerdict` reads (land-guard.mjs:85: name, id, started_at, status, conclusion).
 * The table is plan §3.4's, complete for the job statuses GitLab documents; an unknown status is pending (fails closed)
 * and `onUnknown` is called once so the caller can log it.
 */
export function jobToCheckRun(job, { onUnknown } = {}) {
  const run = (status, conclusion) => ({ name: job.name, id: job.id, started_at: job.started_at ?? null, status, conclusion });
  const optional = job.allow_failure === true;
  switch (job.status) {
    case 'success': return run('completed', 'success');
    case 'failed': return optional ? run('completed', 'neutral') : run('completed', 'failure');
    case 'canceled': return run('completed', 'cancelled');
    case 'skipped': return run('completed', 'skipped');
    case 'manual': return optional ? run('completed', 'neutral') : run('queued', null);
    default:
      if (STATUS_TO_QUEUED.has(job.status)) return run('queued', null);
      if (STATUS_RUNNING.has(job.status)) return run('in_progress', null);
      if (typeof onUnknown === 'function') onUnknown(job);
      return run('queued', null);
  }
}

const runKey = (r) => `${r.started_at || '9999'}|${String(r.id || 0).padStart(20, '0')}`;

/**
 * Every name in `required` must be present and map to `success`. A name that is skipped, neutral (an optional job that
 * failed) or failed does not pass. A name that is absent or still running is pending while the pipeline is still going, and
 * a failure once the pipeline has finished. Same shape as `checksVerdict`: { state: 'pass' | 'fail' | 'pending', detail }.
 */
export function requiredJobsVerdict(runs, required, { pipelineFinal = false } = {}) {
  if (!Array.isArray(required) || required.length === 0) return { state: 'pass', detail: 'no required jobs configured' };
  const latest = new Map();
  for (const r of runs) {
    const prev = latest.get(r.name);
    if (!prev || runKey(r) >= runKey(prev)) latest.set(r.name, r);
  }
  const failed = [];
  const pending = [];
  for (const name of required) {
    const r = latest.get(name);
    if (!r) { (pipelineFinal ? failed : pending).push(`${name}=absent`); continue; }
    if (r.status !== 'completed') { pending.push(`${name}=${r.status}`); continue; }
    if (r.conclusion !== 'success') failed.push(`${name}=${r.conclusion}`);
  }
  if (failed.length) return { state: 'fail', detail: `required job(s) not green: ${failed.join(', ')}` };
  if (pending.length) return { state: 'pending', detail: `required job(s) not finished: ${pending.join(', ')}` };
  return { state: 'pass', detail: `${required.length} required job(s) green` };
}

/** fail beats pending beats pass. */
export function combineChecks(...verdicts) {
  const fail = verdicts.filter((v) => v.state === 'fail');
  if (fail.length) return { state: 'fail', detail: fail.map((v) => v.detail).join('; ') };
  const pending = verdicts.filter((v) => v.state === 'pending');
  if (pending.length) return { state: 'pending', detail: pending.map((v) => v.detail).join('; ') };
  return { state: 'pass', detail: verdicts.map((v) => v.detail).join('; ') };
}

const PIPELINE_FINAL = new Set(['success', 'failed', 'canceled', 'skipped']);

/** The checks verdict of a pipeline's jobs for a project. `pipeline` null = no pipeline for the head yet. */
export function checksFor(pipeline, jobs, required, { onUnknown } = {}) {
  if (!pipeline) return { state: 'pending', detail: 'no pipeline for this head yet' };
  const final = PIPELINE_FINAL.has(pipeline.status);
  if (final && jobs.length === 0) return { state: 'fail', kind: 'checks', detail: `pipeline ${pipeline.id} is ${pipeline.status} and has no jobs` };
  const runs = jobs.map((j) => jobToCheckRun(j, { onUnknown }));
  const plain = checksVerdict(runs);
  const named = requiredJobsVerdict(runs, required, { pipelineFinal: final });
  // kind says which rule failed: a job that is red (checks) or a required job that is absent, skipped or neutral (required).
  const kind = plain.state === 'fail' ? 'checks' : named.state === 'fail' ? 'required' : undefined;
  return { ...combineChecks(plain, named), ...(kind ? { kind } : {}) };
}

/**
 * The newest review commit of the lane among `commits` (queue.mjs `commitsInRange` records, newest first), judged without
 * IO: → { ok, code, reason, commit }. `pushed` is the answer of the push-event check for the newest review commit.
 */
export function judgeReviewCommit(commits, laneKey, { pushed, reviewerUser = DEFAULTS.reviewerUser } = {}) {
  const commit = commits.find((c) => c.review === laneKey && (c.verdict === 'accept' || c.verdict === 'changes'));
  if (!commit) return { ok: false, code: 'no_review', reason: 'there is no reviewer accept for this lane on the merge request' };
  if (commit.verdict !== 'accept') return { ok: false, code: 'review_changes', reason: 'the newest review of this lane asks for changes', commit };
  if (!REVIEWER_RE.test(commit.reviewer || '')) return { ok: false, code: 'review_forged', reason: 'the accept does not name the reviewer agent (Collab-Reviewer)', commit };
  if (!SHA.test(commit.reviewedHead || '')) return { ok: false, code: 'review_forged', reason: 'the accept has no valid Collab-Reviewed-Head', commit };
  if (pushed !== true) return { ok: false, code: 'review_forged', reason: `the accept commit was not pushed by ${reviewerUser}`, commit };
  return { ok: true, code: 'review_found', reason: 'accept pushed by the reviewer account', commit };
}

/**
 * What to do with one merge request, from the gate facts. Uses `mergeDecision` unchanged: the action is `land` exactly when it
 * says ok, `wait` when it says pending, `update` when the only thing missing is being up to date, `skip` otherwise.
 * → { action: 'land' | 'update' | 'wait' | 'skip', code, reasonCode, reason }
 */
export function decide({ review, checks, behindBy = 0, protectedFiles = [] }) {
  const full = mergeDecision({ review, checks, behindBy, protectedFiles });
  if (full.ok) return { action: 'land', code: 0, reasonCode: 'ready', reason: full.reason };
  if (full.code === 2) return { action: 'wait', code: 2, reasonCode: 'checks_pending', reason: full.reason };
  const ignoringBehind = mergeDecision({ review, checks, behindBy: 0, protectedFiles });
  if (ignoringBehind.ok) return { action: 'update', code: 1, reasonCode: 'behind', reason: full.reason };
  let reasonCode = 'refused';
  if (protectedFiles.length) reasonCode = 'protected_gate_file';
  else if (!review.ok) reasonCode = review.code || 'review';
  else if (checks.state === 'fail') reasonCode = checks.kind === 'required' ? 'required_job_missing' : 'checks_failed';
  return { action: 'skip', code: 1, reasonCode, reason: ignoringBehind.reason };
}

/** The squash commit message: the title (VTID first) and the description. */
export function squashMessage(mr) {
  const title = String(mr.title || '').replace(/\s+/g, ' ').trim();
  const description = String(mr.description || '').replace(/\r\n/g, '\n').trim();
  return description ? `${title}\n\n${description}` : title;
}

const COMMENT_TEXT = {
  not_a_lane_mr: 'Not landed: the title must be `VTID-nnnnn (<slug>/<lane>): …` so that the bot can find the lane and `main` gets the VTID.',
  no_review: 'Not landed: there is no reviewer accept for this lane on the merge request.',
  review_changes: 'Not landed: the newest review of this lane asks for changes.',
  review_forged: 'Not landed: the accept on this merge request was not pushed by the reviewer account, or does not name the reviewer agent.',
  review_stale: 'Not landed: the reviewer accept no longer counts for this head (code changed after it, or its history was rewritten).',
  checks_failed: 'Not landed: a check of this head failed.',
  required_job_missing: 'Not landed: a required job is missing or did not succeed on this head.',
  protected_gate_file: 'Not landed: the diff changes a protected gate file. The owner merges it.',
  conflict: 'Not updated: merging `main` into this branch conflicts. The builder resolves it.',
  review_would_lapse: 'Not updated: `main` changed governance or protected gate files since this branch was cut, so a merge of `main` would end the validity of the review. Merge `main` into the branch and ask for a new review.',
};

// ── IO helpers ───────────────────────────────────────────────────────────────

/**
 * Put before every git command the bot runs. The token reaches git through GIT_ASKPASS; an empty `credential.helper` clears every
 * helper configured anywhere (a global `store` helper would write that token to a file in plain text after a successful fetch).
 */
export const GIT_CONFIG_ARGS = Object.freeze(['-c', 'credential.helper=']);

function gitRun(ctx, cwd, args, { env, allowFail = false } = {}) {
  try {
    return execFileSync('git', [...GIT_CONFIG_ARGS, '-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER, timeout: ctx.gitTimeoutMs, env: { ...ctx.gitEnv, ...(env || {}) },
    }).trimEnd();
  } catch (e) {
    if (allowFail) return null;
    const detail = redact(String(e.stderr || e.message).trim().split('\n').slice(-3).join(' | '), ctx.token);
    const err = new Error(`git ${args[0]} failed: ${detail}`);
    err.code = 'git';
    throw err;
  }
}

function askpass(workdir, tokenFile) {
  fs.mkdirSync(workdir, { recursive: true });
  const script = path.join(workdir, '.askpass');
  const text = `#!/bin/sh\ncase "$1" in Username*) echo oauth2 ;; *) cat "$LAND_TOKEN_FILE" ;; esac\n`;
  if (!fs.existsSync(script) || fs.readFileSync(script, 'utf8') !== text) fs.writeFileSync(script, text, { mode: 0o700 });
  return { GIT_ASKPASS: script, LAND_TOKEN_FILE: tokenFile, GIT_TERMINAL_PROMPT: '0' };
}

function ensureClone(ctx, project) {
  const repo = path.join(ctx.workdir, `${project.name}.git`);
  const url = ctx.remoteUrl(project);
  if (!fs.existsSync(repo)) {
    fs.mkdirSync(ctx.workdir, { recursive: true });
    execFileSync('git', [...GIT_CONFIG_ARGS, 'init', '--bare', '-q', repo], { stdio: 'ignore', env: ctx.gitEnv });
    gitRun(ctx, repo, ['remote', 'add', 'origin', url]);
  } else {
    gitRun(ctx, repo, ['remote', 'set-url', 'origin', url]);
  }
  gitRun(ctx, repo, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  return repo;
}

function fetchMrHead(ctx, repo, iid) {
  gitRun(ctx, repo, ['fetch', '-q', 'origin', `+refs/merge-requests/${iid}/head:refs/mr/${iid}`]);
  return gitRun(ctx, repo, ['rev-parse', `refs/mr/${iid}`]);
}

/** The commits one push event proves the pusher made: `commit_from..commit_to`, or the tip alone when the push created its branch. */
function pushRange(ctx, repo, pushData) {
  const to = pushData.commit_to;
  const from = pushData.commit_from;
  // A push without a usable commit_from created its branch. GitLab's commit_count then also covers commits the pusher did not make
  // (a builder's, and an accept forged among them), so such a push proves its tip and nothing below it.
  if (!SHA.test(from || '')) return [to];
  const out = gitRun(ctx, repo, ['rev-list', `${from}..${to}`], { allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Was `sha` part of a push made by the reviewer account? (project push events; newest first, `eventPages` pages of 100) */
export async function pushedByReviewer(ctx, pid, repo, sha) {
  for (let page = 1; page <= ctx.eventPages; page++) {
    const events = await ctx.client.get(`/projects/${pid}/events`, { query: { action: 'pushed', per_page: 100, page } });
    if (!Array.isArray(events) || events.length === 0) return false;
    for (const ev of events) {
      if (ev?.author_username !== ctx.reviewerUser) continue;
      const pd = ev.push_data;
      if (!pd || !SHA.test(pd.commit_to || '')) continue;
      if (pushRange(ctx, repo, pd).includes(sha)) return true;
    }
    if (events.length < 100) return false;
  }
  return false;
}

async function ensureNote(ctx, pid, mr, code, head) {
  const marker = `<!-- vitana-land:${code}:${head} -->`;
  const notes = await ctx.client.paginate(`/projects/${pid}/merge_requests/${mr.iid}/notes`, { query: { sort: 'desc', order_by: 'created_at' }, maxPages: 20 });
  if (notes.some((n) => typeof n?.body === 'string' && n.body.includes(marker) && n.author?.username === ctx.botUser)) return false;
  if (ctx.dryRun) { ctx.log({ event: 'would_comment', mr: mr.iid, reason: code }); return false; }
  await ctx.client.post(`/projects/${pid}/merge_requests/${mr.iid}/notes`, { body: { body: `${COMMENT_TEXT[code]}\n\n${marker}` } });
  ctx.log({ event: 'commented', mr: mr.iid, reason: code });
  return true;
}

// ── one merge request ────────────────────────────────────────────────────────

/** Read every fact about one open merge request and decide. Writes nothing to GitLab. */
export async function evaluate(ctx, project, repo, mr) {
  const pid = projectId(project.path);
  const verdict = (action, reasonCode, reason, extra = {}) => ({ iid: mr.iid, title: mr.title, head: mr.sha, action, reasonCode, reason, ...extra });
  if (!Number.isInteger(mr.iid) || !SHA.test(mr.sha || '') || !BRANCH_OK.test(mr.source_branch || '')) return verdict('skip', 'bad_merge_request', 'the merge request has an unexpected iid, head or source branch');
  if (mr.draft === true || mr.work_in_progress === true) return verdict('skip', 'draft', 'draft merge request');
  const laneKey = laneKeyOf(mr.title);
  if (!laneKey || !VTID_TITLE.test(mr.title || '')) return verdict('skip', 'not_a_lane_mr', 'the title is not "VTID-nnnnn (<slug>/<lane>): …"', { comment: true });

  const head = fetchMrHead(ctx, repo, mr.iid);
  if (head !== mr.sha) return verdict('skip', 'head_moved', 'the head moved while the merge request was read; next tick');

  const files = gitRun(ctx, repo, ['diff', '--name-only', '--no-renames', `origin/main...${head}`]).split('\n').filter(Boolean);
  const protectedFiles = protectedTouched(files, PROTECTED_GATE_PATHS);
  const behindBy = Number(gitRun(ctx, repo, ['rev-list', '--count', `${head}..origin/main`]));
  const commits = commitsInRange(repo, 'origin/main', head);

  // Review
  const newest = commits.find((c) => c.review === laneKey && (c.verdict === 'accept' || c.verdict === 'changes'));
  const pushed = newest && newest.verdict === 'accept' && REVIEWER_RE.test(newest.reviewer || '') && SHA.test(newest.reviewedHead || '')
    ? await pushedByReviewer(ctx, pid, repo, newest.sha)
    : false;
  const judged = judgeReviewCommit(commits, laneKey, { pushed, reviewerUser: ctx.reviewerUser });
  let review = { ok: judged.ok, reason: judged.reason, code: judged.code };
  if (judged.ok) {
    const walk = localAfter(repo, judged.commit.reviewedHead, head, laneKey);
    const current = reviewCurrent(judged.commit.reviewedHead, head, walk.after, laneKey, walk.prDiffSame);
    review = { ...current, code: current.ok ? 'review_found' : 'review_stale' };
  }

  // Checks (only worth reading when the review stands; a pipeline is read for exactly the head)
  let checks = { state: 'pending', detail: 'not read' };
  let pipeline = null;
  if (review.ok && protectedFiles.length === 0) {
    const list = await ctx.client.get(`/projects/${pid}/pipelines`, { query: { sha: head, order_by: 'id', sort: 'desc', per_page: 20 } });
    pipeline = (Array.isArray(list) ? list : []).find((p) => p.sha === head) || null;
    const jobs = pipeline ? await ctx.client.paginate(`/projects/${pid}/pipelines/${pipeline.id}/jobs`, { maxPages: 20 }) : [];
    checks = checksFor(pipeline, jobs, project.required_jobs, { onUnknown: (j) => ctx.log({ event: 'unknown_job_status', mr: mr.iid, job: j.name, status: String(j.status) }) });
  }

  const d = decide({ review, checks, behindBy, protectedFiles });
  if (d.action === 'update') {
    // reviewCurrent keeps a review across a merge of main only when no governance or protected gate file comes in
    // (land-guard.mjs mergeKeepsReview). Merging such a main would end the review, so the bot leaves the branch alone.
    const base = gitRun(ctx, repo, ['merge-base', head, 'origin/main']);
    const incoming = gitRun(ctx, repo, ['diff', '--name-only', '--no-renames', base, 'origin/main']).split('\n').filter(Boolean);
    const lapsing = protectedTouched(incoming, [...PROTECTED_GATE_PATHS, ...GOVERNANCE_PATHS]);
    if (lapsing.length) {
      return verdict('skip', 'review_would_lapse', `main brought in governance or protected gate file(s) (${lapsing.slice(0, 5).join(', ')}): merging it would end the review's validity`, { laneKey, behindBy, protectedFiles, comment: true });
    }
  }
  const waitingSince = pipeline?.created_at || mr.updated_at || null;
  return verdict(d.action, d.reasonCode, d.reason, { laneKey, behindBy, protectedFiles, checks: checks.state, waitingSince, comment: Boolean(COMMENT_TEXT[d.reasonCode]) && d.action === 'skip' });
}

async function landOne(ctx, pid, mr, v) {
  if (ctx.dryRun) { ctx.log({ event: 'would_land', mr: mr.iid, head: v.head }); return { landed: false }; }
  const body = { sha: v.head, squash: true, squash_commit_message: squashMessage(mr), should_remove_source_branch: true };
  try {
    const res = await ctx.client.put(`/projects/${pid}/merge_requests/${mr.iid}/merge`, { body, retries: 0 });
    if (res?.state === 'merged') { ctx.log({ event: 'landed', mr: mr.iid, head: v.head }); return { landed: true }; }
  } catch (e) {
    ctx.log({ event: 'merge_call_failed', mr: mr.iid, status: e.status ?? null, code: e.code ?? null, error: redact(e.message, ctx.token) });
  }
  // The call may have been processed even when it reported an error, so the merge request is read again before deciding.
  const current = await ctx.client.get(`/projects/${pid}/merge_requests/${mr.iid}`).catch(() => null);
  if (current?.state === 'merged') { ctx.log({ event: 'landed', mr: mr.iid, head: v.head, confirmedBy: 'reread' }); return { landed: true }; }
  ctx.log({ event: 'not_landed', mr: mr.iid, reason: 'the merge call was refused; the next tick tries again' });
  return { landed: false, refused: true };
}

async function updateOne(ctx, project, repo, pid, mr, v) {
  if (ctx.dryRun) { ctx.log({ event: 'would_update', mr: mr.iid, head: v.head, behindBy: v.behindBy }); return { updated: false }; }
  const tmp = fs.mkdtempSync(path.join(ctx.workdir, `${project.name}-update-`));
  fs.rmSync(tmp, { recursive: true, force: true });
  const identity = { GIT_AUTHOR_NAME: ctx.botUser, GIT_AUTHOR_EMAIL: ctx.botEmail, GIT_COMMITTER_NAME: ctx.botUser, GIT_COMMITTER_EMAIL: ctx.botEmail };
  try {
    gitRun(ctx, repo, ['worktree', 'add', '--detach', '-q', tmp, v.head]);
    const merged = gitRun(ctx, tmp, ['merge', '--no-ff', '-q', '-m', `Merge branch 'main' into ${mr.source_branch}\n\nCollab-Session: ${ctx.botUser}`, 'origin/main'], { env: identity, allowFail: true });
    if (merged === null) {
      gitRun(ctx, tmp, ['merge', '--abort'], { allowFail: true });
      await ensureNote(ctx, pid, mr, 'conflict', v.head);
      ctx.log({ event: 'not_updated', mr: mr.iid, reason: 'conflict' });
      return { updated: false, conflict: true };
    }
    const sha = gitRun(ctx, tmp, ['rev-parse', 'HEAD']);
    gitRun(ctx, tmp, ['push', '-q', 'origin', `${sha}:refs/heads/${mr.source_branch}`]);
    ctx.log({ event: 'updated', mr: mr.iid, from: v.head, to: sha });
    return { updated: true, head: sha };
  } finally {
    gitRun(ctx, repo, ['worktree', 'remove', '--force', tmp], { allowFail: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    gitRun(ctx, repo, ['worktree', 'prune'], { allowFail: true });
  }
}

// ── one project, one tick ────────────────────────────────────────────────────

async function openMergeRequests(ctx, pid, branch) {
  const list = await ctx.client.paginate(`/projects/${pid}/merge_requests`, { query: { state: 'opened', target_branch: branch, order_by: 'created_at', sort: 'asc' }, maxPages: 20 });
  return [...list].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.iid - b.iid);
}

/** Has the merge request held the turn longer than the bound? Counted from its pipeline's creation (its last update when it has no pipeline). */
function lostItsTurn(ctx, v) {
  const since = Date.parse(v.waitingSince || '');
  return Number.isFinite(since) && ctx.now() - since > ctx.pipelineWaitMs;
}
const waitedMinutes = (ctx, v) => Math.round((ctx.now() - Date.parse(v.waitingSince)) / 60_000);

export async function tickProject(ctx, project, { only, statusOnly = false } = {}) {
  const queue = queueSetting(project, ctx);
  if (queue) return tickQueue(ctx, { ...project, queue }, { only, statusOnly });
  const pid = projectId(project.path);
  const info = await ctx.client.get(`/projects/${pid}`);
  if (info?.default_branch !== 'main') {
    ctx.log({ event: 'project_skipped', project: project.name, reason: `default branch is "${info?.default_branch}"; the land-guard functions read origin/main` });
    return [];
  }
  const repo = ensureClone(ctx, project);
  const mrs = (await openMergeRequests(ctx, pid, 'main')).filter((m) => only === undefined || m.iid === only);
  const out = [];
  let acted = false;
  for (const mr of mrs) {
    if (acted && !statusOnly) break; // one thing per project per tick; the others are not even read
    const v = await evaluate(ctx, project, repo, mr);
    ctx.log({ event: 'verdict', project: project.name, mr: mr.iid, action: v.action, reason: v.reasonCode, detail: v.reason });
    const row = { project: project.name, ...v };
    out.push(row);
    if (statusOnly) continue;
    if (v.action === 'skip') {
      if (v.comment) await ensureNote(ctx, pid, mr, v.reasonCode, v.head);
      continue;
    }
    if (v.action === 'wait') {
      if (lostItsTurn(ctx, v)) {
        ctx.log({ event: 'lost_its_turn', mr: mr.iid, reason: 'pipeline_pending', waitedMinutes: waitedMinutes(ctx, v) });
        row.action = 'skip';
        row.reasonCode = 'waited_too_long';
        continue;
      }
      acted = true;
      continue;
    }
    if (v.action === 'update') {
      const res = await updateOne(ctx, project, repo, pid, mr, v);
      Object.assign(row, res);
      if (res.conflict) {
        // The merge of main conflicts: the builder has to resolve it. Like any merge request that needs a human it is skipped, not waited
        // for, so the younger merge requests of the project go on (plan §3.4). The comment was written once for this head.
        row.action = 'skip';
        row.reasonCode = 'conflict';
        continue;
      }
      acted = true;
      continue;
    }
    if (v.action === 'land') {
      const res = await landOne(ctx, pid, mr, v);
      Object.assign(row, res);
      if (res.refused && lostItsTurn(ctx, v)) {
        // GitLab keeps refusing this merge (an unresolved thread, a merge setting the bot does not read). As for a pipeline that does not
        // finish, it keeps the turn for 60 minutes and then loses it, so the merge requests behind it are not held for ever.
        ctx.log({ event: 'lost_its_turn', mr: mr.iid, reason: 'merge_refused', waitedMinutes: waitedMinutes(ctx, v) });
        row.action = 'skip';
        row.reasonCode = 'merge_refused_too_long';
        continue;
      }
      acted = true;
      continue;
    }
  }
  return out;
}

/** One tick over every project with `landing: true`. A failing project lands nothing and does not stop the others. */
export async function tick(ctx, options = {}) {
  const rows = [];
  let failed = false;
  for (const project of ctx.projects.filter((p) => p.landing === true)) {
    if (options.project && options.project !== project.name) continue;
    try {
      rows.push(...await tickProject(ctx, project, options));
    } catch (e) {
      failed = true;
      ctx.log({ event: 'project_failed', project: project.name, error: redact(e.message, ctx.token) });
    }
  }
  return { rows, failed };
}

// ── queue mode (plan agentic-delivery §3.5, lane merge-queue) ────────────────
// One tick of a queue project: read every open merge request and give it a queue state (ready, waiting, blocked, paused);
// land the green positions of the train in order; drop a failed or conflicting position and rebuild the ones behind it;
// fill the train up to its positions from the queue order; set each queue label once per state; comment once per
// (head, reason). Position k is the bot ref `train/<k>` = main (or position k-1) merged with the head of merge request k,
// tested by its own pipeline. Merge request k lands when position k is green and positions 1..k-1 have landed: the bot
// merges `main` into it (ci.skip), checks that the tree equals position k's tested tree, and lands it pinned to that head.
// The train is kept in `<workdir>/<project>.train.json`; a lost or unreadable file only makes the bot rebuild the train.

export const QUEUE_LABELS = Object.freeze(['queue-ready', 'queue-updating', 'queue-waiting', 'queue-blocked', 'queue-paused']);
export const PLATFORM_PROJECT = 'vitana-platform';
const MAX_POSITIONS = 12;
const PLAN_TITLE = /^plan\(([a-z0-9][a-z0-9-]*)\):/;
const PLAN_PROGRAM = /^docs\/programs\/[a-z0-9][a-z0-9-]*\/program\.md$/;
const PLAN_SPAR_STATUSES = new Set(['gitlab/plan-spar', 'PLAN-SPAR']);
const GOVERNANCE_GLOBS = [...PROTECTED_GATE_PATHS, ...GOVERNANCE_PATHS];
const HOT_LOOKBACK = 50;
const JOB_FINAL = new Set(['success', 'failed', 'canceled', 'skipped']);
const LABEL_OF = { ready: 'queue-ready', updating: 'queue-updating', waiting: 'queue-waiting', blocked: 'queue-blocked', paused: 'queue-paused', none: null };

const QUEUE_COMMENT_TEXT = {
  no_review: 'Not landed: there is no reviewer accept for this lane (on the merge request; for a vitana-v1 lane, in its vitana-platform lane file).',
  review_model: 'Not landed: the accept was made by a model outside the reviewer chain.',
  review_by_builder: 'Not landed: the reviewer session of the accept also committed to this merge request. A lane is never accepted by its builder.',
  assist_failed: 'Not landed: an assist job failed for this head. Fix the source and push again.',
  plan_scope: 'Not landed: a `plan(` merge request changes only its spec folder and the program entry. Move the other files to a lane.',
  plan_parked: 'Not landed: the plan is parked (handoff.md).',
  plan_spar_failed: 'Not landed: the last PLAN-SPAR run on this head failed.',
  train_failed: 'Not landed: it failed in the landing train (its position merges `main` and the merge requests ahead of it). It is back with its builder; a new head enters the queue again.',
  train_conflict: 'Not landed: it conflicts with a merge request ahead of it in the landing train. Merge `main` into the branch after that one has landed and resolve the conflict.',
  merge_refused_too_long: 'Not landed: GitLab refused the merge of this merge request for more than 60 minutes (for example an unresolved thread or a merge setting), so it left the landing train and the merge requests behind it go on. Resolve it and push again; a new head enters the queue again.',
};

/** The `queue` setting of a project: true → 8 positions; { positions } → 1 to 12 (plan §5: 8, grown to 12 by its trigger). */
export function normalizeQueue(value) {
  if (value === true) return { positions: 8 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('queue: must be true or { "positions": 1..12 }');
  const positions = value.positions === undefined ? 8 : value.positions;
  if (!Number.isInteger(positions) || positions < 1 || positions > MAX_POSITIONS) throw new Error(`queue: positions must be an integer from 1 to ${MAX_POSITIONS}`);
  return { positions };
}

/**
 * Is a project landed by the queue, and with how many positions? → { positions } or null (M2's one-at-a-time loop). An entry's
 * own `queue` wins (false = off); otherwise the projects of the cut (`ctx.queueProjects`, default vitana-platform and vitana-v1)
 * get 8 positions. The settings schema of lane eng-gitlab-m2 `settings` has no `queue` key, so the cut's projects are named here.
 */
export function queueSetting(project, ctx = {}) {
  if (project?.queue === false) return null;
  if (project?.queue !== undefined && project?.queue !== null) return normalizeQueue(project.queue);
  return (ctx.queueProjects || []).includes(project?.name) ? normalizeQueue(true) : null;
}

/** Revert and fix-main lanes (`<slug>/revert[-…]`, `<slug>/fix-main[-…]`) land first while main is red. */
export function fixFirst(laneKey) {
  const lane = String(laneKey ?? '').split('/')[1] ?? '';
  return /^(revert|fix-main)(-[a-z0-9-]+)?$/.test(lane);
}

/** Is main red? The newest finished landing pipeline of main (source push; success or failed) decides. */
export function mainRed(pipelines) {
  const landings = (pipelines || []).filter((p) => p?.source === 'push' && (p.status === 'success' || p.status === 'failed')).sort((a, b) => b.id - a.id);
  return landings[0] ? { red: landings[0].status === 'failed', pipeline: landings[0] } : { red: false, pipeline: null };
}

/** The hot files of collaboration.md §8a item 4, as keys: one merge request per key at a time. */
export function hotKeys(files) {
  const keys = new Set();
  for (const f of files || []) {
    let m;
    if (/^(supabase|database)\/migrations\/./.test(f)) keys.add('migrations');
    else if (['DATABASE_SCHEMA.md', 'src/App.tsx', 'CLAUDE.md', 'apps/mobile/parity/ledger.json'].includes(f)) keys.add(f);
    else if (f === 'src/navigation/registry/screens.json' || f === 'src/navigation/registry/exclusions.json') keys.add('navigation-registry');
    else if ((m = /^src\/i18n\/[a-z]{2,3}(?:-[A-Za-z]{2,4})?\/(.+)\.json$/.exec(f))) keys.add(`i18n:${m[1]}`);
  }
  return [...keys].sort();
}

/** The label write that puts exactly `label` (or no queue label for null) on a merge request; null = nothing to write. */
export function labelChange(labels, label) {
  const have = (labels || []).filter((l) => QUEUE_LABELS.includes(l));
  const add = label && !have.includes(label) ? label : null;
  const remove = have.filter((l) => l !== label);
  if (!add && !remove.length) return null;
  return { ...(add ? { add_labels: add } : {}), ...(remove.length ? { remove_labels: remove.join(',') } : {}) };
}

/** The squash message of the queue: the title (VTID first) and description, then the six review trailers (two for a plan). */
export function queueSquashMessage(mr, accept) {
  const trailers = [`Merge-Request: !${mr.iid}`, `Source-Branch: ${mr.source_branch}`];
  if (accept) {
    trailers.push(`Reviewed-Head: ${accept.reviewedHead}`, 'Review-Verdict: accept', `Reviewer: ${accept.reviewer}`, `Accepted-At: ${new Date(accept.acceptedAt).toISOString()}`);
  }
  return `${squashMessage(mr)}\n\n${trailers.join('\n')}`;
}

const timeOf = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER; };
const byAccept = (a, b) => (timeOf(a.acceptedAt) - timeOf(b.acceptedAt)) || (timeOf(a.createdAt) - timeOf(b.createdAt)) || (a.iid - b.iid);

/** Queue order of the ready merge requests: the oldest accept first; while main is red only revert and fix-main go, the rest pause. */
export function queueOrder(items, { red = false } = {}) {
  const ready = (items || []).filter((x) => x.state === 'ready').sort(byAccept);
  if (!red) return { order: ready, paused: [] };
  return { order: ready.filter((x) => x.fixFirst), paused: ready.filter((x) => !x.fixFirst) };
}

/**
 * The merge requests that join the train behind `kept`, in queue order, up to `capacity` positions: one per hot key, none
 * that shares a file with one ahead (it waits for the next cycle), and none behind a governance change (its merge would
 * end the review of every merge request behind it, land-guard.mjs mergeKeepsReview).
 */
export function trainSelect(order, { capacity = 8, kept = [] } = {}) {
  const taken = [...kept];
  const keptIids = new Set(kept.map((x) => x.iid));
  const picked = [];
  for (const it of order || []) {
    if (keptIids.has(it.iid)) continue;
    if (taken.length >= capacity) break;
    if (taken.some((t) => protectedTouched(t.files || [], GOVERNANCE_GLOBS).length)) break;
    const files = new Set(taken.flatMap((t) => t.files || []));
    const hot = new Set(taken.flatMap((t) => t.hot || []));
    if ((it.hot || []).some((h) => hot.has(h)) || (it.files || []).some((f) => files.has(f))) continue;
    taken.push(it);
    picked.push(it);
  }
  return picked;
}

/**
 * The jobs that judge one merge request (its own diff, commits and lane: plan §3.4's governance jobs). They are required on
 * each merge request's own head, which the bot reads before the merge request may join the train; a train position merges
 * several merge requests (scopeCheck refuses a range of two lanes), so it is judged by the other required jobs (`gate`).
 */
export const MR_ONLY_JOBS = Object.freeze(['lane-scope', 'collab-handoff', 'change-suite', 'pr-gate-report']);

/** The required jobs of a train position: the project's `train_required_jobs`, else its `required_jobs` without MR_ONLY_JOBS. */
export function trainRequiredJobs(project) {
  if (Array.isArray(project?.train_required_jobs)) return project.train_required_jobs.map(String);
  return (project?.required_jobs || []).filter((j) => !MR_ONLY_JOBS.includes(j));
}

/** PLAN-SPAR's last run on a plan head: a `gitlab/plan-spar` or `PLAN-SPAR` commit status from a trusted account. */
export function planSparVerdict(statuses, { users = [DEFAULTS.botUser] } = {}) {
  const runs = (statuses || []).filter((s) => PLAN_SPAR_STATUSES.has(s?.name) && users.includes(s?.author?.username))
    .sort((a, b) => (timeOf(b.created_at) - timeOf(a.created_at)) || ((b.id || 0) - (a.id || 0)));
  const last = runs[0];
  if (!last) return { state: 'pending', detail: 'no PLAN-SPAR or gitlab/plan-spar status from a trusted account on this head' };
  if (last.status === 'success') return { state: 'pass', detail: `${last.name} succeeded on this head`, at: last.created_at };
  if (last.status === 'failed' || last.status === 'canceled') return { state: 'fail', detail: `the last ${last.name} run on this head is ${last.status}` };
  return { state: 'pending', detail: `${last.name} is ${last.status} on this head` };
}

function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  const out = {};
  for (const line of m ? m[1].split(/\r?\n/) : []) {
    const kv = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

/** The gate of a `plan(` merge request (planning.md §6): spec files and the program entry only; handoff approved with a sparring_record. */
export function planGate({ slug, files, handoffText }) {
  const outside = (files || []).filter((f) => !f.startsWith(`.kiro/specs/${slug}/`) && !PLAN_PROGRAM.test(f));
  if (outside.length) return { state: 'fail', code: 'plan_scope', reason: `a plan( merge request changes only its spec folder and the program entry; it also changes ${outside.slice(0, 5).join(', ')}` };
  if (handoffText === null || handoffText === undefined) return { state: 'pending', code: 'plan_not_approved', reason: `.kiro/specs/${slug}/handoff.md is missing on this head` };
  const fm = frontMatter(handoffText);
  if (fm.state === 'parked') return { state: 'fail', code: 'plan_parked', reason: 'handoff.md says the plan is parked' };
  if (fm.state !== 'approved') return { state: 'pending', code: 'plan_not_approved', reason: `handoff.md says state: ${fm.state || 'none'}, not approved` };
  if (!fm.sparring_record) return { state: 'pending', code: 'plan_not_approved', reason: 'handoff.md is approved but names no sparring_record' };
  return { state: 'pass', code: 'plan_ready', reason: `approved, sparring record ${fm.sparring_record}` };
}

// ── queue mode: IO ───────────────────────────────────────────────────────────

const trainFile = (ctx, project) => path.join(ctx.workdir, `${project.name}.train.json`);
const validPosition = (p) => p && Number.isInteger(p.k) && Number.isInteger(p.iid) && [p.head, p.sha, p.tree].every((s) => SHA.test(s || '')) && p.ref === `train/${p.k}`;

function loadTrain(ctx, project) {
  try {
    const s = JSON.parse(fs.readFileSync(trainFile(ctx, project), 'utf8'));
    return {
      main: SHA.test(s?.main || '') ? s.main : null,
      positions: Array.isArray(s?.positions) && s.positions.every(validPosition) ? s.positions : [],
      dropped: s?.dropped && typeof s.dropped === 'object' && !Array.isArray(s.dropped) ? s.dropped : {},
    };
  } catch {
    return { main: null, positions: [], dropped: {} };
  }
}

function saveTrain(ctx, project, state) {
  if (ctx.dryRun) return;
  fs.mkdirSync(ctx.workdir, { recursive: true });
  const file = trainFile(ctx, project);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

const botIdentity = (ctx) => ({ GIT_AUTHOR_NAME: ctx.botUser, GIT_AUTHOR_EMAIL: ctx.botEmail, GIT_COMMITTER_NAME: ctx.botUser, GIT_COMMITTER_EMAIL: ctx.botEmail });
const showAt = (ctx, repo, rev, file) => gitRun(ctx, repo, ['show', `${rev}:${file}`], { allowFail: true });
const isAncestor = (ctx, repo, a, b) => gitRun(ctx, repo, ['merge-base', '--is-ancestor', a, b], { allowFail: true }) !== null;

/** git merge-tree --write-tree: { tree } for a clean merge, null for a conflict; any other git failure throws. */
function mergeTree(ctx, repo, a, b) {
  try {
    const out = execFileSync('git', [...GIT_CONFIG_ARGS, '-C', repo, 'merge-tree', '--write-tree', '--no-messages', a, b], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER, timeout: ctx.gitTimeoutMs, env: ctx.gitEnv,
    });
    const tree = out.split('\n')[0].trim();
    if (!SHA.test(tree)) throw new Error('git merge-tree printed no tree');
    return { tree };
  } catch (e) {
    if (e.status === 1) return null;
    const err = new Error(`git merge-tree failed: ${redact(String(e.stderr || e.message).trim().split('\n').slice(-1)[0], ctx.token)}`);
    err.code = 'git';
    throw err;
  }
}

const commitTree = (ctx, repo, tree, parents, message) => gitRun(ctx, repo, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], { env: botIdentity(ctx) });

/** The bot's clone of vitana-platform with main and the kiro/<slug>/* branches of `slugs`. Throws (fails closed) when unreachable. */
function platformClone(ctx, slugs) {
  const platform = ctx.projects.find((p) => p.name === PLATFORM_PROJECT);
  if (!platform) throw new Error(`the ${PLATFORM_PROJECT} project is not in the settings: cross-repo reviews cannot be read`);
  const repo = ensureClone(ctx, platform);
  for (const slug of slugs) gitRun(ctx, repo, ['fetch', '-q', '--prune', 'origin', `+refs/heads/kiro/${slug}/*:refs/remotes/origin/kiro/${slug}/*`]);
  return repo;
}

/** The checks of the newest pipeline for exactly `sha` (on `ref`, when given), read as M2's checksFor reads them. */
async function pipelineChecks(ctx, pid, project, sha, { ref } = {}) {
  const list = await ctx.client.get(`/projects/${pid}/pipelines`, { query: { sha, ...(ref ? { ref } : {}), order_by: 'id', sort: 'desc', per_page: 20 } });
  const pipeline = (Array.isArray(list) ? list : []).filter((p) => p.sha === sha && (!ref || p.ref === ref)).sort((a, b) => b.id - a.id)[0] || null;
  const jobs = pipeline ? await ctx.client.paginate(`/projects/${pid}/pipelines/${pipeline.id}/jobs`, { maxPages: 20 }) : [];
  const verdict = checksFor(pipeline, jobs, project.required_jobs, { onUnknown: (j) => ctx.log({ event: 'unknown_job_status', sha, job: j.name, status: String(j.status) }) });
  return { ...verdict, createdAt: pipeline?.created_at ?? null };
}

/** Same-repo review: M2's push-identity check (judgeReviewCommit, pushedByReviewer), then reviewCurrent. */
async function sameRepoReview(ctx, pid, repo, head, laneKey) {
  const commits = commitsInRange(repo, 'origin/main', head);
  const newest = commits.find((c) => c.review === laneKey && (c.verdict === 'accept' || c.verdict === 'changes'));
  const pushed = newest && newest.verdict === 'accept' && REVIEWER_RE.test(newest.reviewer || '') && SHA.test(newest.reviewedHead || '')
    ? await pushedByReviewer(ctx, pid, repo, newest.sha)
    : false;
  const judged = judgeReviewCommit(commits, laneKey, { pushed, reviewerUser: ctx.reviewerUser });
  if (!judged.ok) return { ok: false, code: judged.code, reason: judged.reason };
  const walk = localAfter(repo, judged.commit.reviewedHead, head, laneKey);
  const current = reviewCurrent(judged.commit.reviewedHead, head, walk.after, laneKey, walk.prDiffSame);
  if (!current.ok) return { ok: false, code: 'review_stale', reason: current.reason };
  const at = gitRun(ctx, repo, ['log', '-1', '--format=%cI', judged.commit.sha]);
  return { ok: true, code: 'review_found', reason: current.reason, entry: { sha: judged.commit.sha, reviewedHead: judged.commit.reviewedHead, reviewer: judged.commit.reviewer, at: new Date(at).toISOString() } };
}

/** Does a hot-file merge request wait? Yes while the previous landing of the same hot key has no STAGING-VERIFY result. */
async function hotFileWait(ctx, pid, repo, keys) {
  const log = gitRun(ctx, repo, ['log', '--first-parent', '-n', String(HOT_LOOKBACK), '--no-renames', '--name-only', '--format=%x1e%H%x1f%cI', 'origin/main']);
  let prev = null;
  for (const rec of log.split('\x1e').slice(1)) {
    const [header, ...files] = rec.split('\n');
    const [sha, at] = header.split('\x1f');
    if (hotKeys(files.filter(Boolean)).some((k) => keys.includes(k))) { prev = { sha, at }; break; }
  }
  if (!prev) return { wait: false };
  const short = prev.sha.slice(0, 8);
  const list = await ctx.client.get(`/projects/${pid}/pipelines`, { query: { sha: prev.sha, ref: 'main', order_by: 'id', sort: 'desc', per_page: 20 } });
  const pipe = (Array.isArray(list) ? list : []).filter((p) => p.sha === prev.sha && p.ref === 'main').sort((a, b) => b.id - a.id)[0];
  if (!pipe) {
    if (ctx.now() - timeOf(prev.at) > ctx.pipelineWaitMs) return { wait: false };
    return { wait: true, reason: `the previous hot-file landing ${short} has no main pipeline yet` };
  }
  const jobs = await ctx.client.paginate(`/projects/${pid}/pipelines/${pipe.id}/jobs`, { maxPages: 20 });
  const verify = jobs.filter((j) => /^staging-verify([:-].*)?$/.test(String(j.name || '')));
  if (verify.length) {
    return verify.every((j) => JOB_FINAL.has(j.status)) ? { wait: false } : { wait: true, reason: `STAGING-VERIFY of the previous hot-file landing ${short} has no result yet` };
  }
  return PIPELINE_FINAL.has(pipe.status) ? { wait: false } : { wait: true, reason: `the main pipeline of the previous hot-file landing ${short} is ${pipe.status}` };
}

/** One open merge request → its queue item: { iid, state, code, reason, head, files, hot, fixFirst, accept, acceptedAt, comment }. */
async function queueItem(ctx, project, repo, mr, env) {
  const base = { iid: mr.iid, mr, title: mr.title, head: mr.sha, labels: Array.isArray(mr.labels) ? [...mr.labels] : [], createdAt: mr.created_at, files: [], hot: [], fixFirst: false, accept: null };
  const item = (state, code, reason, extra = {}) => ({ ...base, state, code, reason, ...extra });
  if (!Number.isInteger(mr.iid) || !SHA.test(mr.sha || '') || !BRANCH_OK.test(mr.source_branch || '')) return item('none', 'bad_merge_request', 'the merge request has an unexpected iid, head or source branch');
  if (mr.draft === true || mr.work_in_progress === true) return item('none', 'draft', 'draft merge request');
  const plan = PLAN_TITLE.exec(mr.title || '');
  const laneKey = plan ? null : laneKeyOf(mr.title);
  if (!plan && (!laneKey || !VTID_TITLE.test(mr.title || ''))) return item('blocked', 'not_a_lane_mr', 'the title is not "VTID-nnnnn (<slug>/<lane>): …" or "plan(<slug>): …"', { comment: true });

  const head = fetchMrHead(ctx, repo, mr.iid);
  if (head !== mr.sha) return item('skip', 'head_moved', 'the head moved while the merge request was read; next tick');
  const files = gitRun(ctx, repo, ['diff', '--name-only', '--no-renames', `origin/main...${head}`]).split('\n').filter(Boolean);
  const protectedFiles = protectedTouched(files, PROTECTED_GATE_PATHS);
  const facts = { laneKey, files, hot: hotKeys(files), fixFirst: fixFirst(laneKey), protectedFiles };
  if (protectedFiles.length) return item('blocked', 'protected_gate_file', `protected gate file(s) changed (${protectedFiles.slice(0, 5).join(', ')}): the owner merges it`, { ...facts, comment: true });
  const dropped = env.dropped[mr.iid];
  if (dropped && dropped.head === head) return item('blocked', dropped.code, dropped.reason, { ...facts, comment: true });
  const checksHead = env.checksHead(mr.iid, head);

  if (plan) {
    const slug = plan[1];
    const gate = planGate({ slug, files, handoffText: showAt(ctx, repo, head, `.kiro/specs/${slug}/handoff.md`) });
    if (gate.state === 'fail') return item('blocked', gate.code, gate.reason, { ...facts, comment: true });
    if (gate.state === 'pending') return item('waiting', gate.code, gate.reason, facts);
    const statuses = await ctx.client.paginate(`/projects/${env.pid}/repository/commits/${checksHead}/statuses`, { maxPages: 5 });
    const spar = planSparVerdict(statuses, { users: ctx.statusUsers });
    if (spar.state === 'fail') return item('blocked', 'plan_spar_failed', spar.detail, { ...facts, comment: true });
    if (spar.state === 'pending') return item('waiting', 'plan_spar_pending', spar.detail, facts);
    const checks = await pipelineChecks(ctx, env.pid, project, checksHead);
    if (checks.state === 'fail') return item('blocked', checks.kind === 'required' ? 'required_job_missing' : 'checks_failed', checks.detail, { ...facts, comment: true });
    if (checks.state === 'pending') return item('waiting', 'checks_pending', checks.detail, facts);
    return item('ready', 'ready', `${gate.reason}; ${spar.detail}; ${checks.detail}`, { ...facts, acceptedAt: spar.at ?? mr.created_at });
  }

  const review = env.platformRepo
    ? crossRepoReview({ platformRepo: env.platformRepo, repo, head, laneKey })
    : await sameRepoReview(ctx, env.pid, repo, head, laneKey);

  const matched = matchingRules(files, env.rules);
  if (matched.length) {
    const runs = await assistRuns(ctx, env.pid, mr.iid, matched);
    const a = assistActions({ head, files, rules: matched, runs, accepted: review.ok, protectedFiles });
    if (a.state === 'trigger') {
      for (const rule of a.trigger) {
        await triggerAssist({ ...ctx, git: (args) => gitRun(ctx, repo, args) }, { pid: env.pid, iid: mr.iid, head, rule, mainSha: env.mainSha, sourceBranch: mr.source_branch });
      }
      return item('waiting', 'assist_pending', a.reason, facts);
    }
    if (a.state === 'pending') return item('waiting', 'assist_pending', a.reason, facts);
    if (a.state === 'failed') return item('blocked', 'assist_failed', a.reason, { ...facts, comment: true });
  }

  if (!review.ok) return item('blocked', review.code, review.reason, { ...facts, comment: true });
  const checks = await pipelineChecks(ctx, env.pid, project, checksHead);
  if (checks.state === 'fail') return item('blocked', checks.kind === 'required' ? 'required_job_missing' : 'checks_failed', checks.detail, { ...facts, comment: true });
  if (checks.state === 'pending') return item('waiting', 'checks_pending', checks.detail, facts);
  if (facts.hot.length) {
    const w = await hotFileWait(ctx, env.pid, repo, facts.hot);
    if (w.wait) return item('waiting', 'hot_file_waits', w.reason, facts);
  }
  if (Number(gitRun(ctx, repo, ['rev-list', '--count', `${head}..origin/main`])) > 0) {
    // The landing merges main into the branch; reviewCurrent keeps the review only when no governance or protected gate
    // file comes in (land-guard.mjs mergeKeepsReview), so such a branch is left alone, as M2's update step does.
    const mb = gitRun(ctx, repo, ['merge-base', head, 'origin/main']);
    const incoming = gitRun(ctx, repo, ['diff', '--name-only', '--no-renames', mb, 'origin/main']).split('\n').filter(Boolean);
    const lapsing = protectedTouched(incoming, GOVERNANCE_GLOBS);
    if (lapsing.length) return item('blocked', 'review_would_lapse', `main brought in governance or protected gate file(s) (${lapsing.slice(0, 5).join(', ')}): merging it would end the review's validity`, { ...facts, comment: true });
  }
  const accept = { reviewedHead: review.entry.reviewedHead, reviewer: review.entry.reviewer, acceptedAt: review.entry.at };
  return item('ready', 'ready', `${review.reason}; ${checks.detail}`, { ...facts, accept, acceptedAt: accept.acceptedAt });
}

async function setQueueLabel(ctx, pid, it, label) {
  const change = labelChange(it.labels, label);
  if (!change) return false;
  if (ctx.dryRun) { ctx.log({ event: 'would_label', mr: it.iid, label }); return false; }
  await ctx.client.put(`/projects/${pid}/merge_requests/${it.iid}`, { body: change });
  const remove = String(change.remove_labels || '').split(',').filter(Boolean);
  it.labels = [...it.labels.filter((l) => !remove.includes(l)), ...(change.add_labels ? [change.add_labels] : [])];
  ctx.log({ event: 'labelled', mr: it.iid, label });
  return true;
}

async function ensureQueueNote(ctx, pid, it) {
  const text = QUEUE_COMMENT_TEXT[it.code] ?? COMMENT_TEXT[it.code];
  if (!text) return false;
  const marker = `<!-- vitana-land:${it.code}:${it.head} -->`;
  const notes = await ctx.client.paginate(`/projects/${pid}/merge_requests/${it.iid}/notes`, { query: { sort: 'desc', order_by: 'created_at' }, maxPages: 20 });
  if (notes.some((n) => typeof n?.body === 'string' && n.body.includes(marker) && n.author?.username === ctx.botUser)) return false;
  if (ctx.dryRun) { ctx.log({ event: 'would_comment', mr: it.iid, reason: it.code }); return false; }
  await ctx.client.post(`/projects/${pid}/merge_requests/${it.iid}/notes`, { body: { body: `${text}\n\n${marker}` } });
  ctx.log({ event: 'commented', mr: it.iid, reason: it.code });
  return true;
}

/** Take a merge request out of the train until its head changes; it goes back to its builder with one comment. */
function dropItem(ctx, state, it, code, reason) {
  Object.assign(it, { state: 'blocked', code, reason, comment: true });
  state.dropped[it.iid] = { head: it.head, code, reason };
  ctx.log({ event: 'train_dropped', mr: it.iid, reason: code, detail: reason });
}

/** Land merge request `it` of a green position: merge main into it (ci.skip) when needed, check the tree, land pinned to that head. */
async function landPosition(ctx, repo, pid, pos, it) {
  const mr = it.mr;
  const main = gitRun(ctx, repo, ['rev-parse', 'origin/main']);
  let next = it.head;
  if (isAncestor(ctx, repo, main, it.head)) {
    if (gitRun(ctx, repo, ['rev-parse', `${it.head}^{tree}`]) !== pos.tree) {
      ctx.log({ event: 'train_tree_mismatch', mr: it.iid, position: pos.k, detail: 'the head\'s tree is not the tested tree of its position' });
      return { mismatch: true };
    }
  } else {
    const merged = mergeTree(ctx, repo, it.head, main);
    if (!merged || merged.tree !== pos.tree) {
      ctx.log({ event: 'train_tree_mismatch', mr: it.iid, position: pos.k, detail: merged ? 'main merged into the branch is not the tested tree of its position' : 'main no longer merges cleanly into the branch' });
      return { mismatch: true };
    }
    next = commitTree(ctx, repo, merged.tree, [it.head, main], `Merge branch 'main' into ${mr.source_branch}\n\nCollab-Session: ${ctx.botUser}`);
  }
  if (ctx.dryRun) { ctx.log({ event: 'would_land', mr: it.iid, position: pos.k, head: next }); return { landed: false }; }
  if (next !== it.head) {
    await setQueueLabel(ctx, pid, it, 'queue-updating');
    gitRun(ctx, repo, ['push', '-q', '-o', 'ci.skip', 'origin', `${next}:refs/heads/${mr.source_branch}`]);
    pos.updated = next;
    ctx.log({ event: 'updated', mr: it.iid, from: it.head, to: next, ciSkip: true });
    it.head = next; // the merge request's head is now the one the bot made: a drop or a comment in this tick is for it
  }
  const body = { sha: next, squash: true, squash_commit_message: queueSquashMessage(mr, it.accept), should_remove_source_branch: true };
  let merged = false;
  try {
    const res = await ctx.client.put(`/projects/${pid}/merge_requests/${it.iid}/merge`, { body, retries: 0 });
    merged = res?.state === 'merged';
  } catch (e) {
    ctx.log({ event: 'merge_call_failed', mr: it.iid, status: e.status ?? null, code: e.code ?? null, error: redact(e.message, ctx.token) });
  }
  if (!merged) {
    const current = await ctx.client.get(`/projects/${pid}/merge_requests/${it.iid}`).catch(() => null);
    merged = current?.state === 'merged';
  }
  if (!merged) { ctx.log({ event: 'not_landed', mr: it.iid, position: pos.k, reason: 'the merge call was refused; the next tick tries again' }); return { landed: false, refused: true }; }
  gitRun(ctx, repo, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const tip = gitRun(ctx, repo, ['rev-parse', 'origin/main']);
  const tested = gitRun(ctx, repo, ['rev-parse', `${tip}^{tree}`]) === pos.tree;
  ctx.log({ event: 'landed', mr: it.iid, position: pos.k, head: next, main: tip, testedTree: tested });
  return { landed: true, main: tip, testedTree: tested };
}

/** Land, drop and rebuild the train of one project; `items` are this tick's queue items (states may change here). */
async function runTrain(ctx, project, repo, pid, state, items, order) {
  const byIid = new Map(items.map((i) => [i.iid, i]));
  let main = gitRun(ctx, repo, ['rev-parse', 'origin/main']);
  let positions = [...state.positions].sort((a, b) => a.k - b.k);
  if (positions.length && state.main !== main) {
    ctx.log({ event: 'train_rebuilt', reason: 'main_moved', from: state.main, to: main });
    positions = [];
  }
  const bad = positions.findIndex((p) => { const it = byIid.get(p.iid); return !it || it.state !== 'ready' || (it.head !== p.head && it.head !== p.updated); });
  if (bad >= 0) positions = positions.slice(0, bad);

  const verdicts = [];
  const trainProject = { ...project, required_jobs: trainRequiredJobs(project) };
  for (const p of positions) verdicts.push(await pipelineChecks(ctx, pid, trainProject, p.sha, { ref: p.ref }));
  const failedAt = verdicts.findIndex((v) => v.state === 'fail');
  let end = failedAt >= 0 ? failedAt : positions.length;
  let landed = 0;
  let mainMovedByUs = false;
  for (let i = 0; i < end; i++) {
    if (verdicts[i].state !== 'pass') break;
    const it = byIid.get(positions[i].iid);
    const r = await landPosition(ctx, repo, pid, positions[i], it);
    if (r.mismatch) { end = i; break; }
    if (!r.landed) {
      const held = { waitingSince: verdicts[i].createdAt };
      if (r.refused && lostItsTurn(ctx, held)) {
        // GitLab keeps refusing this merge (an unresolved thread, a merge setting the bot does not read). As in M2's loop, it holds
        // the turn for 60 minutes from its pipeline's creation and then loses it: it leaves the train (one comment, until a new
        // head), and the positions behind it, which contain its change, are rebuilt without it.
        ctx.log({ event: 'lost_its_turn', mr: it.iid, position: positions[i].k, reason: 'merge_refused', waitedMinutes: waitedMinutes(ctx, held) });
        dropItem(ctx, state, it, 'merge_refused_too_long', `GitLab refused the merge of position ${positions[i].k} for more than ${Math.round(ctx.pipelineWaitMs / 60_000)} minutes`);
        end = i;
      }
      break;
    }
    it.landed = true;
    landed = i + 1;
    main = r.main;
    mainMovedByUs = true;
    if (!r.testedTree) { end = i + 1; break; } // fail closed: main is not the tree this train tested; rebuild what is behind
  }
  if (failedAt >= 0 && end === failedAt) {
    const p = positions[failedAt];
    dropItem(ctx, state, byIid.get(p.iid), 'train_failed', `position ${p.k} of the landing train failed: ${verdicts[failedAt].detail}`);
  }
  const kept = positions.slice(landed, end);
  const keptIids = new Set(kept.map((p) => p.iid));
  if (mainMovedByUs && kept.length === 0) ctx.log({ event: 'train_cycle_done', landed });

  // Fill the train behind the kept positions, in queue order.
  const taken = kept.map((p) => byIid.get(p.iid));
  let pool = order.filter((x) => x.state === 'ready' && !x.landed && !keptIids.has(x.iid));
  let baseSha = kept.length ? kept[kept.length - 1].sha : main;
  let k = kept.length ? kept[kept.length - 1].k : 0;
  const built = [];
  for (;;) {
    const next = trainSelect(pool, { capacity: project.queue.positions, kept: taken })[0];
    if (!next) break;
    pool = pool.filter((x) => x.iid !== next.iid);
    const merged = mergeTree(ctx, repo, baseSha, next.head);
    if (!merged) {
      if (k === 0) dropItem(ctx, state, next, 'conflict', 'merging main into this branch conflicts');
      else dropItem(ctx, state, next, 'train_conflict', `it conflicts with position ${k} of the landing train`);
      continue;
    }
    k += 1;
    const sha = commitTree(ctx, repo, merged.tree, [baseSha, next.head], `train/${k}: !${next.iid} ${String(next.title || '').replace(/\s+/g, ' ').trim()}\n\nCollab-Session: ${ctx.botUser}`);
    built.push({ k, iid: next.iid, head: next.head, ref: `train/${k}`, sha, tree: merged.tree });
    taken.push(next);
    baseSha = sha;
  }
  const train = [...kept, ...built];
  for (const p of train) Object.assign(byIid.get(p.iid), { position: p.k });

  // Move the train refs: delete every train/* ref that is not a wanted position, then push the new positions (never a force).
  const remote = new Map(gitRun(ctx, repo, ['ls-remote', 'origin', 'refs/heads/train/*']).split('\n').filter(Boolean).map((l) => l.split('\t').reverse()));
  const wanted = new Map(train.map((p) => [`refs/heads/${p.ref}`, p.sha]));
  const stale = [...remote.keys()].filter((ref) => wanted.get(ref) !== remote.get(ref));
  const fresh = train.filter((p) => remote.get(`refs/heads/${p.ref}`) !== p.sha);
  if (ctx.dryRun) {
    for (const p of fresh) ctx.log({ event: 'would_build_train', position: p.k, mr: p.iid, sha: p.sha });
  } else {
    if (stale.length) gitRun(ctx, repo, ['push', '-q', 'origin', ...stale.map((ref) => `:${ref}`)]);
    if (fresh.length) gitRun(ctx, repo, ['push', '-q', 'origin', ...fresh.map((p) => `${p.sha}:refs/heads/${p.ref}`)]);
    for (const p of fresh) ctx.log({ event: 'train_position', position: p.k, mr: p.iid, sha: p.sha });
  }
  const open = new Set(items.filter((i) => !i.landed).map((i) => String(i.iid)));
  const dropped = Object.fromEntries(Object.entries(state.dropped).filter(([iid]) => open.has(iid)));
  saveTrain(ctx, project, { main, positions: train, dropped });
}

/** One tick of a queue project. statusOnly (and `status`) reads and decides only. Rows: { project, iid, action: <queue state>, … }. */
async function tickQueue(ctx, project, { only, statusOnly = false } = {}) {
  const pid = projectId(project.path);
  const info = await ctx.client.get(`/projects/${pid}`);
  if (info?.default_branch !== 'main') {
    ctx.log({ event: 'project_skipped', project: project.name, reason: `default branch is "${info?.default_branch}"; the land-guard functions read origin/main` });
    return [];
  }
  const repo = ensureClone(ctx, project);
  const mrs = await openMergeRequests(ctx, pid, 'main');
  const slugs = [...new Set(mrs.map((m) => (laneKeyOf(m.title) || '').split('/')[0]).filter(Boolean))];
  const platformRepo = project.name === PLATFORM_PROJECT ? null : platformClone(ctx, slugs);
  const mainSha = gitRun(ctx, repo, ['rev-parse', 'origin/main']);
  const mainPipelines = await ctx.client.get(`/projects/${pid}/pipelines`, { query: { ref: 'main', order_by: 'id', sort: 'desc', per_page: 20 } });
  const { red } = mainRed(Array.isArray(mainPipelines) ? mainPipelines : []);
  const rules = loadAssistRules(ctx.services, project.name);
  const state = loadTrain(ctx, project);
  const posByIid = new Map(state.positions.map((p) => [p.iid, p]));
  const env = {
    pid, platformRepo, rules, mainSha, dropped: state.dropped,
    // a head the bot itself made (main merged in with ci.skip) is judged by the checks of the head it was made from
    checksHead: (iid, head) => { const p = posByIid.get(iid); return p && p.updated === head ? p.head : head; },
  };
  const items = [];
  for (const mr of mrs) items.push(await queueItem(ctx, project, repo, mr, env));
  const { order, paused } = queueOrder(items, { red });
  for (const it of paused) Object.assign(it, { state: 'paused', code: 'main_red', reason: 'main is red: only revert and fix-main merge requests land until it is green' });
  if (!statusOnly) {
    await runTrain(ctx, project, repo, pid, state, items, order);
    for (const it of items) {
      if (it.landed || it.state === 'skip') continue;
      await setQueueLabel(ctx, pid, it, LABEL_OF[it.state] ?? null);
      if (it.state === 'blocked' && it.comment) await ensureQueueNote(ctx, pid, it);
    }
  }
  const rows = [];
  for (const it of items) {
    ctx.log({ event: 'queue_state', project: project.name, mr: it.iid, state: it.landed ? 'landed' : it.state, reason: it.code, position: it.position ?? null, detail: it.reason });
    if (only === undefined || it.iid === only) {
      rows.push({ project: project.name, iid: it.iid, title: it.title, head: it.head, action: it.landed ? 'landed' : it.state, reasonCode: it.code, reason: it.reason, laneKey: it.laneKey ?? null, position: it.position ?? null });
    }
  }
  return rows;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = v;
      i++;
    } else o._.push(a);
  }
  return o;
}

export function loadProjects(settingsFile) {
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (!s || typeof s !== 'object' || typeof s.group !== 'string' || !s.projects || typeof s.projects !== 'object') throw new Error(`${settingsFile}: needs "group" and "projects"`);
  return Object.entries(s.projects).map(([name, p]) => ({
    name, path: `${s.group}/${name}`, landing: p?.landing === true, required_jobs: Array.isArray(p?.required_jobs) ? p.required_jobs.map(String) : [],
    ...(p?.queue !== undefined && p?.queue !== null ? { queue: p.queue === false ? false : normalizeQueue(p.queue) } : {}),
    ...(Array.isArray(p?.train_required_jobs) ? { train_required_jobs: p.train_required_jobs.map(String) } : {}),
  }));
}

/**
 * The projects as `run`, `merge` and `status` read them: through `loadEffectiveProjects` of scripts/eng/gitlab-settings.mjs,
 * the view of the delivery cutover marker (plan agentic-delivery §8.2: after the cut the two projects land), when that module
 * exports it; otherwise the settings file itself, as M2 reads it (the same view for a file without cutover blocks).
 * `--marker-file` and `--ci-dir` reach the loader; without them its own defaults apply. A loader error fails closed.
 */
export async function readProjects(o, lib = gitlabSettings) {
  const file = o.settings || DEFAULTS.settings;
  if (typeof lib?.loadEffectiveProjects !== 'function') return loadProjects(file);
  const opts = { ...(o['marker-file'] ? { markerFile: o['marker-file'] } : {}), ...(o['ci-dir'] ? { ciDir: o['ci-dir'] } : {}) };
  const list = await lib.loadEffectiveProjects(file, opts);
  if (!Array.isArray(list)) throw new Error(`${file}: loadEffectiveProjects returned no project list`);
  return list.map((p) => ({
    name: String(p.name), path: String(p.path), landing: p.landing === true, required_jobs: Array.isArray(p.required_jobs) ? p.required_jobs.map(String) : [],
    ...(p.queue !== undefined && p.queue !== null ? { queue: p.queue === false ? false : normalizeQueue(p.queue) } : {}),
    ...(Array.isArray(p.train_required_jobs) ? { train_required_jobs: p.train_required_jobs.map(String) } : {}),
  }));
}

/** A list option: an array, or a comma-separated string (empty = none); absent → the default. */
const nameList = (v, fallback) => (v === undefined || v === null ? [...fallback] : Array.isArray(v) ? v.map(String) : String(v).split(',').map((s) => s.trim()).filter(Boolean));

export function makeContext(o, { env = process.env, fetch: fetchImpl, now = Date.now, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const workdir = o.workdir || DEFAULTS.workdir;
  const tokenFile = o['token-file'] || DEFAULTS.tokenFile;
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const baseUrl = o.url || DEFAULTS.url;
  const client = createClient({ baseUrl, token, ...(fetchImpl ? { fetch: fetchImpl, sleep: async () => {} } : {}) });
  const gitBase = (o['git-base'] || baseUrl).replace(/\/+$/, '');
  return {
    client, token, workdir, now,
    projects: o.projectsOverride || loadProjects(o.settings || DEFAULTS.settings),
    remoteUrl: o.remoteUrl || ((p) => `${gitBase}/${p.path}.git`),
    gitEnv: { ...env, ...askpass(workdir, tokenFile), GIT_CONFIG_NOSYSTEM: '1' },
    gitTimeoutMs: 120_000,
    reviewerUser: o.reviewerUser || DEFAULTS.reviewerUser,
    botUser: o.botUser || DEFAULTS.botUser,
    botEmail: o.botEmail || DEFAULTS.botEmail,
    pipelineWaitMs: (o.pipelineWaitMinutes ?? DEFAULTS.pipelineWaitMinutes) * 60_000,
    eventPages: o.eventPages ?? DEFAULTS.eventPages,
    services: o.services || DEFAULTS.services,
    statusUsers: Array.isArray(o.statusUsers) ? o.statusUsers.map(String) : [o.botUser || DEFAULTS.botUser],
    queueProjects: nameList(o.queueProjects ?? o['queue-projects'], DEFAULTS.queueProjects),
    dryRun: o.dryRun === true,
    log: (entry) => write(redact(JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }), token)),
  };
}

export async function main(argv, deps = {}) {
  const out = deps.stdout || ((s) => process.stdout.write(s));
  let o;
  try { o = { ...parseArgs(argv), ...(deps.overrides || {}) }; } catch (e) { out(`gitlab-land: ${e.message}\n`); return 1; }
  const cmd = o._[0];
  if (!['run', 'merge', 'status'].includes(cmd)) {
    out('usage: gitlab-land.mjs run [--dry-run] | merge <project> <iid> [--dry-run] | status   [--settings f] [--url u] [--token-file f] [--workdir d] [--git-base u] [--services f] [--queue-projects a,b] [--marker-file f] [--ci-dir d]\n');
    return 1;
  }
  if (!o.projectsOverride) {
    try { o = { ...o, projectsOverride: await readProjects(o, deps.settingsLib ?? gitlabSettings) }; } catch (e) { out(`gitlab-land: ${String(e.message).split('\n')[0]}\n`); return 1; }
  }
  let ctx;
  try { ctx = makeContext(o, { ...deps, write: (line) => out(`${line}\n`) }); } catch (e) { out(`gitlab-land: ${String(e.message).split('\n')[0]}\n`); return 1; }
  try {
    if (cmd === 'status') {
      ctx.dryRun = true;
      const { rows, failed } = await tick(ctx, { statusOnly: true });
      for (const r of rows) out(`${r.project}!${r.iid}\t${r.action}\t${r.reasonCode}\t${r.reason}\n`);
      return failed ? 1 : 0;
    }
    if (cmd === 'merge') {
      const [, name, iidText] = o._;
      const iid = Number(iidText);
      if (!name || !Number.isInteger(iid)) { out('usage: gitlab-land.mjs merge <project> <iid>\n'); return 1; }
      if (!ctx.projects.some((p) => p.name === name && p.landing === true)) { out(`gitlab-land: ${name} is not a project with landing: true\n`); return 1; }
      const { rows, failed } = await tick(ctx, { project: name, only: iid });
      if (rows.length === 0) out(`gitlab-land: no open merge request !${iid} in ${name}\n`);
      return failed || rows.length === 0 ? 1 : 0;
    }
    const { failed } = await tick(ctx);
    return failed ? 1 : 0;
  } catch (e) {
    ctx.log({ event: 'failed', error: redact(e.message, ctx.token) });
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
