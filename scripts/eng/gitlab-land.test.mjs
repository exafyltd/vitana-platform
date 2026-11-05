// Tests of the merge bot (plan eng-gitlab-m2 §3.4, lane merge-bot): scripts/eng/gitlab-land.mjs and its two systemd units.
// The git side is real: every scenario builds a bare repository that plays the GitLab project, a clone to author commits in,
// and the refs/merge-requests/<iid>/head refs GitLab keeps. The GitLab API is the recording fake fetch of lane gitlab-client.
// Dependency-free Node (node:test), so UNIT.yml runs it with no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFetch } from './testing/fake-fetch.mjs';
import * as land from './gitlab-land.mjs';
import { mergeDecision, checksVerdict } from '../collab/land-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNITS = path.resolve(HERE, '..', '..', 'infra', 'gitlab-engineering', 'host', 'units');
const NOW = Date.parse('2026-11-05T10:30:00Z');
const TOKEN = 'fixture-token-0123456789abcdef';
const REVIEWER = 'agent:vitana-lane-reviewer (claude-sonnet-5.5)';
const P = '/api/v4/projects/vitana%2Frehearsal';

// ── git helpers ──────────────────────────────────────────────────────────────
const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'builder', GIT_AUTHOR_EMAIL: 'builder@test', GIT_COMMITTER_NAME: 'builder', GIT_COMMITTER_EMAIL: 'builder@test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const refs = (remote) => g(remote, 'for-each-ref', '--format=%(refname) %(objectname)');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const laneFile = (lane) => `---\nlane: ${lane}\nstate: in-review\n---\n# Lane ${lane}\n\n## Log\n`;

function newWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-test-'));
  tmpDirs.push(root);
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', remote, work], { env: GIT_ENV, stdio: 'ignore' });
  g(work, 'checkout', '-q', '-b', 'main');
  write(work, 'README.md', 'demo\n');
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'initial');
  g(work, 'push', '-q', 'origin', 'main');
  return { root, remote, work, reviews: 0 };
}
function addLane(w, lane) {
  g(w.work, 'checkout', '-q', 'main');
  write(w.work, `.kiro/specs/demo/lanes/${lane}.md`, laneFile(lane));
  g(w.work, 'add', '-A');
  g(w.work, 'commit', '-q', '-m', `lane ${lane}`);
  g(w.work, 'push', '-q', 'origin', 'main');
}
function advanceMain(w, file, text) {
  g(w.work, 'checkout', '-q', 'main');
  write(w.work, file, text);
  g(w.work, 'add', '-A');
  g(w.work, 'commit', '-q', '-m', `main moves: ${file}`);
  g(w.work, 'push', '-q', 'origin', 'main');
  return g(w.work, 'rev-parse', 'HEAD');
}
function addFeature(w, { lane, branch, files }) {
  g(w.work, 'fetch', '-q', 'origin');
  g(w.work, 'checkout', '-q', '-B', branch, 'origin/main');
  for (const [f, t] of Object.entries(files ?? { [`scripts/${lane}.mjs`]: 'export const x = 1;\n' })) write(w.work, f, t);
  g(w.work, 'add', '-A');
  g(w.work, 'commit', '-q', '-m', `VTID-05999 (demo/${lane}): add the feature\n\nCollab-Session: kiro-exafy-202611050900-aaaa\nCollab-Lane: demo/${lane}`);
  return g(w.work, 'rev-parse', 'HEAD');
}
function addReview(w, { lane, branch, reviewed, verdict = 'accept', reviewer = REVIEWER }) {
  g(w.work, 'checkout', '-q', branch);
  w.reviews += 1;
  const session = `agent-vitana-lane-reviewer-20261105100${w.reviews}-abcd`;
  fs.appendFileSync(path.join(w.work, `.kiro/specs/demo/lanes/${lane}.md`), `\n### 2026-11-05T10:0${w.reviews}Z · ${session} · review\nreview: ${verdict}\nhead: ${reviewed}\nreviewer: ${reviewer}\n`);
  g(w.work, 'add', '-A');
  g(w.work, 'commit', '-q', '-m', `review(demo/${lane}): ${verdict}\n\nCollab-Session: ${session}\nCollab-Review: demo/${lane}\nCollab-Verdict: ${verdict}\nCollab-Reviewer: ${reviewer}\nCollab-Reviewed-Head: ${reviewed}`);
  return g(w.work, 'rev-parse', 'HEAD');
}
function addCommit(w, { branch, file, text, message = 'more work' }) {
  g(w.work, 'checkout', '-q', branch);
  write(w.work, file, text);
  g(w.work, 'add', '-A');
  g(w.work, 'commit', '-q', '-m', `${message}\n\nCollab-Session: kiro-exafy-202611050900-aaaa`);
  return g(w.work, 'rev-parse', 'HEAD');
}
function publish(w, { branch, iid, force = false }) {
  g(w.work, 'push', '-q', ...(force ? ['--force'] : []), 'origin', `${branch}:refs/heads/${branch}`);
  g(w.remote, 'update-ref', `refs/merge-requests/${iid}/head`, g(w.work, 'rev-parse', branch));
}

// ── fake GitLab ──────────────────────────────────────────────────────────────
function newState() {
  return { mrs: [], events: [], pipelines: [], jobs: {}, notes: {}, merged: new Set(), mergeResponse: null, defaultBranch: 'main', eventsFail: false };
}
const greenJobs = (n = 0) => [
  { id: 10 + n, name: 'unit', status: 'success', allow_failure: false, started_at: '2026-11-05T10:21:00Z' },
  { id: 11 + n, name: 'build', status: 'success', allow_failure: false, started_at: '2026-11-05T10:21:00Z' },
  { id: 12 + n, name: 'lint', status: 'failed', allow_failure: true, started_at: '2026-11-05T10:21:00Z' },
];
function addMr(s, { iid, lane, sha, branch, title, createdAt, draft = false, description = 'Body text of the merge request.' }) {
  s.mrs.push({
    iid, title: title ?? `VTID-05999 (demo/${lane}): add the feature`, description, sha, source_branch: branch, target_branch: 'main', draft,
    state: 'opened', created_at: createdAt ?? `2026-11-05T09:0${iid % 10}:00Z`, updated_at: '2026-11-05T10:20:00Z',
  });
  s.notes[iid] = [];
}
function addPipeline(s, sha, { id = 900 + s.pipelines.length, status = 'success', createdAt = '2026-11-05T10:20:00Z', jobs } = {}) {
  s.pipelines.push({ id, sha, status, created_at: createdAt });
  s.jobs[id] = jobs ?? greenJobs(id * 10);
  return id;
}
const reviewerPush = (s, from, to, count = 1, user = 'agent-reviewer') => s.events.unshift({ author_username: user, push_data: { commit_from: from, commit_to: to, commit_count: count, action: 'pushed', ref_type: 'branch' } });

function gitlab(s) {
  const f = fakeFetch();
  const mrOf = (call) => s.mrs.find((m) => m.iid === Number(/merge_requests\/(\d+)/.exec(call.path)[1]));
  f.route('GET', P, () => ({ json: { id: 42, default_branch: s.defaultBranch } }));
  f.route('GET', `${P}/merge_requests`, () => ({ json: s.mrs.filter((m) => m.state === 'opened' && !s.merged.has(m.iid)) }));
  f.route('GET', /\/merge_requests\/\d+$/, (call) => { const m = mrOf(call); return { json: { ...m, state: s.merged.has(m.iid) ? 'merged' : m.state } }; });
  f.route('GET', `${P}/events`, () => (s.eventsFail ? { status: 500, json: { message: 'boom' } } : { json: s.events }));
  f.route('GET', `${P}/pipelines`, (call) => ({ json: s.pipelines.filter((p) => p.sha === call.query.sha?.[0]).sort((a, b) => b.id - a.id) }));
  f.route('GET', /\/pipelines\/\d+\/jobs$/, (call) => ({ json: s.jobs[Number(/pipelines\/(\d+)\/jobs/.exec(call.path)[1])] ?? [] }));
  f.route('GET', /\/merge_requests\/\d+\/notes$/, (call) => ({ json: s.notes[mrOf(call).iid] ?? [] }));
  f.route('POST', /\/merge_requests\/\d+\/notes$/, (call) => { const m = mrOf(call); s.notes[m.iid].push({ body: call.body.body, author: { username: 'bot-land' } }); return { status: 201, json: { id: 1 } }; });
  f.route('PUT', /\/merge_requests\/\d+\/merge$/, (call) => {
    if (s.mergeResponse) return s.mergeResponse(call, s);
    const m = mrOf(call); s.merged.add(m.iid); return { json: { iid: m.iid, state: 'merged', merge_commit_sha: null } };
  });
  return f;
}

