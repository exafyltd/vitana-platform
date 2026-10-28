// Plan land-guard §4: the pipeline's step order, enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evidenceMissing, reviewCurrent, checksVerdict, mergeDecision, releaseDecision, protectedTouched } from './land-guard.mjs';

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
