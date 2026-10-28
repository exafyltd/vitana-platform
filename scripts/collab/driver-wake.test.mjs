// VTID-05354 (plan pipeline-agent-wake-and-review, lane driver-wake). Run: node --test scripts/collab/driver-wake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as W from './driver-wake.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const MIN = 60_000;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('slug regex is the same as queue.mjs and plan-driver.mjs', () => {
  const src = (f) => (/const SLUG_RE = (\/[^\n]+\/);/.exec(readFileSync(path.join(HERE, f), 'utf8')) || [])[1];
  assert.equal(src('queue.mjs'), W.SLUG_RE.toString());
  assert.equal(src('plan-driver.mjs'), W.SLUG_RE.toString());
});

test('parseEvent: PLAN-SPAR workflow_run (success or failure) on a same-repo plan( PR', () => {
  const run = (o) => ({ workflow_run: { name: 'PLAN-SPAR', conclusion: 'success', display_title: 'plan(my-plan): x', head_branch: 'kiro/my-plan/plan', head_repository: { full_name: 'exafyltd/vitana-platform' }, ...o }, repository: { full_name: 'exafyltd/vitana-platform' } });
  assert.deepEqual(W.parseEvent('workflow_run', run()), { slug: 'my-plan', why: 'PLAN-SPAR success' });
  assert.deepEqual(W.parseEvent('workflow_run', run({ conclusion: 'failure' })), { slug: 'my-plan', why: 'PLAN-SPAR failure' });
  assert.equal(W.parseEvent('workflow_run', run({ display_title: 'VTID-1 (x/y): z', head_branch: 'kiro/x/y' })).skip, 'not a plan event');
  assert.equal(W.parseEvent('workflow_run', run({ name: 'unit' })).skip, 'not a plan event');
  assert.equal(W.parseEvent('workflow_run', run({ head_repository: { full_name: 'someone/fork' } })).skip, 'fork');
});

test('parseEvent: a push to kiro/<slug>/<lane> whose commits carry Collab-Verdict', () => {
  const push = (msg, ref = 'refs/heads/kiro/my-plan/lane-a') => ({ ref, commits: [{ message: 'work\n\nCollab-Lane: my-plan/lane-a' }, { message: msg }] });
  assert.deepEqual(W.parseEvent('push', push('review\n\nCollab-Review: my-plan/lane-a\nCollab-Verdict: accept')), { slug: 'my-plan', why: 'review verdict pushed' });
  assert.equal(W.parseEvent('push', push('just work\n\nCollab-Lane: my-plan/lane-a')).skip, 'not a plan event');
  assert.equal(W.parseEvent('push', push('x\n\nCollab-Verdict: accept', 'refs/heads/claude/my-plan/a')).skip, 'not a plan event');
  assert.equal(W.parseEvent('push', push('x\n\nCollab-Verdict: accept', 'refs/heads/kiro/close/my-plan/a-i1')).slug, 'my-plan', 'closing-record branches resolve to their plan');
});

test('parseEvent: slug injection and odd input never produce a slug', () => {
  for (const t of ['plan(a;rm -rf /): x', 'plan(../x): x', 'plan(Upper): x', 'plan($(id)): x', 'plan(): x']) {
    const r = W.parseEvent('workflow_run', { workflow_run: { name: 'PLAN-SPAR', display_title: t, head_branch: 'kiro/whatever/plan', head_repository: { full_name: 'a/b' } }, repository: { full_name: 'a/b' } });
    assert.ok(r.skip, `${t} → skip`);
  }
  assert.ok(W.parseEvent('workflow_dispatch', { inputs: { slug: 'a b' } }).skip);
  assert.deepEqual(W.parseEvent('workflow_dispatch', { inputs: { slug: 'my-plan' } }), { slug: 'my-plan', why: 'manual dispatch' });
  assert.ok(W.parseEvent('pull_request', {}).skip);
});