function context(w, f, extra = {}, deps = {}) {
  const tokenFile = path.join(w.root, 'token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const lines = [];
  const ctx = land.makeContext({
    workdir: path.join(w.root, 'land'), 'token-file': tokenFile, url: 'https://gitlab.test',
    projectsOverride: [{ name: 'rehearsal', path: 'vitana/rehearsal', landing: true, required_jobs: ['unit', 'build'] }],
    remoteUrl: () => w.remote, ...extra,
  }, { fetch: f, now: () => NOW, write: (l) => lines.push(l), ...deps });
  return { ctx, lines, events: () => lines.map((l) => JSON.parse(l)) };
}

/** A reviewed, green, up-to-date merge request: lane-a, iid 7. `lanes: 2` adds a younger lane-b (iid 8), also ready. */
function scenario({ lanes = 1 } = {}) {
  const w = newWorld();
  const s = newState();
  const names = ['lane-a', 'lane-b'].slice(0, lanes);
  for (const lane of names) addLane(w, lane);
  const out = { w, s, mrs: {} };
  names.forEach((lane, i) => {
    const iid = 7 + i;
    const branch = `kiro/demo/${lane}`;
    const F = addFeature(w, { lane, branch });
    const R = addReview(w, { lane, branch, reviewed: F });
    publish(w, { branch, iid });
    addMr(s, { iid, lane, sha: R, branch });
    reviewerPush(s, F, R);
    addPipeline(s, R);
    out.mrs[lane] = { iid, branch, F, R, lane };
  });
  Object.assign(out, out.mrs['lane-a']);
  return out;
}
/** One more reviewed, green merge request, cut from the CURRENT origin/main (so it is up to date even when main moved after the others). */
function addReadyLane(w, s, { lane, iid }) {
  addLane(w, lane);
  const branch = `kiro/demo/${lane}`;
  const F = addFeature(w, { lane, branch });
  const R = addReview(w, { lane, branch, reviewed: F });
  publish(w, { branch, iid });
  addMr(s, { iid, lane, sha: R, branch });
  reviewerPush(s, F, R);
  addPipeline(s, R);
  return { iid, branch, F, R, lane };
}
const run = async (sc, opts = {}) => {
  const f = gitlab(sc.s);
  const c = context(sc.w, f, opts.extra, opts.deps);
  if (opts.dryRun) c.ctx.dryRun = true;
  const result = await land.tick(c.ctx, opts.tick);
  return { f, ...c, ...result };
};
const merges = (f) => f.calls.filter((c) => c.method === 'PUT' && /\/merge$/.test(c.path));
const notePosts = (f) => f.calls.filter((c) => c.method === 'POST');

// ── jobToCheckRun: plan §3.4 table, row by row, then through the real checksVerdict ──────────────────────────────
const TABLE = [
  ['success', false, 'completed', 'success', 'pass'],
  ['success', true, 'completed', 'success', 'pass'],
  ['failed', false, 'completed', 'failure', 'fail'],
  ['failed', undefined, 'completed', 'failure', 'fail'],
  ['failed', true, 'completed', 'neutral', 'pass'],
  ['canceled', false, 'completed', 'cancelled', 'fail'],
  ['canceled', true, 'completed', 'cancelled', 'fail'],
  ['skipped', false, 'completed', 'skipped', 'pass'],
  ['skipped', true, 'completed', 'skipped', 'pass'],
  ['manual', true, 'completed', 'neutral', 'pass'],
  ['manual', false, 'queued', null, 'pending'],
  ['manual', undefined, 'queued', null, 'pending'],
  ...['created', 'pending', 'scheduled', 'preparing', 'waiting_for_resource', 'waiting_for_callback'].flatMap((st) => [[st, false, 'queued', null, 'pending'], [st, true, 'queued', null, 'pending']]),
  ['running', false, 'in_progress', null, 'pending'],
  ['running', true, 'in_progress', null, 'pending'],
  ['canceling', false, 'in_progress', null, 'pending'],
];
test('jobToCheckRun follows the plan §3.4 table for every documented status, and checksVerdict reads the result', () => {
  const unknown = [];
  for (const [status, allowFailure, wantStatus, wantConclusion, wantVerdict] of TABLE) {
    const run1 = land.jobToCheckRun({ id: 5, name: 'unit', status, allow_failure: allowFailure, started_at: status === 'created' ? null : '2026-11-05T10:00:00Z' }, { onUnknown: (j) => unknown.push(j.status) });
    assert.equal(run1.status, wantStatus, `${status}/${allowFailure}: status`);
    assert.equal(run1.conclusion, wantConclusion, `${status}/${allowFailure}: conclusion`);
    assert.equal(checksVerdict([run1]).state, wantVerdict, `${status}/${allowFailure}: verdict`);
  }
  assert.deepEqual(unknown, [], 'a documented status is never reported as unknown');
});

test('jobToCheckRun: an unknown status is pending (fails closed) and is reported once through onUnknown', () => {
  const seen = [];
  const r = land.jobToCheckRun({ id: 1, name: 'x', status: 'frobnicated', allow_failure: false }, { onUnknown: (j) => seen.push(j.status) });
  assert.deepEqual([r.status, r.conclusion], ['queued', null]);
  assert.equal(checksVerdict([r]).state, 'pending');
  assert.deepEqual(seen, ['frobnicated']);
  assert.doesNotThrow(() => land.jobToCheckRun({ id: 1, name: 'x', status: 'frobnicated' }), 'onUnknown is optional');
});

test('jobToCheckRun keeps name, id and started_at, so the latest attempt of a job is the one checksVerdict reads', () => {
  const failedFirst = [
    land.jobToCheckRun({ id: 1, name: 'unit', status: 'failed', allow_failure: false, started_at: '2026-11-05T10:00:00Z' }),
    land.jobToCheckRun({ id: 2, name: 'unit', status: 'success', allow_failure: false, started_at: '2026-11-05T10:05:00Z' }),
  ];
  assert.equal(checksVerdict(failedFirst).state, 'pass');
  assert.equal(checksVerdict([...failedFirst].reverse()).state, 'pass');
  const successFirst = [
    land.jobToCheckRun({ id: 1, name: 'unit', status: 'success', allow_failure: false, started_at: '2026-11-05T10:00:00Z' }),
    land.jobToCheckRun({ id: 2, name: 'unit', status: 'failed', allow_failure: false, started_at: '2026-11-05T10:05:00Z' }),
  ];
  assert.equal(checksVerdict(successFirst).state, 'fail');
  assert.deepEqual(Object.keys(land.jobToCheckRun({ id: 3, name: 'n', status: 'created' })).sort(), ['conclusion', 'id', 'name', 'started_at', 'status']);
  assert.deepEqual(land.jobToCheckRun({ id: 3, name: 'n', status: 'success', started_at: '2026-11-05T10:00:00Z' }), { name: 'n', id: 3, started_at: '2026-11-05T10:00:00Z', status: 'completed', conclusion: 'success' });
  assert.equal(land.jobToCheckRun({ id: 3, name: 'n', status: 'created' }).started_at, null, 'a job that has not started has no start time');
});

// ── required jobs ────────────────────────────────────────────────────────────
const jr = (name, status, allow_failure = false) => land.jobToCheckRun({ id: Math.floor(Math.random() * 1e6), name, status, allow_failure, started_at: '2026-11-05T10:00:00Z' });
test('requiredJobsVerdict: every required name must be present and success; skipped, neutral or absent does not pass', () => {
  const req = ['unit', 'build'];
  assert.equal(land.requiredJobsVerdict([jr('unit', 'success'), jr('build', 'success')], req).state, 'pass');
  assert.equal(land.requiredJobsVerdict([jr('unit', 'success'), jr('build', 'skipped')], req).state, 'fail', 'skipped');
  assert.equal(land.requiredJobsVerdict([jr('unit', 'success'), jr('build', 'failed', true)], req).state, 'fail', 'neutral (an optional job that failed)');
  assert.equal(land.requiredJobsVerdict([jr('unit', 'success'), jr('build', 'failed')], req).state, 'fail', 'failed');
  assert.equal(land.requiredJobsVerdict([jr('unit', 'success'), jr('build', 'canceled')], req).state, 'fail', 'canceled');
  assert.equal(land.requiredJobsVerdict([jr('unit', 'success'), jr('build', 'running')], req).state, 'pending', 'running');
  assert.equal(land.requiredJobsVerdict([jr('unit', 'success')], req, { pipelineFinal: false }).state, 'pending', 'absent while the pipeline still runs');
  assert.equal(land.requiredJobsVerdict([jr('unit', 'success')], req, { pipelineFinal: true }).state, 'fail', 'absent once the pipeline finished');
  assert.equal(land.requiredJobsVerdict([], req, { pipelineFinal: true }).state, 'fail');
  assert.equal(land.requiredJobsVerdict([jr('unit', 'failed')], [], {}).state, 'pass', 'no required jobs configured');
  assert.match(land.requiredJobsVerdict([jr('unit', 'success'), jr('build', 'skipped')], req).detail, /build=skipped/);
  const attempt = (id, status, startedAt) => land.jobToCheckRun({ id, name: 'unit', status, allow_failure: false, started_at: startedAt });
  const retried = [attempt(1, 'failed', '2026-11-05T10:00:00Z'), attempt(2, 'success', '2026-11-05T10:05:00Z'), jr('build', 'success')];
  assert.equal(land.requiredJobsVerdict(retried, req).state, 'pass', 'a retried job counts by its latest attempt');
  assert.equal(land.requiredJobsVerdict([...retried].reverse(), req).state, 'pass');
  const regressed = [attempt(1, 'success', '2026-11-05T10:00:00Z'), attempt(2, 'failed', '2026-11-05T10:05:00Z'), jr('build', 'success')];
  assert.equal(land.requiredJobsVerdict(regressed, req).state, 'fail');
});

test('checksFor: no pipeline is pending, a finished pipeline with no jobs fails, optional failures do not block, fail beats pending', () => {
  const req = ['unit', 'build'];
  assert.equal(land.checksFor(null, [], req).state, 'pending');
  assert.equal(land.checksFor({ id: 1, status: 'failed' }, [], req).state, 'fail');
  assert.equal(land.checksFor({ id: 1, status: 'running' }, [], req).state, 'pending');
  const ok = [{ id: 1, name: 'unit', status: 'success', allow_failure: false }, { id: 2, name: 'build', status: 'success', allow_failure: false }, { id: 3, name: 'lint', status: 'failed', allow_failure: true }];
  assert.equal(land.checksFor({ id: 1, status: 'success' }, ok, req).state, 'pass');
  const redAndRunning = [{ id: 1, name: 'unit', status: 'failed', allow_failure: false }, { id: 2, name: 'build', status: 'running', allow_failure: false }];
  assert.equal(land.checksFor({ id: 1, status: 'running' }, redAndRunning, req).state, 'fail');
  const seen = [];
  land.checksFor({ id: 1, status: 'running' }, [{ id: 1, name: 'unit', status: 'frob' }], req, { onUnknown: (j) => seen.push(j.name) });
  assert.deepEqual(seen, ['unit']);
});

// ── decide: the same verdicts as mergeDecision ───────────────────────────────
test('decide gives the verdicts of mergeDecision itself for every combination of review, checks, behind and protected files', () => {
  const reviews = [{ ok: true, reason: 'current' }, { ok: false, reason: 'no accept', code: 'no_review' }];
  const checkSets = [{ state: 'pass', detail: 'green' }, { state: 'fail', detail: 'unit=failure' }, { state: 'pending', detail: 'unit=queued' }];
  let combos = 0;
  for (const review of reviews) {
    for (const checks of checkSets) {
      for (const behindBy of [0, 3]) {
        for (const protectedFiles of [[], ['CLAUDE.md']]) {
          const input = { review, checks, behindBy, protectedFiles };
          const m = mergeDecision(input);
          const d = land.decide(input);
          combos += 1;
          const label = JSON.stringify(input);
          assert.equal(d.action === 'land', m.ok, `land only when mergeDecision is ok: ${label}`);
          assert.equal(d.reason, m.reason, `the reason is mergeDecision's: ${label}`);
          if (m.code === 2) assert.equal(d.action, 'wait', label);
          if (m.ok) assert.equal(d.code, 0, label);
          if (m.code === 1) {
            const ignoringBehind = mergeDecision({ ...input, behindBy: 0 });
            assert.equal(d.action, ignoringBehind.ok ? 'update' : 'skip', `update exactly when being behind is the only thing missing: ${label}`);
          }
        }
      }
    }
  }
  assert.equal(combos, 24);
  assert.deepEqual(land.decide({ review: reviews[0], checks: checkSets[0], behindBy: 0, protectedFiles: [] }).action, 'land');
  assert.equal(land.decide({ review: reviews[0], checks: checkSets[0], behindBy: 2 }).action, 'update');
  assert.equal(land.decide({ review: reviews[0], checks: checkSets[2], behindBy: 2 }).action, 'wait', 'a behind branch with a pending pipeline waits, as mergeDecision orders it');
  assert.equal(land.decide({ review: reviews[0], checks: checkSets[0], behindBy: 0, protectedFiles: ['CLAUDE.md'] }).reasonCode, 'protected_gate_file');
  assert.equal(land.decide({ review: reviews[1], checks: checkSets[0] }).reasonCode, 'no_review');
  assert.equal(land.decide({ review: reviews[0], checks: { state: 'fail', kind: 'required', detail: 'required job(s) not green: build=skipped' } }).reasonCode, 'required_job_missing');
  assert.equal(land.decide({ review: reviews[0], checks: { state: 'fail', kind: 'checks', detail: 'unit=failure; required job(s) not green: unit=failure' } }).reasonCode, 'checks_failed', 'a red job is a failed check even when it is also a required one');
  assert.equal(land.decide({ review: reviews[0], checks: checkSets[1] }).reasonCode, 'checks_failed');
});

// ── the review commit ────────────────────────────────────────────────────────
const rc = (o) => ({ sha: 'a'.repeat(40), review: 'demo/lane-a', verdict: 'accept', reviewer: REVIEWER, reviewedHead: 'b'.repeat(40), files: [], ...o });
test('judgeReviewCommit: the newest review of the lane decides; it must be an accept by the reviewer agent, pushed by the reviewer account', () => {
  const key = 'demo/lane-a';
  assert.equal(land.judgeReviewCommit([], key, { pushed: true }).code, 'no_review');
  assert.equal(land.judgeReviewCommit([rc({ review: 'demo/lane-b' })], key, { pushed: true }).code, 'no_review', 'another lane\'s accept does not count');
  assert.equal(land.judgeReviewCommit([rc({ verdict: 'changes' }), rc({})], key, { pushed: true }).code, 'review_changes', 'a newer changes beats an older accept');
  assert.equal(land.judgeReviewCommit([rc({}), rc({ verdict: 'changes' })], key, { pushed: true }).ok, true, 'an accept after a changes round counts');
  assert.equal(land.judgeReviewCommit([rc({ reviewer: 'me' })], key, { pushed: true }).code, 'review_forged');
  assert.equal(land.judgeReviewCommit([rc({ reviewedHead: 'xyz' })], key, { pushed: true }).code, 'review_forged');
  assert.equal(land.judgeReviewCommit([rc({})], key, { pushed: false }).code, 'review_forged');
  assert.equal(land.judgeReviewCommit([rc({})], key, {}).code, 'review_forged', 'not proven to be pushed by the reviewer account is not an accept');
  const ok = land.judgeReviewCommit([rc({})], key, { pushed: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.commit.reviewedHead, 'b'.repeat(40));
});

test('squashMessage is the title with the VTID first and the description', () => {
  assert.equal(land.squashMessage({ title: 'VTID-05999 (demo/lane-a): add', description: 'Body.' }), 'VTID-05999 (demo/lane-a): add\n\nBody.');
  assert.equal(land.squashMessage({ title: '  VTID-05999 (demo/lane-a):   add  ', description: '' }), 'VTID-05999 (demo/lane-a): add');
  assert.equal(land.squashMessage({ title: 'VTID-05999 (a/b): t', description: 'x\r\ny\r\n' }), 'VTID-05999 (a/b): t\n\nx\ny');
});

// ── landing, with real git and the fake GitLab ───────────────────────────────
test('lands a reviewed, green, up-to-date merge request: one merge call pinned to the head, squash, title and description, source branch removed', async () => {
  const sc = scenario();
  const r = await run(sc);
  assert.equal(r.failed, false);
  const calls = merges(r.f);
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/merge_requests\/7\/merge$/);
  assert.deepEqual(calls[0].body, {
    sha: sc.R, squash: true, squash_commit_message: 'VTID-05999 (demo/lane-a): add the feature\n\nBody text of the merge request.', should_remove_source_branch: true,
  });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].action, 'land');
  assert.equal(r.rows[0].landed, true);
  assert.equal(notePosts(r.f).length, 0, 'nothing to explain');
  assert.ok(r.events().some((e) => e.event === 'landed' && e.mr === 7));
});

