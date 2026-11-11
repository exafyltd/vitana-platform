// Tests of the cross-repo review source (plan agentic-delivery §3.5, lane merge-queue): scripts/eng/review-source.mjs.
// A vitana-v1 merge request titled `VTID-xxxxx (<slug>/<lane>): …` has its review entry in the vitana-platform lane file.
// Every scenario uses real temporary git repositories: one for the platform project (lane files and review entries on
// `main` and on `kiro/<slug>/*` branches) and one for the vitana-v1 project (the merge request's commits), each read
// through a bare clone the way the merge bot holds them. Dependency-free Node (node:test); UNIT.yml runs it with no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rs from './review-source.mjs';

const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'kiro-agent[bot]', GIT_AUTHOR_EMAIL: 'k@test', GIT_COMMITTER_NAME: 'kiro-agent[bot]', GIT_COMMITTER_EMAIL: 'k@test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gAt = (cwd, when, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...GIT_ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const KEY = 'demo/web-a';
const LANE_FILE = '.kiro/specs/demo/lanes/web-a.md';
const BUILDER = 'kiro-exafy-202611051000-aaaa';
const REVIEWER_SESSION = 'agent-vitana-lane-reviewer-202611051100-ab12';
const REVIEWER = 'agent:vitana-lane-reviewer (claude-sonnet-5.5)';

function repoPair(root, name) {
  const remote = path.join(root, `${name}.git`);
  const work = path.join(root, `${name}-work`);
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', remote, work], { env: GIT_ENV, stdio: 'ignore' });
  g(work, 'checkout', '-q', '-b', 'main');
  write(work, 'README.md', `${name}\n`);
  g(work, 'add', '-A');
  gAt(work, '2026-11-05T08:00:00Z', 'commit', '-q', '-m', 'initial');
  g(work, 'push', '-q', 'origin', 'main');
  return { remote, work };
}

