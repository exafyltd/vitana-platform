// VTID-05144 — confirmLive against a local git fixture (no network, no staging).
// Run: node --test scripts/ci/staging-verify/confirm-live.test.mjs (UNIT.yml runs it on every PR)
//
// STAGING-VERIFY clones the commit under test once at job start. A commit
// merged mid-run is not in that clone, so before VTID-05144 `rev-parse` of the
// new staging stamp failed and a legitimate redeploy read as `mismatch` → a
// failed run. confirmLive now fetches main once and retries; a descendant is
// `superseded`, a non-descendant (e.g. a pinned rollback) stays `mismatch`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmLive } from './run.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};
const g = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(work, name) {
  writeFileSync(join(work, `${name}.txt`), name);
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', name);
  return g(work, 'rev-parse', 'HEAD');
}

// origin (bare) ← work; `target` is the job-start clone, at the commit under test.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-live-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  g(dir, 'init', '-q', '--bare', origin);
  g(dir, 'init', '-q', work);
  const base = commit(work, 'base');
  const sha = commit(work, 'under-test');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const target = join(dir, 'target');
  g(dir, 'clone', '-q', origin, target);
  return { dir, origin, work, base, sha, target };
}

const opts = (stamp) => ({ attempts: 1, samples: 1, retryMs: 0, stamp: async () => stamp });

test('staging serving the commit under test → match', async () => {
  const f = fixture();
  const r = await confirmLive('gateway', f.sha, f.target, opts(f.sha));
  assert.equal(r.state, 'match');
});

test('clone predates a descendant merged mid-run → superseded after the fetch (gateway full stamp)', async () => {
  const f = fixture();
  const newer = commit(f.work, 'merged-mid-run');
  g(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  assert.throws(() => g(f.target, 'rev-parse', '--verify', '--quiet', `${newer}^{commit}`), 'the clone must not know the newer commit yet');
  const r = await confirmLive('gateway', f.sha, f.target, opts(newer));
  assert.deepEqual(r, { state: 'superseded', stamp: newer, full: newer });
});

test('community-app 12-char stamp of a descendant → superseded with the full sha', async () => {
  const f = fixture();
  const newer = commit(f.work, 'merged-mid-run');
  g(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const r = await confirmLive('community-app', f.sha, f.target, opts(newer.slice(0, 12)));
  assert.equal(r.state, 'superseded');
  assert.equal(r.full, newer);
  assert.equal(r.stamp, newer.slice(0, 12));
});

test('a non-descendant on main (e.g. a pinned rollback) → mismatch', async () => {
  const f = fixture();
  g(f.work, 'checkout', '-q', '-b', 'rollback', f.base);
  const sibling = commit(f.work, 'sibling');
  g(f.work, 'push', '-q', '-f', 'origin', 'HEAD:refs/heads/main');
  const r = await confirmLive('gateway', f.sha, f.target, opts(sibling));
  assert.equal(r.state, 'mismatch');
  assert.equal(r.stamp, sibling);
});

test('an older ancestor (staging rolled back) → mismatch', async () => {
  const f = fixture();
  const r = await confirmLive('gateway', f.sha, f.target, opts(f.base));
  assert.equal(r.state, 'mismatch');
});

test('a failed fetch leaves an unknown stamp as mismatch (fail closed)', async () => {
  const f = fixture();
  const newer = commit(f.work, 'merged-mid-run');
  g(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  g(f.target, 'remote', 'set-url', 'origin', join(f.dir, 'does-not-exist.git'));
  const r = await confirmLive('gateway', f.sha, f.target, opts(newer));
  assert.equal(r.state, 'mismatch');
});