test('a lane-file entry after the accept still counts; the review is read against the head, not the accepted sha', async () => {
  const sc = scenario();
  const head = addCommit(sc.w, { branch: sc.branch, file: `.kiro/specs/demo/lanes/${sc.lane}.md`, text: `${laneFile(sc.lane)}\n### 2026-11-05T10:09Z · kiro · note\nA note.\n`, message: 'lane note' });
  publish(sc.w, { branch: sc.branch, iid: sc.iid });
  sc.s.mrs[0].sha = head;
  addPipeline(sc.s, head);
  const r = await run(sc);
  assert.equal(r.rows[0].action, 'land');
  assert.equal(merges(r.f)[0].body.sha, head);
});

test('a merge call that fails is not repeated by the client; the merge request is read again and the bot says it will try next tick', async () => {
  const sc = scenario();
  sc.s.mergeResponse = () => ({ status: 500, json: { message: 'boom' } });
  const r = await run(sc);
  assert.equal(merges(r.f).length, 1, 'retries: 0 for an action');
  assert.equal(r.rows[0].landed, false);
  assert.equal(r.failed, false, 'a refused merge is retried next tick, it is not a failed tick');
  assert.ok(r.f.calls.some((c) => c.method === 'GET' && /\/merge_requests\/7$/.test(c.path)), 'the merge request was read again');
  assert.ok(r.events().some((e) => e.event === 'not_landed'));
  const again = await run(sc, {});
  assert.equal(merges(again.f).length, 1, 'the next tick tries again');
});