/** A platform project with the lane file on main, a vitana-v1 project with the lane's merge request, and bare clones. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-source-'));
  tmpDirs.push(root);
  const platform = repoPair(root, 'vitana-platform');
  const v1 = repoPair(root, 'vitana-v1');
  write(platform.work, LANE_FILE, '---\nlane: web-a\nstate: in-review\nrepos: [exafyltd/vitana-v1]\n---\n# Lane web-a\n\n## Log\n');
  write(platform.work, '.kiro/specs/demo/lanes/web-b.md', '---\nlane: web-b\nstate: in-review\n---\n# Lane web-b\n\n## Log\n');
  g(platform.work, 'add', '-A');
  gAt(platform.work, '2026-11-05T09:00:00Z', 'commit', '-q', '-m', 'plan demo\n\nCollab-Session: ci-plan-spar\nCollab-Lane: demo/_plan');
  g(platform.work, 'push', '-q', 'origin', 'main');
  // the merge request in vitana-v1
  g(v1.work, 'checkout', '-q', '-b', 'kiro/demo/web-a');
  write(v1.work, 'src/web-a.ts', 'export const a = 1;\n');
  g(v1.work, 'add', '-A');
  gAt(v1.work, '2026-11-05T10:00:00Z', 'commit', '-q', '-m', `VTID-05999 (demo/web-a): the feature\n\nCollab-Session: ${BUILDER}\nCollab-Lane: ${KEY}`);
  const F = g(v1.work, 'rev-parse', 'HEAD');
  const w = { root, platform, v1, F, n: 0 };
  w.platformClone = path.join(root, 'bot-platform.git');
  w.v1Clone = path.join(root, 'bot-v1.git');
  execFileSync('git', ['init', '--bare', '-q', w.platformClone], { env: GIT_ENV });
  g(w.platformClone, 'remote', 'add', 'origin', platform.remote);
  execFileSync('git', ['init', '--bare', '-q', w.v1Clone], { env: GIT_ENV });
  g(w.v1Clone, 'remote', 'add', 'origin', v1.remote);
  publishMr(w);
  return w;
}
/** Push the merge request branch and refresh the bot's clones (main, the head, and the platform's kiro/<slug>/* branches). */
function publishMr(w) {
  g(w.v1.work, 'push', '-q', '--force', 'origin', 'kiro/demo/web-a:refs/heads/kiro/demo/web-a');
  g(w.v1Clone, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main', '+refs/heads/kiro/demo/web-a:refs/mr/7');
  w.head = g(w.v1Clone, 'rev-parse', 'refs/mr/7');
  return w.head;
}
function refreshPlatform(w) {
  g(w.platformClone, 'fetch', '-q', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main', '+refs/heads/kiro/demo/*:refs/remotes/origin/kiro/demo/*');
}
/** A review entry in the platform lane file: on main, or on a platform branch (`kiro/demo/<x>`). */
function review(w, { on = 'main', verdict = 'accept', reviewed = w.F, reviewer = REVIEWER, session = REVIEWER_SESSION, key = KEY, when, laneFile = LANE_FILE }) {
  w.n += 1;
  const at = when ?? `2026-11-05T11:${String(10 + w.n).padStart(2, '0')}:00Z`;
  if (on === 'main') g(w.platform.work, 'checkout', '-q', 'main');
  else {
    const exists = g(w.platform.work, 'branch', '--list', on);
    g(w.platform.work, 'checkout', '-q', ...(exists ? [on] : ['-b', on, 'main']));
  }
  fs.appendFileSync(path.join(w.platform.work, laneFile), `\n### ${at} · ${session} · review\nreview: ${verdict}\nhead: ${reviewed}\nreviewer: ${reviewer}\n`);
  g(w.platform.work, 'add', '-A');
  gAt(w.platform.work, at, 'commit', '-q', '-m', `review(${key}): ${verdict}\n\nCollab-Session: ${session}\nCollab-Review: ${key}\nCollab-Verdict: ${verdict}\nCollab-Reviewer: ${reviewer}\nCollab-Reviewed-Head: ${reviewed}`);
  g(w.platform.work, 'push', '-q', 'origin', `${on}:refs/heads/${on}`);
  refreshPlatform(w);
  return g(w.platform.work, 'rev-parse', 'HEAD');
}
const judge = (w, extra = {}) => rs.crossRepoReview({ platformRepo: w.platformClone, repo: w.v1Clone, head: w.head, laneKey: KEY, ...extra });

// ── pure parts ───────────────────────────────────────────────────────────────
test('the reviewer chain is the one the pipeline uses, and reviewerModel reads the model of a Collab-Reviewer value', () => {
  assert.deepEqual([...rs.REVIEWER_MODELS], ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-4.5']);
  assert.equal(rs.reviewerModel('agent:vitana-lane-reviewer (claude-opus-5.5)'), 'claude-opus-5.5');
  assert.equal(rs.reviewerModel('agent:vitana-lane-reviewer (gpt-9)'), 'gpt-9', 'the model is read; whether it is in the chain is judged separately');
  assert.equal(rs.reviewerModel('a builder'), null);
  assert.equal(rs.reviewerModel(''), null);
  assert.equal(rs.laneFileOf('demo/web-a'), LANE_FILE);
});

const entry = (o) => ({ sha: 'c'.repeat(40), ref: 'refs/remotes/origin/main', at: '2026-11-05T11:00:00Z', session: REVIEWER_SESSION, reviews: [KEY], verdict: 'accept', reviewer: REVIEWER, model: 'claude-sonnet-5.5', reviewedHead: 'b'.repeat(40), ...o });
const always = () => ({ ok: true, reason: 'current' });
test('judgeEntries: no entry, a newest changes, the newest current accept, a stale accept, and the identity rules', () => {
  assert.equal(rs.judgeEntries([], { laneKey: KEY, current: always }).code, 'no_review');
  assert.equal(rs.judgeEntries([entry({ reviews: ['demo/web-b'] })], { laneKey: KEY, current: always }).code, 'no_review', 'another lane\'s entry does not count');
  const older = entry({ sha: '1'.repeat(40), at: '2026-11-05T11:00:00Z' });
  const newer = entry({ sha: '2'.repeat(40), at: '2026-11-05T11:30:00Z' });
  assert.equal(rs.judgeEntries([older, newer], { laneKey: KEY, current: always }).entry.sha, newer.sha, 'two accepts: the newest current one counts, in any input order');
  assert.equal(rs.judgeEntries([newer, older], { laneKey: KEY, current: always }).entry.sha, newer.sha);
  const onlyOlderCurrent = (e) => (e.sha === older.sha ? { ok: true, reason: 'current' } : { ok: false, reason: 'code changed after it' });
  assert.equal(rs.judgeEntries([older, newer], { laneKey: KEY, current: onlyOlderCurrent }).entry.sha, older.sha, 'the newest CURRENT accept counts');
  const stale = rs.judgeEntries([newer], { laneKey: KEY, current: () => ({ ok: false, reason: 'code changed after it' }) });
  assert.equal(stale.code, 'review_stale');
  assert.match(stale.reason, /code changed after it/);
  assert.equal(rs.judgeEntries([older, entry({ sha: '3'.repeat(40), verdict: 'changes', at: '2026-11-05T12:00:00Z' })], { laneKey: KEY, current: always }).code, 'review_changes', 'a newer changes beats an older accept');
  assert.equal(rs.judgeEntries([entry({ verdict: 'changes', at: '2026-11-05T10:00:00Z' }), newer], { laneKey: KEY, current: always }).ok, true, 'an accept after a changes round counts');
  assert.equal(rs.judgeEntries([entry({ model: 'gpt-9', reviewer: 'agent:vitana-lane-reviewer (gpt-9)' })], { laneKey: KEY, current: always }).code, 'review_model');
  assert.equal(rs.judgeEntries([entry({ model: null, reviewer: 'a builder' })], { laneKey: KEY, current: always }).code, 'review_forged');
  assert.equal(rs.judgeEntries([entry({ session: BUILDER })], { laneKey: KEY, current: always }).code, 'review_forged', 'the entry is not from a reviewer agent session');
  assert.equal(rs.judgeEntries([entry({})], { laneKey: KEY, mrSessions: [BUILDER, REVIEWER_SESSION], current: always }).code, 'review_by_builder');
  assert.equal(rs.judgeEntries([entry({ reviewedHead: 'nope' })], { laneKey: KEY, current: always }).code, 'review_stale', 'an accept without a valid reviewed head is never current');
  const ok = rs.judgeEntries([entry({})], { laneKey: KEY, mrSessions: [BUILDER], current: always });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 'review_found');
});

// ── with real repositories ───────────────────────────────────────────────────
test('finds the accept for <slug>/<lane> on platform main', () => {
  const w = world();
  const R = review(w, { on: 'main' });
  const r = judge(w);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.entry.sha, R);
  assert.equal(r.entry.ref, 'refs/remotes/origin/main');
  assert.equal(r.entry.reviewedHead, w.F);
  assert.equal(r.entry.model, 'claude-sonnet-5.5');
  assert.equal(r.entry.session, REVIEWER_SESSION);
  assert.match(r.entry.at, /^2026-11-05T11:\d\d:00\.000Z$/);
});

test('then on kiro/<slug>/* branches of the platform project, bridged or native', () => {
  const w = world();
  const R = review(w, { on: 'kiro/demo/web-a' });
  const r = judge(w);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.entry.sha, R);
  assert.equal(r.entry.ref, 'refs/remotes/origin/kiro/demo/web-a');
  assert.deepEqual(rs.platformRefs(w.platformClone, 'demo'), ['refs/remotes/origin/main', 'refs/remotes/origin/kiro/demo/web-a']);
});

test('an accept on main and one on a branch: the newest current one counts; an entry on both is read once', () => {
  const w = world();
  review(w, { on: 'main', when: '2026-11-05T11:00:00Z' });
  const branchAccept = review(w, { on: 'kiro/demo/review-x', when: '2026-11-05T11:40:00Z' });
  const r = judge(w);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.entry.sha, branchAccept, 'the newer accept, on the branch');
  // the branch is merged into main: its entry is now on both refs and still read once
  g(w.platform.work, 'checkout', '-q', 'main');
  g(w.platform.work, 'merge', '-q', '--ff-only', 'kiro/demo/review-x');
  g(w.platform.work, 'push', '-q', 'origin', 'main');
  refreshPlatform(w);
  const entries = rs.reviewEntries(w.platformClone, rs.platformRefs(w.platformClone, 'demo'), KEY);
  assert.equal(entries.filter((e) => e.sha === branchAccept).length, 1);
  assert.equal(entries.find((e) => e.sha === branchAccept).ref, 'refs/remotes/origin/main', 'an entry on main is reported as main');
  assert.equal(entries.length, 2);
  assert.ok(Date.parse(entries[0].at) >= Date.parse(entries[1].at), 'newest first');
});

