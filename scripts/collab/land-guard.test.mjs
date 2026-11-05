// Plan land-guard §4: the pipeline's step order, enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evidenceMissing, reviewCurrent, checksVerdict, mergeDecision, releaseDecision, protectedTouched, laneKeyOf } from './land-guard.mjs';
// Plan review-survives-main-merge: imported as a namespace so the older tests still run where these exports are missing.
import * as lg from './land-guard.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'land-guard.mjs');
const H = (c) => c.repeat(40);

test('evidence: missing files are named; committed or staged files count', () => {
  assert.deepEqual(evidenceMissing([], 'VTID-1'), ['docs/validation/VTID-1/acceptance.md', 'docs/validation/VTID-1/commands.log', 'docs/validation/VTID-1/scope.json']);
  assert.deepEqual(evidenceMissing(['docs/validation/VTID-1/acceptance.md', 'docs/validation/VTID-1/commands.log', 'docs/validation/VTID-1/scope.json'], 'VTID-1'), []);
});

test('review: same head counts; entry-only commits after it count; a code commit does not', () => {
  assert.equal(reviewCurrent(H('a'), H('a'), []).ok, true);
  assert.equal(reviewCurrent(H('a'), H('b'), [{ sha: H('b'), files: ['.kiro/specs/s/lanes/l.md'] }]).ok, true);
  const r = reviewCurrent(H('a'), H('b'), [{ sha: H('b'), files: ['.kiro/specs/s/lanes/l.md', 'scripts/x.mjs'] }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /scripts\/x\.mjs/);
  assert.equal(reviewCurrent(H('a'), H('b'), []).ok, false, 'not an ancestor');
  assert.equal(reviewCurrent(H('a'), H('b'), [{ sha: H('b'), session: 'pm-agent', files: ['.kiro/specs/s/handoff.md', '.kiro/specs/s/lanes/l.md'] }]).ok, true, 'pm-agent lane-state commit');
  assert.equal(reviewCurrent(H('a'), H('b'), [{ sha: H('b'), session: 'kiro-x-202610280000-abcd', files: ['.kiro/specs/s/handoff.md'] }]).ok, false, 'handoff edit by a non-PM session');
});

test('checks: latest attempt per name decides; pending and empty never pass', () => {
  const c = (name, status, conclusion, started_at) => ({ name, status, conclusion, started_at });
  assert.equal(checksVerdict([c('pr-gate', 'completed', 'failure', '1'), c('pr-gate', 'completed', 'success', '2')]).state, 'pass');
  assert.equal(checksVerdict([c('pr-gate', 'completed', 'success', '1'), c('pr-gate', 'completed', 'failure', '2')]).state, 'fail');
  assert.equal(checksVerdict([c('a', 'completed', 'success', '1'), c('b', 'in_progress', null, '1')]).state, 'pending');
  assert.equal(checksVerdict([]).state, 'pending');
  assert.equal(checksVerdict([c('a', 'completed', 'skipped', '1'), c('b', 'completed', 'neutral', '1')]).state, 'pass');
});

test('merge: refuses on a stale review, red or pending checks, or a PR behind its base', () => {
  const ok = { ok: true }, pass = { state: 'pass' };
  assert.equal(mergeDecision({ review: ok, checks: pass, behindBy: 0 }).ok, true);
  assert.equal(mergeDecision({ review: { ok: false, reason: 'x' }, checks: pass, behindBy: 0 }).code, 1);
  assert.equal(mergeDecision({ review: ok, checks: { state: 'fail', detail: 'x' }, behindBy: 0 }).code, 1);
  assert.equal(mergeDecision({ review: ok, checks: { state: 'pending', detail: 'x' }, behindBy: 0 }).code, 2);
  assert.equal(mergeDecision({ review: ok, checks: pass, behindBy: 1 }).code, 1);
  assert.equal(mergeDecision({ review: ok, checks: pass, behindBy: 0, protectedFiles: ['CLAUDE.md'] }).code, 1);
});

test('merge: protected gate files are detected with queue.mjs glob semantics', () => {
  const globs = ['CLAUDE.md', 'scripts/collab/queue.mjs', '.github/workflows/AWS-PROD-*.yml', 'services/gateway/src/services/plan-sparring/**'];
  assert.deepEqual(protectedTouched(['CLAUDE.md', 'docs/x.md', '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml', 'services/gateway/src/services/plan-sparring/a/b.ts', 'scripts/collab/land-guard.mjs'], globs),
    ['CLAUDE.md', '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml', 'services/gateway/src/services/plan-sparring/a/b.ts']);
});

test('release: a lane only when done/parked; _plan only when the plan and every lane are', () => {
  for (const s of ['ready', 'executing', 'in-review', 'verified']) assert.equal(releaseDecision('l', { laneState: s }).ok, false, s);
  for (const s of ['done', 'parked']) assert.equal(releaseDecision('l', { laneState: s }).ok, true, s);
  assert.equal(releaseDecision('_plan', { planState: 'verified', laneStates: {} }).ok, false);
  assert.equal(releaseDecision('_plan', { planState: 'done', laneStates: { a: 'done', b: 'verified' } }).ok, false);
  assert.equal(releaseDecision('_plan', { planState: 'done', laneStates: { a: 'done', b: 'parked' } }).ok, true);
});

test('CLI: release of a verified lane exits 1 and leaves the claim ref in place', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-'));
  const remote = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  fs.mkdirSync(path.join(work, '.kiro/specs/s/lanes'), { recursive: true });
  fs.writeFileSync(path.join(work, '.kiro/specs/s/handoff.md'), '---\nslug: s\nstate: verified\n---\n');
  fs.writeFileSync(path.join(work, '.kiro/specs/s/lanes/l.md'), '---\nlane: l\nstate: verified\n---\n');
  g(work, 'add', '-A');
  g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  g(work, 'remote', 'add', 'origin', remote);
  g(work, 'push', '-q', 'origin', 'main', 'HEAD:refs/heads/collab-claim/s/l', 'HEAD:refs/heads/collab-driver/s');
  const cli = (...a) => { try { execFileSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' }); return 0; } catch (e) { return e.status; } };
  assert.equal(cli('release', '--repo', work, '--slug', 's', '--lane', 'l', '--session', 'kiro-x-202610280000-abcd'), 1);
  assert.equal(cli('release', '--repo', work, '--slug', 's', '--lane', '_plan', '--session', 'kiro-x-202610280000-abcd'), 1);
  assert.equal(cli('release-heartbeat', '--repo', work, '--slug', 's'), 1);
  const refs = g(remote, 'for-each-ref', '--format=%(refname)');
  assert.match(refs, /collab-claim\/s\/l/);
  assert.match(refs, /collab-driver\/s/);
  assert.equal(cli('evidence', '--repo', work, '--vtid', 'VTID-9'), 1);
});

test('CLI: evidence passes on this repository for a VTID whose evidence is committed (no buffer overflow on a large tree)', () => {
  const repo = execFileSync('git', ['-C', path.dirname(SCRIPT), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const out = execFileSync(process.execPath, [SCRIPT, 'evidence', '--repo', repo, '--vtid', 'VTID-05343'], { encoding: 'utf8' });
  assert.match(out, /evidence present/);
});

test('review: with the lane key only that lane file (and its handoff for pm-agent) counts', () => {
  const k = 's/l';
  assert.equal(reviewCurrent(H('a'), H('b'), [{ sha: H('b'), files: ['.kiro/specs/s/lanes/l.md'] }], k).ok, true);
  assert.equal(reviewCurrent(H('a'), H('b'), [{ sha: H('b'), files: ['.kiro/specs/other/lanes/x.md'] }], k).ok, false);
  assert.equal(reviewCurrent(H('a'), H('b'), [{ sha: H('b'), session: 'pm-agent', files: ['.kiro/specs/s/handoff.md'] }], k).ok, true);
  assert.equal(reviewCurrent(H('a'), H('b'), [{ sha: H('b'), session: 'pm-agent', files: ['.kiro/specs/z/handoff.md'] }], k).ok, false);
  assert.equal(laneKeyOf('VTID-05362 (step-order-gate/land-guard): land-guard …'), 'step-order-gate/land-guard');
});

test('checks: a queued re-run without started_at keeps the check pending', () => {
  const runs = [{ name: 'pr-gate', status: 'completed', conclusion: 'success', started_at: '2026-10-28T10:00:00Z', id: 1 },
    { name: 'pr-gate', status: 'queued', conclusion: null, started_at: null, id: 2 }];
  assert.equal(checksVerdict(runs).state, 'pending');
});

test('CLI: release of a done lane exits 0 and frees the claim; a staged deletion is not evidence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-ok-'));
  const remote = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  fs.mkdirSync(path.join(work, '.kiro/specs/s/lanes'), { recursive: true });
  fs.mkdirSync(path.join(work, 'docs/validation/VTID-7'), { recursive: true });
  fs.writeFileSync(path.join(work, '.kiro/specs/s/handoff.md'), '---\nslug: s\nstate: done\n---\n');
  fs.writeFileSync(path.join(work, '.kiro/specs/s/lanes/l.md'), '---\nlane: l\nstate: done\n---\n');
  for (const f of ['acceptance.md', 'commands.log', 'scope.json']) fs.writeFileSync(path.join(work, 'docs/validation/VTID-7', f), 'x\n');
  g(work, 'add', '-A');
  g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  g(work, 'remote', 'add', 'origin', remote);
  g(work, 'push', '-q', 'origin', 'main');
  const session = 'kiro-x-202610280000-abcd';
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync(process.execPath, [path.join(path.dirname(SCRIPT), 'queue.mjs'), 'claim', 's/l', '--session', session, '--repo', work], { env, stdio: 'ignore' });
  assert.match(g(remote, 'for-each-ref', '--format=%(refname)'), /collab-claim\/s\/l/);
  const run = (...a) => { try { execFileSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }); return 0; } catch (e) { return e.status; } };
  assert.equal(run('release', '--repo', work, '--slug', 's', '--lane', 'l', '--session', session), 0);
  assert.doesNotMatch(g(remote, 'for-each-ref', '--format=%(refname)'), /collab-claim\/s\/l/);
  assert.equal(run('evidence', '--repo', work, '--vtid', 'VTID-7'), 0);
  g(work, 'rm', '-q', '--cached', 'docs/validation/VTID-7/scope.json');
  assert.equal(run('evidence', '--repo', work, '--vtid', 'VTID-7'), 1);
});