test('a merge call that reports an error but was processed is recognised by the re-read', async () => {
  const sc = scenario();
  sc.s.mergeResponse = (call, s) => { s.merged.add(7); return { status: 500, json: { message: 'gateway timeout after processing' } }; };
  const r = await run(sc);
  assert.equal(merges(r.f).length, 1);
  assert.equal(r.rows[0].landed, true);
  assert.ok(r.events().some((e) => e.event === 'landed' && e.confirmedBy === 'reread'));
});

test('a 200 answer whose merge request is not merged is not a landing unless the re-read says so', async () => {
  const sc = scenario();
  sc.s.mergeResponse = () => ({ json: { iid: 7, state: 'opened' } });
  const r = await run(sc);
  assert.equal(merges(r.f).length, 1);
  assert.equal(r.rows[0].landed, false);
  assert.ok(r.f.calls.some((c) => c.method === 'GET' && /\/merge_requests\/7$/.test(c.path)), 'read again');
});

test('the merge is refused when GitLab says the head changed (409): nothing else is done', async () => {
  const sc = scenario();
  sc.s.mergeResponse = () => ({ status: 409, json: { message: 'SHA does not match HEAD of source branch' } });
  const r = await run(sc);
  assert.equal(r.rows[0].landed, false);
  assert.equal(merges(r.f).length, 1);
  assert.equal(notePosts(r.f).length, 0);
});

test('no reviewer accept: nothing lands and the reason is written once per head', async () => {
  const sc = scenario();
  // a head without any review commit: the feature commit alone
  sc.s.mrs[0].sha = sc.F;
  g(sc.w.remote, 'update-ref', `refs/merge-requests/${sc.iid}/head`, sc.F);
  addPipeline(sc.s, sc.F);
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].reasonCode, 'no_review');
  assert.equal(notePosts(r.f).length, 1);
  assert.match(sc.s.notes[7][0].body, /no reviewer accept/);
  assert.match(sc.s.notes[7][0].body, new RegExp(`<!-- vitana-land:no_review:${sc.F} -->`));
  const second = await run(sc);
  assert.equal(notePosts(second.f).length, 0, 'a comment already written is not repeated');
});

test('a note by someone else that contains the marker does not stand in for the bot\'s comment', async () => {
  const sc = scenario();
  sc.s.events = [];
  sc.s.notes[7].push({ body: `pasted <!-- vitana-land:review_forged:${sc.R} -->`, author: { username: 'agent-kiro-exafy' } });
  const r = await run(sc);
  assert.equal(notePosts(r.f).length, 1);
});

test('an accept pushed by a builder is forged: it does not land and says why', async () => {
  const sc = scenario();
  sc.s.events = [];
  reviewerPush(sc.s, sc.F, sc.R, 1, 'agent-kiro-exafy');
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].reasonCode, 'review_forged');
  assert.equal(notePosts(r.f).length, 1);
  assert.match(sc.s.notes[7][0].body, /not pushed by the reviewer account/);
});

test('an accept whose commit is in no push of the reviewer (a builder committed the trailers) is forged', async () => {
  const sc = scenario();
  sc.s.events = [];
  const mainTip = g(sc.w.remote, 'rev-parse', 'refs/heads/main');
  reviewerPush(sc.s, mainTip, sc.F, 1); // the reviewer did push, but only the builder's feature commit, not the accept
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].reasonCode, 'review_forged');
});

test('a reviewer push without commit_from proves only its tip: an accept below the tip is not counted, an accept that is the tip is', async () => {
  // the reviewer account created a branch (no commit_from); GitLab's commit_count then also covers commits the builder made
  const below = scenario();
  const tip = addCommit(below.w, { branch: below.branch, file: `.kiro/specs/demo/lanes/${below.lane}.md`, text: `${laneFile(below.lane)}\n### 2026-11-05T10:09Z · kiro · note\nA note.\n`, message: 'lane note' });
  publish(below.w, { branch: below.branch, iid: below.iid });
  below.s.mrs[0].sha = tip;
  addPipeline(below.s, tip);
  below.s.events = [{ author_username: 'agent-reviewer', push_data: { commit_from: null, commit_to: tip, commit_count: 3, action: 'created', ref_type: 'branch' } }];
  const r1 = await run(below);
  assert.equal(merges(r1.f).length, 0, 'the accept is two commits below the pushed tip: the push does not prove it');
  assert.equal(r1.rows[0].reasonCode, 'review_forged');
  assert.equal(notePosts(r1.f).length, 1);

  const tipIsAccept = scenario();
  tipIsAccept.s.events = [{ author_username: 'agent-reviewer', push_data: { commit_from: null, commit_to: tipIsAccept.R, commit_count: 2, action: 'created', ref_type: 'branch' } }];
  const r2 = await run(tipIsAccept);
  assert.equal(r2.rows[0].action, 'land', 'when the accept is the tip of the branch the reviewer created, it was pushed by the reviewer');
  assert.equal(merges(r2.f).length, 1);

  const withFrom = scenario(); // the planned flow: the reviewer pushes onto the builder's branch, commit_from set: the range counts
  assert.equal((await run(withFrom)).rows[0].action, 'land');
});

test('an accept that does not name the reviewer agent is forged', async () => {
  const w = newWorld(); const s = newState();
  addLane(w, 'lane-a');
  const F = addFeature(w, { lane: 'lane-a', branch: 'kiro/demo/lane-a' });
  const R = addReview(w, { lane: 'lane-a', branch: 'kiro/demo/lane-a', reviewed: F, reviewer: 'a builder' });
  publish(w, { branch: 'kiro/demo/lane-a', iid: 7 });
  addMr(s, { iid: 7, lane: 'lane-a', sha: R, branch: 'kiro/demo/lane-a' }); reviewerPush(s, F, R); addPipeline(s, R);
  const r = await run({ w, s });
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].reasonCode, 'review_forged');
});

test('code changed after the accept: the review no longer counts for the head', async () => {
  const sc = scenario();
  const head = addCommit(sc.w, { branch: sc.branch, file: 'scripts/sneaky.mjs', text: 'export const y = 2;\n', message: 'sneak in more code' });
  publish(sc.w, { branch: sc.branch, iid: sc.iid });
  sc.s.mrs[0].sha = head;
  addPipeline(sc.s, head);
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].reasonCode, 'review_stale');
  assert.equal(notePosts(r.f).length, 1);
});

test('a force-push after the review removes the accept with it: nothing lands', async () => {
  const sc = scenario();
  g(sc.w.work, 'checkout', '-q', '-B', sc.branch, 'origin/main');
  write(sc.w.work, 'scripts/rewritten.mjs', 'export const z = 3;\n');
  g(sc.w.work, 'add', '-A'); g(sc.w.work, 'commit', '-q', '-m', `VTID-05999 (demo/lane-a): rewritten\n\nCollab-Session: kiro-exafy-202611050900-aaaa`);
  publish(sc.w, { branch: sc.branch, iid: sc.iid, force: true });
  const head = g(sc.w.work, 'rev-parse', 'HEAD');
  sc.s.mrs[0].sha = head;
  addPipeline(sc.s, head);
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].reasonCode, 'no_review');
});

test('a changes verdict after an accept: the lane is back with its builder', async () => {
  const sc = scenario();
  const second = addReview(sc.w, { lane: sc.lane, branch: sc.branch, reviewed: sc.R, verdict: 'changes' });
  publish(sc.w, { branch: sc.branch, iid: sc.iid });
  sc.s.mrs[0].sha = second;
  reviewerPush(sc.s, sc.R, second);
  addPipeline(sc.s, second);
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].reasonCode, 'review_changes');
});