test('entries of other lanes, and commits without review trailers, are not review entries', () => {
  const w = world();
  review(w, { on: 'main', key: 'demo/web-b', laneFile: '.kiro/specs/demo/lanes/web-b.md' });
  g(w.platform.work, 'checkout', '-q', 'main');
  fs.appendFileSync(path.join(w.platform.work, LANE_FILE), '\n### note\nA builder note.\n');
  g(w.platform.work, 'add', '-A');
  g(w.platform.work, 'commit', '-q', '-m', `lane note\n\nCollab-Session: ${BUILDER}\nCollab-Lane: ${KEY}`);
  g(w.platform.work, 'push', '-q', 'origin', 'main');
  refreshPlatform(w);
  assert.deepEqual(rs.reviewEntries(w.platformClone, rs.platformRefs(w.platformClone, 'demo'), KEY), []);
  assert.equal(judge(w).code, 'no_review');
});

test('refuses an entry that reviewCurrent rejects for the merge request\'s commits (code changed after the reviewed head)', () => {
  const w = world();
  review(w, { on: 'main' });
  g(w.v1.work, 'checkout', '-q', 'kiro/demo/web-a');
  write(w.v1.work, 'src/sneaky.ts', 'export const s = 2;\n');
  g(w.v1.work, 'add', '-A');
  g(w.v1.work, 'commit', '-q', '-m', `more code\n\nCollab-Session: ${BUILDER}\nCollab-Lane: ${KEY}`);
  publishMr(w);
  const r = judge(w);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'review_stale');
  assert.match(r.reason, /src\/sneaky\.ts/);
});

