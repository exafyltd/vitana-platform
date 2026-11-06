// VTID-05552 (agentic-delivery/verify-on-gitlab) — the `.staging-verify` job's wrapper (plan agentic-delivery §3.6 steps
// 3 and 8). Run: node --test scripts/eng/verify/shadow-wait.test.mjs (UNIT.yml runs it on every PR: Node 20, no install).
//
// Shadow mode (DELIVERY_MODE=shadow, before the cutover): GitHub still deploys staging, so the GitLab job waits up to 60
// minutes for staging to serve the commit, then runs platform main's run.mjs verify and keeps its result in the job
// artifact. If staging never serves the commit (or moves past it to a descendant, so it never will), the result is
// `not_comparable`, run.mjs does not run and nothing is recorded. Live mode runs run.mjs at once. The clock, the sleep,
// the staging check and run.mjs are injected, so no test waits and none touches staging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = () => import(pathToFileURL(join(HERE, 'shadow-wait.mjs')).href);

const SHA = '1d2c3b4a59687766554433221100ffeeddccbbaa';
const NEWER = 'aa00bb11cc22dd33ee44ff5566778899aabbccdd';
const OLDER = '0ca24febdb1614310048b763dfd79481be0cb33e';

/** A fake clock: sleep advances it; nothing really waits. */
function clock() {
  let t = Date.parse('2026-11-05T12:00:00.000Z');
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps };
}

/** confirm() answers, in order, from a list of confirmLive states; the last one repeats. */
function staging(states) {
  const calls = [];
  return {
    calls,
    confirm: async () => {
      const s = states[Math.min(calls.length, states.length - 1)];
      calls.push(s);
      return s;
    },
  };
}