test('a red required job does not land and names the job; a required job that is absent in a finished pipeline does not land either', async () => {
  const red = scenario();
  red.s.jobs[900] = [{ id: 1, name: 'unit', status: 'failed', allow_failure: false, started_at: '2026-11-05T10:21:00Z' }, { id: 2, name: 'build', status: 'success', allow_failure: false, started_at: '2026-11-05T10:21:00Z' }];
  const r1 = await run(red);
  assert.equal(merges(r1.f).length, 0);
  assert.equal(r1.rows[0].reasonCode, 'checks_failed');
  assert.equal(notePosts(r1.f).length, 1);

  const missing = scenario();
  missing.s.jobs[900] = [{ id: 1, name: 'unit', status: 'success', allow_failure: false, started_at: '2026-11-05T10:21:00Z' }];
  const r2 = await run(missing);
  assert.equal(merges(r2.f).length, 0);
  assert.equal(r2.rows[0].reasonCode, 'required_job_missing');

  const skipped = scenario();
  skipped.s.jobs[900] = [{ id: 1, name: 'unit', status: 'success', allow_failure: false, started_at: '2026-11-05T10:21:00Z' }, { id: 2, name: 'build', status: 'skipped', allow_failure: false, started_at: '2026-11-05T10:21:00Z' }];
  const r3 = await run(skipped);
  assert.equal(merges(r3.f).length, 0);
  assert.equal(r3.rows[0].reasonCode, 'required_job_missing');
});

test('the pipeline is read for exactly the head: a green pipeline of another sha does not count', async () => {
  const sc = scenario();
  sc.s.pipelines = [{ id: 901, sha: sc.F, status: 'success', created_at: '2026-11-05T10:20:00Z' }];
  sc.s.jobs[901] = greenJobs();
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].action, 'wait');
  assert.deepEqual(r.f.calls.find((c) => /\/pipelines$/.test(c.path)).query.sha, [sc.R]);
});

test('a pipeline of another sha is never used, even when the server returns it for the query', async () => {
  const sc = scenario();
  sc.s.pipelines = [{ id: 905, sha: sc.F, status: 'success', created_at: '2026-11-05T10:20:00Z' }];
  sc.s.jobs[905] = greenJobs();
  const f = gitlab(sc.s);
  f.route('GET', `${P}/pipelines`, () => ({ json: sc.s.pipelines })); // ignores ?sha=
  const c = context(sc.w, f);
  const out = await land.tick(c.ctx);
  assert.equal(merges(f).length, 0);
  assert.equal(out.rows[0].action, 'wait', 'no pipeline for this head yet');
});

test('a merge request with an unexpected iid, head or source branch name is not touched', async () => {
  for (const bad of [{ source_branch: '--upload-pack=evil' }, { source_branch: 'has space' }, { source_branch: 'x'.repeat(201) }, { sha: 'abc' }, { iid: '7' }]) {
    const sc = scenario();
    Object.assign(sc.s.mrs[0], bad);
    const r = await run(sc);
    assert.equal(r.rows[0].reasonCode, 'bad_merge_request', JSON.stringify(bad));
    assert.equal(merges(r.f).length, 0);
    r.f.assertNoWrites();
  }
});

test('a pending pipeline waits: no write at all, and the next merge request of the project is not even read', async () => {
  const sc = scenario({ lanes: 2 });
  sc.s.pipelines.find((p) => p.sha === sc.R).status = 'running';
  sc.s.jobs[sc.s.pipelines.find((p) => p.sha === sc.R).id] = [{ id: 1, name: 'unit', status: 'running', allow_failure: false, started_at: '2026-11-05T10:21:00Z' }];
  advanceMain(sc.w, 'docs/other.md', 'main moved\n'); // lane-b is behind: it would be updated if it were touched
  const before = refs(sc.w.remote);
  const r = await run(sc);
  assert.equal(r.rows.length, 1, 'only the oldest merge request was looked at');
  assert.equal(r.rows[0].action, 'wait');
  r.f.assertNoWrites();
  assert.equal(merges(r.f).length, 0);
  assert.ok(!r.f.calls.some((c) => /\/pipelines$/.test(c.path) && c.query.sha?.[0] === sc.mrs['lane-b'].R), 'lane-b\'s pipeline was not read');
  assert.equal(refs(sc.w.remote).replace(/refs\/heads\/main .*\n?/, ''), before.replace(/refs\/heads\/main .*\n?/, ''), 'no branch was updated');
});

test('a merge request that waited more than 60 minutes for its pipeline loses its turn to the next one', async () => {
  const sc = scenario({ lanes: 2 });
  const stuck = sc.s.pipelines.find((p) => p.sha === sc.R);
  stuck.status = 'running'; stuck.created_at = '2026-11-05T09:20:00Z'; // 70 minutes before NOW
  sc.s.jobs[stuck.id] = [{ id: 1, name: 'unit', status: 'running', allow_failure: false, started_at: '2026-11-05T09:21:00Z' }];
  const r = await run(sc);
  assert.equal(merges(r.f).length, 1);
  assert.match(merges(r.f)[0].path, /\/merge_requests\/8\/merge$/);
  assert.ok(r.events().some((e) => e.event === 'lost_its_turn' && e.mr === 7 && e.reason === 'pipeline_pending'));
  assert.equal(r.rows[0].reasonCode, 'waited_too_long');
});

test('a merge that GitLab keeps refusing keeps the turn for 60 minutes (counted from its pipeline), then loses it to the next merge request', async () => {
  // GitLab refuses the merge of !7 (an unresolved thread, a merge setting the bot does not read); !8 is ready and younger
  const refuse7 = (call, s) => {
    if (/merge_requests\/7\/merge$/.test(call.path)) return { status: 406, json: { message: 'Branch cannot be merged' } };
    s.merged.add(8);
    return { json: { iid: 8, state: 'merged', merge_commit_sha: null } };
  };
  const young = scenario({ lanes: 2 }); // the pipeline of !7 is 10 minutes old
  young.s.mergeResponse = refuse7;
  const r1 = await run(young);
  assert.deepEqual(merges(r1.f).map((c) => /merge_requests\/(\d+)\/merge$/.exec(c.path)[1]), ['7'], 'it keeps the turn: !8 is not even read');
  assert.equal(r1.rows.length, 1);
  assert.equal(r1.rows[0].landed, false);
  assert.equal(r1.events().filter((e) => e.event === 'lost_its_turn').length, 0);

  const old = scenario({ lanes: 2 });
  old.s.pipelines.find((p) => p.sha === old.R).created_at = '2026-11-05T09:20:00Z'; // 70 minutes before NOW
  old.s.mergeResponse = refuse7;
  const r2 = await run(old);
  assert.deepEqual(merges(r2.f).map((c) => /merge_requests\/(\d+)\/merge$/.exec(c.path)[1]), ['7', '8'], 'the refused one was tried, then the next one landed in the same tick');
  assert.equal(r2.rows[0].action, 'skip');
  assert.equal(r2.rows[0].reasonCode, 'merge_refused_too_long');
  assert.equal(r2.rows[0].landed, false);
  assert.equal(r2.rows[1].landed, true);
  assert.ok(r2.events().some((e) => e.event === 'lost_its_turn' && e.mr === 7 && e.reason === 'merge_refused'));

  const dry = scenario({ lanes: 2 }); // a dry run makes no merge call, so nothing was refused and the turn stays where it is
  dry.s.pipelines.find((p) => p.sha === dry.R).created_at = '2026-11-05T09:20:00Z';
  const r3 = await run(dry, { dryRun: true });
  assert.equal(r3.rows.length, 1);
  assert.equal(r3.rows[0].action, 'land');
  r3.f.assertNoWrites();
});

test('two ready merge requests: the oldest lands, the other is not touched in the same tick', async () => {
  const sc = scenario({ lanes: 2 });
  sc.s.mrs.reverse(); // the API lists the newest first; the bot still takes the oldest
  const r = await run(sc);
  assert.equal(merges(r.f).length, 1);
  assert.match(merges(r.f)[0].path, /\/merge_requests\/7\/merge$/);
  assert.equal(r.rows.length, 1);
  assert.ok(!r.f.calls.some((c) => c.query?.sha?.[0] === sc.mrs['lane-b'].R), 'the second merge request was not evaluated');
});

test('a merge request that needs a human is skipped, not waited for: the next one lands', async () => {
  const sc = scenario({ lanes: 2 });
  sc.s.events = sc.s.events.filter((e) => e.push_data.commit_to !== sc.R); // lane-a's accept was not pushed by the reviewer
  const r = await run(sc);
  assert.equal(merges(r.f).length, 1);
  assert.match(merges(r.f)[0].path, /\/merge_requests\/8\/merge$/);
  assert.equal(r.rows.find((x) => x.iid === 7).reasonCode, 'review_forged');
});