test('an accept on an old head that is no longer in the merge request\'s history (force-push) is refused', () => {
  const w = world();
  review(w, { on: 'main' });
  g(w.v1.work, 'checkout', '-q', '-B', 'kiro/demo/web-a', 'main');
  write(w.v1.work, 'src/rewritten.ts', 'export const r = 3;\n');
  g(w.v1.work, 'add', '-A');
  g(w.v1.work, 'commit', '-q', '-m', `VTID-05999 (demo/web-a): rewritten\n\nCollab-Session: ${BUILDER}\nCollab-Lane: ${KEY}`);
  publishMr(w);
  const r = judge(w);
  assert.equal(r.code, 'review_stale');
  assert.match(r.reason, /not an ancestor/);
});

test('a clean merge of main into the merge request after the review keeps the accept', () => {
  const w = world();
  review(w, { on: 'main' });
  g(w.v1.work, 'checkout', '-q', 'main');
  write(w.v1.work, 'docs/other.md', 'main moved\n');
  g(w.v1.work, 'add', '-A');
  g(w.v1.work, 'commit', '-q', '-m', 'main moves');
  g(w.v1.work, 'push', '-q', 'origin', 'main');
  g(w.v1.work, 'checkout', '-q', 'kiro/demo/web-a');
  g(w.v1.work, 'merge', '-q', '--no-ff', '-m', `Merge branch 'main' into kiro/demo/web-a\n\nCollab-Session: bot-land`, 'main');
  publishMr(w);
  const r = judge(w);
  assert.equal(r.ok, true, r.reason);
});

test('refuses an accept whose reviewer session appears on a commit of the merge request', () => {
  const w = world();
  g(w.v1.work, 'checkout', '-q', 'kiro/demo/web-a');
  write(w.v1.work, 'src/helper.ts', 'export const h = 1;\n');
  g(w.v1.work, 'add', '-A');
  g(w.v1.work, 'commit', '-q', '-m', `help\n\nCollab-Session: ${REVIEWER_SESSION}\nCollab-Lane: ${KEY}`);
  const head = publishMr(w);
  review(w, { on: 'main', reviewed: head });
  const r = judge(w);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'review_by_builder');
  assert.match(r.reason, new RegExp(REVIEWER_SESSION));
});

test('refuses an accept by a model outside the chain', () => {
  const w = world();
  review(w, { on: 'main', reviewer: 'agent:vitana-lane-reviewer (claude-instant-1)' });
  const r = judge(w);
  assert.equal(r.code, 'review_model');
  assert.match(r.reason, /claude-instant-1/);
});

test('refuses a changes verdict, also when an older accept exists', () => {
  const w = world();
  review(w, { on: 'main', when: '2026-11-05T11:00:00Z' });
  review(w, { on: 'kiro/demo/web-a', verdict: 'changes', when: '2026-11-05T11:30:00Z' });
  const r = judge(w);
  assert.equal(r.code, 'review_changes');
  assert.equal(r.ok, false);
});

test('an entry that is not from a reviewer agent session is refused', () => {
  const w = world();
  review(w, { on: 'kiro/demo/web-a', session: BUILDER });
  assert.equal(judge(w).code, 'review_forged');
});

test('a platform clone without main fails closed: an error, never an accept', () => {
  const w = world();
  review(w, { on: 'main' });
  const empty = path.join(w.root, 'empty.git');
  execFileSync('git', ['init', '--bare', '-q', empty], { env: GIT_ENV });
  assert.throws(() => rs.platformRefs(empty, 'demo'), /origin\/main/);
  assert.throws(() => rs.crossRepoReview({ platformRepo: empty, repo: w.v1Clone, head: w.head, laneKey: KEY }), /origin\/main/);
  assert.throws(() => rs.crossRepoReview({ platformRepo: path.join(w.root, 'missing.git'), repo: w.v1Clone, head: w.head, laneKey: KEY }));
});
