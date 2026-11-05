// The merge bot of the self-hosted GitLab (plan eng-gitlab-m2 §3.4, lane merge-bot). Free tier: no merge trains, no required
// approvals. One timer tick looks at the open merge requests of every project with `landing: true`, oldest first, and does at
// most one thing per project: land one, bring one up to date, or wait for the oldest one's pipeline.
//
//   node scripts/eng/gitlab-land.mjs run    [--dry-run]            one tick (the systemd timer runs it every minute)
//   node scripts/eng/gitlab-land.mjs merge  <project> <iid> [--dry-run]   decide and act on one merge request now
//   node scripts/eng/gitlab-land.mjs status                        what the bot would do for every open merge request; writes nothing
//   options: --settings <gitlab-settings.json>  --url <GitLab URL>  --token-file <file>  --workdir <dir>  --git-base <URL>
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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, projectId, redact } from './gitlab-api.mjs';
import { laneKeyOf, localAfter, reviewCurrent, checksVerdict, protectedTouched, mergeDecision } from '../collab/land-guard.mjs';
import { commitsInRange, PROTECTED_GATE_PATHS, GOVERNANCE_PATHS } from '../collab/queue.mjs';

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
  }));
}

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
    out('usage: gitlab-land.mjs run [--dry-run] | merge <project> <iid> [--dry-run] | status   [--settings f] [--url u] [--token-file f] [--workdir d] [--git-base u]\n');
    return 1;
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