function job(m, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-wait-'));
  const verifies = [];
  const c = clock();
  const opts = {
    mode: 'shadow', service: 'gateway', sha: SHA, repoRoot: '/builds/vitana/vitana-platform', out: dir,
    deployRunsFile: '/builds/vitana/vitana-platform/deploy-runs.json', full: false,
    now: c.now, sleep: c.sleep,
    runVerify: async (argv) => {
      verifies.push(argv);
      writeFileSync(join(dir, 'results.json'), JSON.stringify({ outcome: 'passed', sha: SHA }));
      return 0;
    },
    ...over,
  };
  return { dir, verifies, clock: c, opts, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('shadow mode: waits until staging serves the commit, then runs run.mjs verify once', async () => {
  const m = await load();
  const st = staging([{ state: 'mismatch', stamp: OLDER }, { state: 'mismatch', stamp: OLDER }, { state: 'match', stamp: SHA }]);
  const j = job(m, { confirm: st.confirm });
  try {
    const code = await m.runStagingVerify(j.opts);
    assert.equal(code, 0);
    assert.equal(st.calls.length, 3);
    assert.deepEqual(j.clock.sleeps, [m.SHADOW_POLL_MS, m.SHADOW_POLL_MS]);
    assert.equal(j.verifies.length, 1);
    const shadow = readJson(join(j.dir, 'shadow.json'));
    assert.equal(shadow.mode, 'shadow');
    assert.equal(shadow.outcome, 'passed');
    assert.equal(shadow.recorded, false);
    assert.equal(shadow.waited_ms, 2 * m.SHADOW_POLL_MS);
  } finally {
    j.done();
  }
});

test('shadow mode: staging never serves the commit within 60 minutes → not_comparable, run.mjs never runs, nothing recorded', async () => {
  const m = await load();
  assert.equal(m.SHADOW_WAIT_MS, 60 * 60_000);
  const st = staging([{ state: 'mismatch', stamp: OLDER }]);
  const j = job(m, { confirm: st.confirm });
  try {
    const code = await m.runStagingVerify(j.opts);
    assert.equal(code, 0, 'not comparable is not a verification failure');
    assert.equal(j.verifies.length, 0, 'run.mjs did not run');
    assert.equal(existsSync(join(j.dir, 'results.json')), false, 'no results.json, so no record step can pick one up');
    const shadow = readJson(join(j.dir, 'shadow.json'));
    assert.equal(shadow.outcome, 'not_comparable');
    assert.equal(shadow.recorded, false);
    assert.match(shadow.reason, /60 minutes/);
    const waited = j.clock.sleeps.reduce((a, b) => a + b, 0);
    assert.ok(waited <= m.SHADOW_WAIT_MS, `waited ${waited} ms, at most 60 minutes`);
    assert.ok(waited >= m.SHADOW_WAIT_MS - m.SHADOW_POLL_MS, `waited ${waited} ms, the full window`);
  } finally {
    j.done();
  }
});

test('shadow mode: staging already serves a descendant → not_comparable at once (it will never serve the commit)', async () => {
  const m = await load();
  const st = staging([{ state: 'superseded', stamp: NEWER, full: NEWER }]);
  const j = job(m, { confirm: st.confirm });
  try {
    assert.equal(await m.runStagingVerify(j.opts), 0);
    assert.equal(st.calls.length, 1);
    assert.deepEqual(j.clock.sleeps, []);
    assert.equal(j.verifies.length, 0);
    const shadow = readJson(join(j.dir, 'shadow.json'));
    assert.equal(shadow.outcome, 'not_comparable');
    assert.match(shadow.reason, new RegExp(NEWER.slice(0, 12)));
  } finally {
    j.done();
  }
});

test('shadow mode: a failed verification keeps its exit code; the result stays in the artifact', async () => {
  const m = await load();
  const st = staging([{ state: 'match', stamp: SHA }]);
  const j = job(m, { confirm: st.confirm });
  j.opts.runVerify = async () => { writeFileSync(join(j.dir, 'results.json'), JSON.stringify({ outcome: 'failed', sha: SHA })); return 1; };
  try {
    assert.equal(await m.runStagingVerify(j.opts), 1);
    assert.equal(readJson(join(j.dir, 'shadow.json')).outcome, 'failed');
  } finally {
    j.done();
  }
});

test('live mode: no wait; run.mjs verify runs at once', async () => {
  const m = await load();
  const st = staging([{ state: 'mismatch', stamp: OLDER }]);
  const j = job(m, { mode: 'live', confirm: st.confirm });
  try {
    assert.equal(await m.runStagingVerify(j.opts), 0);
    assert.equal(st.calls.length, 0, 'no staging poll in live mode (the deploy job already checked the stamp)');
    assert.equal(j.verifies.length, 1);
    assert.equal(existsSync(join(j.dir, 'shadow.json')), false);
  } finally {
    j.done();
  }
});

test('DELIVERY_MODE: only the exact value `live` is live; anything else, unset included, is shadow', async () => {
  const m = await load();
  assert.equal(m.deliveryMode('live'), 'live');
  for (const v of ['shadow', '', undefined, 'LIVE', 'true']) assert.equal(m.deliveryMode(v), 'shadow', String(v));
});

test('run.mjs is always given --deploy-runs-file (never the GitHub listing), and the full flag', async () => {
  const m = await load();
  assert.deepEqual(m.verifyArgs({ service: 'community-app', sha: SHA, repoRoot: '/r', out: '/o', deployRunsFile: '/r/deploy-runs.json', full: true }), [
    'verify', '--service', 'community-app', '--sha', SHA, '--repo-root', '/r', '--out', '/o', '--full', 'true', '--chain', '0', '--deploy-runs-file', '/r/deploy-runs.json',
  ]);
  assert.deepEqual(m.verifyArgs({ service: 'gateway', sha: SHA, repoRoot: '/r', out: '/o', deployRunsFile: '', full: false }).slice(-2), ['--deploy-runs-file', '']);
});

test('target.json records what the job verifies before anything else runs (the record job reads it)', async () => {
  const m = await load();
  const st = staging([{ state: 'mismatch', stamp: OLDER }]);
  const j = job(m, { confirm: st.confirm, full: true });
  try {
    await m.runStagingVerify(j.opts);
    assert.deepEqual(readJson(join(j.dir, 'target.json')), { service: 'gateway', sha: SHA, mode: 'shadow', full: true });
  } finally {
    j.done();
  }
});

test('bad input is refused before any wait: unknown service, short sha', async () => {
  const m = await load();
  const st = staging([{ state: 'match', stamp: SHA }]);
  for (const over of [{ service: 'erp' }, { sha: SHA.slice(0, 12) }]) {
    const j = job(m, { confirm: st.confirm, ...over });
    try {
      await assert.rejects(() => m.runStagingVerify(j.opts));
      assert.equal(j.verifies.length, 0);
    } finally {
      j.done();
    }
  }
  assert.equal(st.calls.length, 0);
});

test('nightly (--sha-from-staging): the commit is the one staging serves now, checked out before the full run', async () => {
  const m = await load();
  const checkouts = [];
  assert.equal(await m.stagingCommit({ readStamp: async () => NEWER, checkout: async (s) => { checkouts.push(s); } }), NEWER);
  assert.deepEqual(checkouts, [NEWER]);
  await assert.rejects(() => m.stagingCommit({ readStamp: async () => null, checkout: async () => {} }), /staging/);
  await assert.rejects(() => m.stagingCommit({ readStamp: async () => 'not-a-sha', checkout: async () => {} }), /staging/);
});