test('decide: every branch', () => {
  const base = { slug: 'my-plan', now: NOW, heartbeatAgeMs: 'none', markers: [], keySet: true };
  assert.deepEqual(W.decide(base), { decision: 'wake', reason: 'no live driver' });
  assert.equal(W.decide({ ...base, heartbeatAgeMs: 10 * MIN }).reason, 'driver alive');
  assert.equal(W.decide({ ...base, heartbeatAgeMs: 50 * MIN }).decision, 'wake', 'a stale heartbeat (> 45 min) is not alive');
  assert.equal(W.decide({ ...base, markers: [{ slug: 'my-plan', at: NOW - 5 * MIN }] }).reason, 'woken recently');
  assert.equal(W.decide({ ...base, markers: [{ slug: 'my-plan', at: NOW - 25 * MIN }] }).decision, 'wake');
  const six = Array.from({ length: 6 }, (_, i) => ({ slug: `p${i}`, at: NOW - (30 + i) * MIN }));
  assert.equal(W.decide({ ...base, markers: six }).reason, 'wake budget');
  assert.equal(W.decide({ ...base, markers: six.map((m) => ({ ...m, at: NOW - 70 * MIN })) }).decision, 'wake', 'markers older than 1 h do not count');
  assert.deepEqual(W.decide({ ...base, keySet: false }), { decision: 'skip', reason: 'wake unavailable: KIRO_API_KEY not configured' });
  assert.equal(W.decide({ ...base, slug: 'Bad' }).reason, 'not a plan event');
});

test('wakePrompt is a fixed sentence with only the validated slug', () => {
  assert.equal(W.wakePrompt('my-plan'), 'Read docs/kiro/driver-wake.md in vitana-platform, section "For the woken session", and follow it for plan my-plan.');
  assert.throws(() => W.wakePrompt('a;b'));
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'driver-wake-'));
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(dir, 'clone', '-q', remote, work);
  sh(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root');
  sh(work, 'push', '-q', 'origin', 'HEAD:main');
  sh(work, 'fetch', '-q', 'origin');
  return { work, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('markers: write is fast-forward with main\'s tree; list reads them; prune deletes only old ones', () => {
  const f = fixture();
  try {
    const a = W.writeMarker(f.work, 'my-plan', { now: NOW });
    assert.equal(sh(f.work, 'rev-parse', `${a}^{tree}`), sh(f.work, 'rev-parse', 'origin/main^{tree}'));
    const b = W.writeMarker(f.work, 'my-plan', { now: NOW + MIN });
    assert.equal(sh(f.work, 'rev-parse', `${b}^`), a, 'second marker is a child of the first (no force)');
    W.writeMarker(f.work, 'old-plan', { now: NOW - 3 * 60 * MIN });
    const list = W.listMarkers(f.work);
    assert.deepEqual(list.map((m) => m.slug).sort(), ['my-plan', 'old-plan']);
    assert.deepEqual(W.pruneMarkers(f.work, list, { now: NOW }), ['old-plan']);
    assert.deepEqual(W.listMarkers(f.work).map((m) => m.slug), ['my-plan']);
  } finally { f.done(); }
});

test('CLI run: missing key → green no-op with a summary line, no marker written', () => {
  const f = fixture();
  try {
    const ev = path.join(f.work, '..', 'event.json');
    writeFileSync(ev, JSON.stringify({ inputs: { slug: 'my-plan' } }));
    const summary = path.join(f.work, '..', 'summary.md');
    const out = path.join(f.work, '..', 'out.txt');
    writeFileSync(summary, ''); writeFileSync(out, '');
    execFileSync(process.execPath, [path.join(HERE, 'driver-wake.mjs'), 'run', '--repo', f.work, '--event', ev, '--event-name', 'workflow_dispatch'], {
      env: { ...process.env, KIRO_API_KEY_SET: 'false', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: out },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(readFileSync(summary, 'utf8'), /wake unavailable: KIRO_API_KEY not configured/);
    assert.match(readFileSync(out, 'utf8'), /^decision=skip$/m);
    assert.deepEqual(W.listMarkers(f.work), []);
  } finally { f.done(); }
});

test('DRIVER-WAKE.yml: checks out main, never reds a lane head, skips until the script is on main', () => {
  const y = readFileSync(path.join(HERE, '../../.github/workflows/DRIVER-WAKE.yml'), 'utf8');
  assert.match(y, /uses: actions\/checkout@v4\n\s+with:\n\s+ref: main\n/);
  const steps = y.split(/\n      - /).slice(1).filter((st) => /^name: /.test(st));
  assert.deepEqual(steps.map((st) => /^name: (.+)/.exec(st)[1]), ['Decide', 'Start one Kiro cloud session (fixed prompt)']);
  for (const st of steps) assert.match(st, /\n\s+continue-on-error: true\n/, `step ${st.split('\n')[0]} must not fail the check`);
  assert.match(y, /if \[ ! -f scripts\/collab\/driver-wake\.mjs \]; then .*exit 0; fi/);
  assert.match(y, /paths: \['\.kiro\/specs\/\*\/lanes\/\*\.md'\]/);
  assert.doesNotMatch(y, /pull_request/);
});