test('behind main: main is merged INTO the source branch by bot-land, pushed, and the merge request is not landed in the same tick; the next tick lands it', async () => {
  const sc = scenario();
  const mainTip = advanceMain(sc.w, 'docs/other.md', 'main moved\n');
  const before = g(sc.w.remote, 'rev-parse', `refs/heads/${sc.branch}`);
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0, 'not landed in the same tick');
  assert.equal(r.rows[0].action, 'update');
  assert.equal(r.rows[0].updated, true);
  const after = g(sc.w.remote, 'rev-parse', `refs/heads/${sc.branch}`);
  assert.notEqual(after, before);
  assert.deepEqual(g(sc.w.remote, 'rev-list', '--parents', '-n', '1', after).split(' ').slice(1), [before, mainTip], 'a merge commit: the reviewed head first, main second (not a rebase)');
  assert.equal(g(sc.w.remote, 'log', '-1', '--format=%an|%cn', after), 'bot-land|bot-land');
  assert.match(g(sc.w.remote, 'log', '-1', '--format=%B', after), /Collab-Session: bot-land/);
  assert.equal(g(sc.w.remote, 'merge-base', '--is-ancestor', sc.R, after) === '', true, 'the reviewed head stays an ancestor');
  assert.equal(notePosts(r.f).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(sc.w.root, 'land')).filter((n) => n.includes('-update-')), [], 'the scratch worktree is gone');
  assert.equal(g(path.join(sc.w.root, 'land', 'rehearsal.git'), 'worktree', 'list').split('\n').length, 1, 'git forgot it too');

  // GitLab moves the merge request head to the new commit and starts a pipeline for it
  g(sc.w.remote, 'update-ref', `refs/merge-requests/${sc.iid}/head`, after);
  sc.s.mrs[0].sha = after;
  addPipeline(sc.s, after);
  const next = await run(sc);
  assert.equal(next.rows[0].action, 'land', `the accept still counts after a clean merge of main: ${next.rows[0].reason}`);
  assert.equal(merges(next.f)[0].body.sha, after);
});

test('main\'s own change decides, not the branch\'s: a branch that itself changes a governance file is still updated when main brought in something unrelated', async () => {
  const w = newWorld(); const s = newState();
  addLane(w, 'lane-a');
  const F = addFeature(w, { lane: 'lane-a', branch: 'kiro/demo/lane-a', files: { '.github/workflows/DEMO.yml': 'name: demo\n' } });
  const R = addReview(w, { lane: 'lane-a', branch: 'kiro/demo/lane-a', reviewed: F });
  publish(w, { branch: 'kiro/demo/lane-a', iid: 7 });
  addMr(s, { iid: 7, lane: 'lane-a', sha: R, branch: 'kiro/demo/lane-a' }); reviewerPush(s, F, R); addPipeline(s, R);
  advanceMain(w, 'docs/other.md', 'main moved\n');
  const r = await run({ w, s });
  assert.equal(r.rows[0].action, 'update');
  assert.equal(r.rows[0].updated, true, r.rows[0].reason);
});

test('behind a main that changed a governance or protected gate file: the branch is left alone, because the merge would end the review; one comment says so', async () => {
  for (const file of ['CLAUDE.md', '.github/workflows/PR-GATE.yml', 'scripts/collab/queue.mjs']) {
    const sc = scenario();
    advanceMain(sc.w, file, 'main changed a gate file; the merge request did not\n');
    const before = refs(sc.w.remote);
    const r = await run(sc);
    assert.equal(r.rows[0].action, 'skip', file);
    assert.equal(r.rows[0].reasonCode, 'review_would_lapse', file);
    assert.equal(merges(r.f).length, 0);
    assert.equal(notePosts(r.f).length, 1, file);
    assert.match(sc.s.notes[7][0].body, /end the validity of the review/);
    assert.equal(refs(sc.w.remote), before, `${file}: no branch was pushed`);
    const again = await run(sc);
    assert.equal(notePosts(again.f).length, 0, 'once per head');
  }
  // a dry run says it would comment and writes nothing
  const dry = scenario();
  advanceMain(dry.w, 'CLAUDE.md', 'x\n');
  const r = await run(dry, { dryRun: true });
  r.f.assertNoWrites();
  assert.ok(r.events().some((e) => e.event === 'would_comment' && e.reason === 'review_would_lapse'));
});

test('the update is never a force push: a branch that moved meanwhile keeps the builder\'s commit and the tick fails', async () => {
  const sc = scenario();
  advanceMain(sc.w, 'docs/other.md', 'main moved\n');
  const builderCommit = addCommit(sc.w, { branch: sc.branch, file: 'scripts/late.mjs', text: 'export const late = 1;\n', message: 'pushed while the bot was working' });
  g(sc.w.work, 'push', '-q', 'origin', `${builderCommit}:refs/heads/${sc.branch}`); // the MR head ref still says R: the API is a moment behind
  const r = await run(sc);
  assert.equal(r.failed, true);
  assert.equal(g(sc.w.remote, 'rev-parse', `refs/heads/${sc.branch}`), builderCommit, 'the builder\'s commit is still the branch tip');
  assert.equal(merges(r.f).length, 0);
});

test('behind main with a conflict: nothing is pushed, the branch is left alone, one comment says so', async () => {
  const sc = scenario();
  advanceMain(sc.w, `scripts/${sc.lane}.mjs`, 'export const x = 99; // main got there first\n');
  const before = refs(sc.w.remote);
  const r = await run(sc);
  assert.equal(r.rows[0].action, 'skip', 'a conflict needs a human: it is a skip, not an update');
  assert.equal(r.rows[0].reasonCode, 'conflict');
  assert.notEqual(r.rows[0].updated, true);
  assert.equal(merges(r.f).length, 0);
  assert.equal(notePosts(r.f).length, 1);
  assert.match(sc.s.notes[7][0].body, /conflicts/);
  assert.equal(refs(sc.w.remote).split('\n').filter((l) => l.includes(`refs/heads/${sc.branch} `)).join(), before.split('\n').filter((l) => l.includes(`refs/heads/${sc.branch} `)).join());
  const again = await run(sc);
  assert.equal(notePosts(again.f).length, 0, 'the conflict comment is written once per head');
  assert.deepEqual(fs.readdirSync(path.join(sc.w.root, 'land')).filter((n) => n.includes('-update-')), [], 'the scratch worktree is gone');
});

test('a merge request whose merge of main conflicts is skipped, not waited for: the younger one lands in the same tick, and the conflict is commented once per head', async () => {
  const sc = scenario(); // lane-a, iid 7: reviewed and green, but behind main and in conflict with it
  advanceMain(sc.w, `scripts/${sc.lane}.mjs`, 'export const x = 99; // main got there first\n');
  const b = addReadyLane(sc.w, sc.s, { lane: 'lane-b', iid: 8 }); // cut from the new main: up to date, reviewed, green, and younger
  const aTip = g(sc.w.remote, 'rev-parse', `refs/heads/${sc.branch}`);
  const r = await run(sc);
  assert.deepEqual(r.rows.map((x) => x.iid), [7, 8], 'the older one was looked at first, then the younger one');
  const a = r.rows.find((x) => x.iid === 7);
  assert.equal(a.action, 'skip');
  assert.equal(a.reasonCode, 'conflict');
  assert.notEqual(a.updated, true);
  assert.equal(merges(r.f).length, 1, 'the younger merge request landed in the same tick');
  assert.match(merges(r.f)[0].path, /\/merge_requests\/8\/merge$/);
  assert.equal(merges(r.f)[0].body.sha, b.R);
  assert.equal(r.rows.find((x) => x.iid === 8).landed, true);
  assert.equal(notePosts(r.f).length, 1, 'one comment, on the conflicting merge request');
  assert.match(sc.s.notes[7][0].body, /conflicts/);
  assert.equal(sc.s.notes[8].length, 0);
  assert.equal(g(sc.w.remote, 'rev-parse', `refs/heads/${sc.branch}`), aTip, 'the conflicting branch was not pushed');
  assert.deepEqual(fs.readdirSync(path.join(sc.w.root, 'land')).filter((n) => n.includes('-update-')), [], 'the scratch worktree is gone');
  const again = await run(sc); // lane-b is merged now; the conflict is still there and is not commented a second time
  assert.equal(again.rows.find((x) => x.iid === 7).reasonCode, 'conflict');
  assert.equal(notePosts(again.f).length, 0, 'once per head and reason');
  assert.equal(merges(again.f).length, 0);
});

test('a protected gate file in the diff is never landed by the bot; one comment per head', async () => {
  const w = newWorld(); const s = newState();
  addLane(w, 'lane-a');
  const F = addFeature(w, { lane: 'lane-a', branch: 'kiro/demo/lane-a', files: { 'CLAUDE.md': 'changed rule\n' } });
  const R = addReview(w, { lane: 'lane-a', branch: 'kiro/demo/lane-a', reviewed: F });
  publish(w, { branch: 'kiro/demo/lane-a', iid: 7 });
  addMr(s, { iid: 7, lane: 'lane-a', sha: R, branch: 'kiro/demo/lane-a' }); reviewerPush(s, F, R); addPipeline(s, R);
  const r = await run({ w, s });
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].reasonCode, 'protected_gate_file');
  assert.equal(notePosts(r.f).length, 1);
  assert.match(s.notes[7][0].body, /protected gate file/);
  const again = await run({ w, s });
  assert.equal(notePosts(again.f).length, 0);
  assert.equal(merges(again.f).length, 0);
});