// ── plan review-survives-main-merge: a review stays current across a clean merge of main ──
test('mergeKeepsReview: each condition is checked and named', () => {
  const ok = { parents: [H('1'), H('2')], secondParentOnMain: true, autoMergeTree: H('t'), commitTree: H('t'), protectedFiles: [] };
  assert.equal(lg.mergeKeepsReview(ok).ok, true);
  const no = (o, re) => { const r = lg.mergeKeepsReview({ ...ok, ...o }); assert.equal(r.ok, false); assert.match(r.reason, re); };
  no({ parents: [H('1'), H('2'), H('3')] }, /3 parents/);
  no({ parents: [H('1')] }, /1 parent/);
  no({ secondParentOnMain: false }, /not on origin\/main/);
  no({ autoMergeTree: null }, /conflict/);
  no({ commitTree: H('u') }, /automatic merge/);
  no({ protectedFiles: ['CLAUDE.md'] }, /CLAUDE\.md/);
});
test('reviewCurrent: a merge commit counts only when it keeps the review and the PR diff is the same', () => {
  const m = { parents: [H('1'), H('2')], secondParentOnMain: true, autoMergeTree: H('t'), commitTree: H('t'), protectedFiles: [] };
  const after = [{ sha: H('b'), files: ['x.txt'], merge: m }];
  const r = lg.reviewCurrent(H('a'), H('b'), after, 's/l', true);
  assert.equal(r.ok, true);
  assert.match(r.reason, /clean merges of main/);
  assert.match(lg.reviewCurrent(H('a'), H('b'), after, 's/l', false).reason, /own diff changed/);
  assert.equal(lg.reviewCurrent(H('a'), H('b'), after, 's/l').ok, false, 'prDiffSame not supplied');
  assert.equal(lg.reviewCurrent(H('a'), H('b'), [{ sha: H('b'), files: ['x.txt'] }], 's/l', true).ok, false, 'a commit without merge facts keeps the entry-only test');
});
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
/** A repo whose origin is a local bare repo at <tmp>/o/r.git; branch `pr` has the reviewed head R (edits a.txt line 2). */
function mergeFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-m-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'o'));
  const remote = path.join(tmp, 'o', 'r.git');
  const work = path.join(tmp, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const g = (...a) => execFileSync('git', ['-C', work, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), s); };
  const commit = (msg) => { g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
  write('a.txt', lines(30));
  write('b.txt', 'b\n');
  write('CLAUDE.md', 'rules\n');
  write('.claude/rules/collaboration.md', 'collab\n');
  write('.kiro/specs/s/lanes/l.md', '---\nlane: l\n---\n## Log\n');
  commit('base');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', 'origin', 'main');
  g('fetch', '-q', 'origin');
  g('checkout', '-q', '-b', 'pr');
  write('a.txt', lines(30, { 2: 'line 2 (pr)' }));
  const R = commit('pr change');
  /** Commit on main (pushed, origin/main fetched), then back on `pr`. */
  const onMain = (f, s) => { g('checkout', '-q', 'main'); write(f, s); const c = commit(`main ${f}`); g('push', '-q', 'origin', 'main'); g('fetch', '-q', 'origin'); g('checkout', '-q', 'pr'); return c; };
  const head = () => g('rev-parse', 'HEAD');
  const check = (key = 's/l') => { const { after, prDiffSame } = lg.localAfter(work, R, head(), key); return lg.reviewCurrent(R, head(), after, key, prDiffSame); };
  return { tmp, remote, work, g, write, commit, R, onMain, head, check };
}
test('local walk (a): a clean merge of main that leaves the PR diff unchanged keeps the review', (t) => {
  const f = mergeFixture(t);
  f.onMain('b.txt', 'b changed on main\n');
  f.g('merge', '-q', '--no-edit', 'origin/main');
  const r = f.check();
  assert.equal(r.ok, true, r.reason);
});
test('local walk (b): main changes a PR file without conflict → refused, the PR diff changed', (t) => {
  const f = mergeFixture(t);
  f.onMain('a.txt', lines(30, { 28: 'line 28 (main)' }));
  f.g('merge', '-q', '--no-edit', 'origin/main');
  const r = f.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /own diff changed/);
});
test('local walk (c): a conflict resolved by hand → refused, not Git\'s automatic merge', (t) => {
  const f = mergeFixture(t);
  f.onMain('a.txt', lines(30, { 2: 'line 2 (main)' }));
  assert.throws(() => f.g('merge', '-q', '--no-edit', 'origin/main'));
  f.write('a.txt', lines(30, { 2: 'line 2 (pr)' }));
  f.commit('resolve');
  const r = f.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /conflict/);
});
test('local walk (d): a clean merge with an extra edit in the merge commit → refused, tree differs', (t) => {
  const f = mergeFixture(t);
  f.onMain('b.txt', 'b changed on main\n');
  f.g('merge', '-q', '--no-commit', '--no-ff', 'origin/main');
  f.write('c.txt', 'sneaked in\n');
  f.commit('merge with an extra file');
  const r = f.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /automatic merge/);
});
test('local walk (e/e2): a merge that brings in a protected gate file or a governance path → refused', (t) => {
  for (const file of ['CLAUDE.md', '.claude/rules/collaboration.md']) {
    const f = mergeFixture(t);
    f.onMain(file, 'changed on main\n');
    f.g('merge', '-q', '--no-edit', 'origin/main');
    const r = f.check();
    assert.equal(r.ok, false, file);
    assert.match(r.reason, new RegExp(file.replace(/\./g, '\\.')), file);
  }
});
test('local walk (f): a merge of a branch that is not on main → refused', (t) => {
  const f = mergeFixture(t);
  f.g('checkout', '-q', '-b', 'side', 'main');
  f.write('b.txt', 'b on side\n');
  f.commit('side');
  f.g('checkout', '-q', 'pr');
  f.g('merge', '-q', '--no-edit', 'side');
  const r = f.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /not on origin\/main/);
});
test('local walk (g): the PR rebased onto main after the review → refused, not an ancestor', (t) => {
  const f = mergeFixture(t);
  f.onMain('b.txt', 'b changed on main\n');
  f.g('rebase', '-q', 'origin/main');
  const r = f.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /not an ancestor/);
});
test('local walk (h): a clean merge then a review entry keeps the review; a later code commit voids it', (t) => {
  const f = mergeFixture(t);
  f.onMain('b.txt', 'b changed on main\n');
  f.g('merge', '-q', '--no-edit', 'origin/main');
  f.write('.kiro/specs/s/lanes/l.md', '---\nlane: l\n---\n## Log\n### review\nreview: accept\n');
  f.commit('review entry');
  const ok = f.check();
  assert.equal(ok.ok, true, ok.reason);
  f.write('a.txt', lines(30, { 2: 'line 2 (pr)', 5: 'line 5 (pr)' }));
  f.commit('code');
  const r = f.check();
  assert.equal(r.ok, false);
  assert.match(r.reason, /a new review is needed/);
});
// POSIX only: the stub `gh` is a shebang script, which Windows cannot exec without a shell. CI (ubuntu) runs it.
test('CLI (j): review --repo walks the local checkout and checks the origin URL', { skip: process.platform === 'win32' && 'stub gh needs a POSIX shebang' }, (t) => {
  const cli = (f, gh, extra = {}) => {
    const bin = path.join(f.tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const pr = JSON.stringify({ number: 1, title: 'VTID-1 (s/l): x', head: { sha: f.head() }, base: { ref: 'main' }, ...extra });
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node\nif (process.argv[2] === 'api' && /\\/pulls\\/1$/.test(process.argv[3])) console.log(${JSON.stringify(pr)}); else process.exit(1);\n`, { mode: 0o755 });
    f.g('push', '-q', 'origin', `${f.head()}:refs/pull/1/head`);
    try { execFileSync(process.execPath, [SCRIPT, 'review', '--gh', gh, '--repo', f.work, '--pr', '1', '--reviewed-head', f.R], { encoding: 'utf8', env: { ...GIT_ENV, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] }); return 0; } catch (e) { return e.status; }
  };
  const a = mergeFixture(t);
  a.onMain('b.txt', 'b changed on main\n');
  a.g('merge', '-q', '--no-edit', 'origin/main');
  assert.equal(cli(a, 'o/r'), 0, 'clean merge of main');
  assert.equal(cli(a, 'x/y'), 1, 'origin does not name x/y');
  const c = mergeFixture(t);
  c.onMain('a.txt', lines(30, { 2: 'line 2 (main)' }));
  assert.throws(() => c.g('merge', '-q', '--no-edit', 'origin/main'));
  c.write('a.txt', lines(30, { 2: 'line 2 (pr)' }));
  c.commit('resolve');
  assert.equal(cli(c, 'o/r'), 1, 'conflict resolved by hand');
});