test('a title that is not "VTID-nnnnn (<slug>/<lane>): …" is not landed and says why once; a draft is skipped silently', async () => {
  const sc = scenario({ lanes: 2 });
  sc.s.mrs[0].title = 'quick fix';
  sc.s.mrs[1].draft = true;
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.deepEqual(r.rows.map((x) => x.reasonCode), ['not_a_lane_mr', 'draft']);
  assert.equal(notePosts(r.f).length, 1);
  assert.equal(sc.s.notes[8].length, 0);
  const noVtid = scenario();
  noVtid.s.mrs[0].title = 'Add the feature (demo/lane-a)';
  assert.equal((await run(noVtid)).rows[0].reasonCode, 'not_a_lane_mr', 'a lane key without a VTID is not enough: main needs the VTID');
});

test('--dry-run writes nothing: no merge call, no comment, no push', async () => {
  const landable = scenario();
  const before = refs(landable.w.remote);
  const r1 = await run(landable, { dryRun: true });
  r1.f.assertNoWrites();
  assert.equal(r1.rows[0].action, 'land');
  assert.notEqual(r1.rows[0].landed, true);
  assert.equal(refs(landable.w.remote), before);
  assert.ok(r1.events().some((e) => e.event === 'would_land'));

  const behind = scenario();
  advanceMain(behind.w, 'docs/other.md', 'x\n');
  const beforeBehind = refs(behind.w.remote);
  const r2 = await run(behind, { dryRun: true });
  r2.f.assertNoWrites();
  assert.equal(refs(behind.w.remote), beforeBehind, 'the source branch was not pushed');
  assert.ok(r2.events().some((e) => e.event === 'would_update'));

  const refused = scenario();
  refused.s.events = [];
  const r3 = await run(refused, { dryRun: true });
  r3.f.assertNoWrites();
  assert.ok(r3.events().some((e) => e.event === 'would_comment'));
  assert.equal(refused.s.notes[7].length, 0);
});

test('an API error half-way lands nothing: the tick fails, the project is reported, no merge call is made', async () => {
  const sc = scenario();
  sc.s.eventsFail = true;
  const r = await run(sc);
  assert.equal(r.failed, true);
  assert.equal(merges(r.f).length, 0);
  assert.ok(r.events().some((e) => e.event === 'project_failed' && e.project === 'rehearsal'));
});

test('a git error lands nothing: a merge request whose head ref is missing on the remote fails the tick', async () => {
  const sc = scenario();
  g(sc.w.remote, 'update-ref', '-d', `refs/merge-requests/${sc.iid}/head`);
  const r = await run(sc);
  assert.equal(r.failed, true);
  assert.equal(merges(r.f).length, 0);
});

test('a head that moved between the list and the fetch is left for the next tick', async () => {
  const sc = scenario();
  sc.s.mrs[0].sha = sc.F; // the API still shows the old head, the remote ref has moved on
  const r = await run(sc);
  assert.equal(r.rows[0].reasonCode, 'head_moved');
  assert.equal(merges(r.f).length, 0);
});

test('only projects with landing: true are looked at, and only the default branch main', async () => {
  const sc = scenario();
  const f = gitlab(sc.s);
  const c = context(sc.w, f, { projectsOverride: [{ name: 'rehearsal', path: 'vitana/rehearsal', landing: false, required_jobs: ['unit'] }] });
  const out = await land.tick(c.ctx);
  assert.deepEqual(out.rows, []);
  assert.equal(f.calls.length, 0, 'a project without landing: true is not even read');

  const other = scenario();
  other.s.defaultBranch = 'trunk';
  const r = await run(other);
  assert.deepEqual(r.rows, []);
  assert.ok(r.events().some((e) => e.event === 'project_skipped'));
  assert.equal(r.f.calls.filter((c) => /merge_requests/.test(c.path)).length, 0);
});

test('an unknown job status is logged once and the merge request waits', async () => {
  const sc = scenario();
  sc.s.jobs[900] = [...greenJobs(), { id: 99, name: 'weird', status: 'frobnicated', allow_failure: false, started_at: null }];
  const r = await run(sc);
  assert.equal(merges(r.f).length, 0);
  assert.equal(r.rows[0].action, 'wait');
  assert.equal(r.events().filter((e) => e.event === 'unknown_job_status').length, 1);
});

test('the requests the bot makes are exactly the ones listed here (a new request is a deliberate change)', async () => {
  const land1 = await run(scenario());
  const norm = (c) => `${c.method} ${c.path.replace(/^\/api\/v4/, '').replace(/vitana%2Frehearsal/, ':project').replace(/\/\d+/g, '/:n')}`;
  assert.deepEqual([...new Set(land1.f.calls.map(norm))].sort(), [
    'GET /projects/:project',
    'GET /projects/:project/events',
    'GET /projects/:project/merge_requests',
    'GET /projects/:project/pipelines',
    'GET /projects/:project/pipelines/:n/jobs',
    'PUT /projects/:project/merge_requests/:n/merge',
  ]);
  const refuse = scenario(); refuse.s.events = [];
  const r2 = await run(refuse);
  assert.deepEqual([...new Set(r2.f.calls.map(norm))].sort(), [
    'GET /projects/:project',
    'GET /projects/:project/events',
    'GET /projects/:project/merge_requests',
    'GET /projects/:project/merge_requests/:n/notes',
    'POST /projects/:project/merge_requests/:n/notes',
  ]);
  const src = fs.readFileSync(path.join(HERE, 'gitlab-land.mjs'), 'utf8');
  const apiPaths = [...src.matchAll(/`(\/projects\/[^`]*)`/g)].map((m) => m[1]);
  assert.ok(apiPaths.length >= 8, `API paths found in the source: ${apiPaths.length}`);
  for (const p of apiPaths) assert.equal(/approval|merge_train|push_rule|code_owner|protected_environment/.test(p), false, `only Free-tier API paths: ${p}`);
});

test('no log line carries the token, also when GitLab echoes it back in an error', async () => {
  const sc = scenario();
  sc.s.mergeResponse = () => ({ status: 500, json: { message: `upstream said ${TOKEN} is wrong` } });
  const r = await run(sc);
  assert.ok(r.lines.length >= 3);
  for (const l of r.lines) { assert.equal(l.includes(TOKEN), false, l); JSON.parse(l); }
  assert.ok(r.lines.some((l) => l.includes('[redacted]')), 'the echoed token was redacted');
  const failing = scenario();
  failing.s.eventsFail = true;
  const r2 = await run(failing);
  for (const l of r2.lines) assert.equal(l.includes(TOKEN), false, l);
});

test('git gets the token through GIT_ASKPASS: the script answers the username and the password, and no git environment value holds the token', () => {
  const sc = scenario();
  const { ctx } = context(sc.w, gitlab(sc.s));
  const script = ctx.gitEnv.GIT_ASKPASS;
  assert.ok(fs.statSync(script).mode & 0o100, 'executable');
  assert.equal(fs.statSync(script).mode & 0o077, 0, 'only the owner may read or run it');
  const answer = (prompt) => execFileSync(script, [prompt], { encoding: 'utf8', env: { LAND_TOKEN_FILE: ctx.gitEnv.LAND_TOKEN_FILE, PATH: process.env.PATH } }).trim();
  assert.equal(answer("Username for 'https://gitlab.test': "), 'oauth2');
  assert.equal(answer("Password for 'https://oauth2@gitlab.test': "), TOKEN);
  assert.equal(ctx.gitEnv.GIT_TERMINAL_PROMPT, '0');
  assert.equal(Object.values(ctx.gitEnv).some((v) => String(v).includes(TOKEN)), false, 'the token is not in any environment value');
  assert.equal(fs.readFileSync(script, 'utf8').includes(TOKEN), false, 'nor in the script');
});

test('every git command the bot runs neutralises a global credential helper, so the token that GIT_ASKPASS supplies can never be stored', async () => {
  const sc = scenario();
  advanceMain(sc.w, 'docs/other.md', 'main moved\n'); // behind main: the tick clones, fetches, reads and pushes an update, the commands that reach the remote
  const bin = path.join(sc.w.root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(sc.w.root, 'git-calls.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // a recording `git` in front of the real one: one record per command, arguments separated by \037, records by \036
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\037' "$@" >> "${log}"\nprintf '\\036' >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const r = await run(sc, { deps: { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } } });
  assert.equal(r.rows[0].updated, true, 'the update went through the recording git');
  const calls = fs.readFileSync(log, 'utf8').split('\u001e').filter(Boolean).map((rec) => rec.split('\u001f').slice(0, -1));
  assert.ok(calls.length >= 12, `commands recorded: ${calls.length}`);
  for (const argv of calls) assert.deepEqual(argv.slice(0, 2), ['-c', 'credential.helper='], `git ${argv.join(' ').slice(0, 80)} starts with the flag`);
  // and the run really exercised the commands that matter (the one that clones, the ones that reach the remote, the update)
  const verbs = new Set(calls.map((argv) => argv.find((a, i) => i >= 2 && !a.startsWith('-') && argv[i - 1] !== '-C')));
  for (const verb of ['init', 'fetch', 'worktree', 'merge', 'push', 'rev-parse', 'diff']) assert.ok(verbs.has(verb), `git ${verb} was run (seen: ${[...verbs].join(' ')})`);
  // the commands the bot imports from land-guard.mjs and queue.mjs (localAfter, commitsInRange) only read the local clone; they never reach a remote

  // and the flag is what stops a global helper: with `helper = store` in the global config, approving a credential writes it, unless the flag is given
  const home = path.join(sc.w.root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[credential]\n\thelper = store\n');
  const credential = 'protocol=https\nhost=gitlab.test\nusername=oauth2\npassword=fixture-secret-value\n\n';
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', [...land.GIT_CONFIG_ARGS, 'credential', 'approve'], { input: credential, env });
  assert.equal(fs.existsSync(path.join(home, '.git-credentials')), false, 'with the flag the global store helper is not called');
  execFileSync('git', ['credential', 'approve'], { input: credential, env });
  assert.equal(fs.existsSync(path.join(home, '.git-credentials')), true, 'control: without the flag the global store helper writes the credential');
});

test('the log redacts the token by itself, whatever is put into an entry', () => {
  const sc = scenario();
  const { ctx, lines } = context(sc.w, gitlab(sc.s));
  ctx.log({ event: 'note', text: `the token is ${TOKEN} here`, nested: { again: TOKEN } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(TOKEN), false);
  assert.match(lines[0], /\[redacted\]/);
  assert.equal(JSON.parse(lines[0]).event, 'note');
});

// ── the command line ─────────────────────────────────────────────────────────
function cli(sc, argv, extraOverrides = {}) {
  const f = gitlab(sc.s);
  const out = [];
  const tokenFile = path.join(sc.w.root, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const args = [...argv, '--url', 'https://gitlab.test', '--token-file', tokenFile, '--workdir', path.join(sc.w.root, 'land')];
  const overrides = { projectsOverride: [{ name: 'rehearsal', path: 'vitana/rehearsal', landing: true, required_jobs: ['unit', 'build'] }], remoteUrl: () => sc.w.remote, ...extraOverrides };
  const promise = land.main(args, { fetch: f, now: () => NOW, stdout: (t) => out.push(t), overrides });
  return promise.then((code) => ({ code, out: out.join(''), f }));
}

test('CLI status prints what the bot would do for every open merge request and writes nothing', async () => {
  const sc = scenario({ lanes: 2 });
  const before = refs(sc.w.remote);
  const r = await cli(sc, ['status']);
  assert.equal(r.code, 0);
  r.f.assertNoWrites();
  const rows = r.out.split('\n').filter((l) => /^rehearsal!/.test(l)).map((l) => l.split('\t'));
  assert.deepEqual(rows.map((x) => x.slice(0, 3)), [['rehearsal!7', 'land', 'ready'], ['rehearsal!8', 'land', 'ready']], 'both are shown, though only one would land per tick');
  assert.equal(refs(sc.w.remote), before);
});

test('CLI run lands one tick\'s worth and exits 0; merge <project> <iid> acts on that merge request only', async () => {
  const sc = scenario({ lanes: 2 });
  const r = await cli(sc, ['merge', 'rehearsal', '8']);
  assert.equal(r.code, 0);
  assert.equal(merges(r.f).length, 1);
  assert.match(merges(r.f)[0].path, /\/merge_requests\/8\/merge$/);
  const run1 = await cli(scenario(), ['run']);
  assert.equal(run1.code, 0);
  assert.equal(merges(run1.f).length, 1);
  assert.match(run1.out, /"event":"landed"/);
});

test('CLI exit codes: 1 for a failed tick, an unknown project, an unknown command, a missing option value or an unreadable token file', async () => {
  const failing = scenario(); failing.s.eventsFail = true;
  assert.equal((await cli(failing, ['run'])).code, 1);
  assert.equal((await cli(scenario(), ['merge', 'nope', '7'])).code, 1);
  assert.equal((await cli(scenario(), ['merge', 'rehearsal', 'x'])).code, 1);
  assert.equal((await cli(scenario(), ['merge', 'rehearsal', '99'])).code, 1, 'no such open merge request');
  assert.equal((await cli(scenario(), ['frobnicate'])).code, 1);
  const missing = await cli(scenario(), ['run', '--workdir']);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /needs a value/);
  const sc = scenario();
  const out = [];
  const code = await land.main(['run', '--token-file', path.join(sc.w.root, 'no-such-token'), '--url', 'https://gitlab.test', '--workdir', path.join(sc.w.root, 'land')], { stdout: (t) => out.push(t), overrides: { projectsOverride: [] } });
  assert.equal(code, 1);
  assert.match(out.join(''), /ENOENT|no such file/i);
});

test('loadProjects reads the group and the projects of gitlab-settings.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-settings-')); tmpDirs.push(dir);
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, JSON.stringify({ group: 'vitana', projects: { 'vitana-platform': { landing: false }, rehearsal: { landing: true, required_jobs: ['unit', 'build'] } } }));
  assert.deepEqual(land.loadProjects(file), [
    { name: 'vitana-platform', path: 'vitana/vitana-platform', landing: false, required_jobs: [] },
    { name: 'rehearsal', path: 'vitana/rehearsal', landing: true, required_jobs: ['unit', 'build'] },
  ]);
  fs.writeFileSync(file, '{}');
  assert.throws(() => land.loadProjects(file), /needs "group" and "projects"/);
});

// ── the bot reads the same decision code as the GitHub pipeline ───────────────
test('the decision functions are imported from land-guard.mjs and queue.mjs, not copied', () => {
  const src = fs.readFileSync(path.join(HERE, 'gitlab-land.mjs'), 'utf8');
  const guard = /import \{([^}]*)\} from '\.\.\/collab\/land-guard\.mjs'/.exec(src);
  assert.ok(guard, 'an import from land-guard.mjs');
  for (const name of ['laneKeyOf', 'localAfter', 'reviewCurrent', 'checksVerdict', 'protectedTouched', 'mergeDecision']) assert.match(guard[1], new RegExp(`\\b${name}\\b`), name);
  const queue = /import \{([^}]*)\} from '\.\.\/collab\/queue\.mjs'/.exec(src);
  assert.ok(queue, 'an import from queue.mjs');
  for (const name of ['commitsInRange', 'PROTECTED_GATE_PATHS']) assert.match(queue[1], new RegExp(`\\b${name}\\b`), name);
  for (const name of ['laneKeyOf', 'localAfter', 'reviewCurrent', 'checksVerdict', 'protectedTouched', 'mergeDecision', 'commitsInRange']) {
    assert.equal(new RegExp(`(function|const|let|var)\\s+${name}\\b`).test(src), false, `${name} is not defined again in gitlab-land.mjs`);
  }
});

// ── the systemd units ────────────────────────────────────────────────────────
test('vitana-land.service: one tick under flock, niced and limited, with the token in a root-only file and not in the unit', () => {
  const svc = fs.readFileSync(path.join(UNITS, 'vitana-land.service'), 'utf8');
  assert.match(svc, /^Type=oneshot$/m);
  assert.match(svc, /^Nice=\d+$/m);
  assert.match(svc, /^CPUQuota=\d+%$/m);
  assert.match(svc, /^MemoryMax=\S+$/m);
  const exec = svc.split('\n').filter((l) => l.startsWith('ExecStart='));
  assert.equal(exec.length, 1);
  assert.match(exec[0], /\/usr\/bin\/flock -n -E 0 \/run\/vitana-land\.lock /, 'a busy lock exits 0');
  assert.match(exec[0], /scripts\/eng\/gitlab-land\.mjs run /);
  assert.match(exec[0], /--token-file \/etc\/vitana\/bot-land-token/);
  assert.equal(/--token(?!-file)\b|glpat|glrt|token=|PRIVATE-TOKEN/i.test(svc), false, 'no token value in the unit');
});

test('vitana-land.timer: every minute, for vitana-land.service', () => {
  const timer = fs.readFileSync(path.join(UNITS, 'vitana-land.timer'), 'utf8');
  assert.match(timer, /^OnUnitActiveSec=1min$/m);
  assert.match(timer, /^OnBootSec=\S+$/m);
  assert.match(timer, /^Unit=vitana-land\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});
