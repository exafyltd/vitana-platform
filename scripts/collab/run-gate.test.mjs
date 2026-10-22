// VTID-05338 (plan pipeline-speed, lane slot-sizing) — run-gate.cjs, the skip gate of the pipeline recipe.
// Run: node --test scripts/collab/run-gate.test.mjs. Temp RUN and temp engine-state dirs only; never the real ~/.kiro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(HERE, 'run-gate.cjs');
const { poll } = require('./run-gate.cjs');
const WF_ID = 'wf_0123456789abcdef';
const NOW = '2026-10-22T19:00:00.000Z';

function sandbox({ run, slots, state, sessions = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'run-gate-'));
  const runDir = path.join(base, 'ws', '.agents', 'tasks', `pipeline-${WF_ID}`);
  fs.mkdirSync(runDir, { recursive: true });
  const home = path.join(base, 'home');
  if (sessions) fs.mkdirSync(path.join(home, '.kiro', 'sessions', 'aaaa1111bbbb2222'), { recursive: true });
  const write = (rel, v) => fs.writeFileSync(path.join(runDir, rel), typeof v === 'string' ? v : JSON.stringify(v));
  if (run !== undefined) write('run.json', run);
  if (slots !== undefined) write('slots.json', slots);
  const box = {
    base, runDir, home, write,
    setState(st) {
      const d = path.join(home, '.kiro', 'sessions', 'aaaa1111bbbb2222', 'workflows', WF_ID);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'workflow-state.json'), typeof st === 'string' ? st : JSON.stringify(st));
    },
    blockers() { const f = path.join(runDir, 'blockers.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; },
    poll(config, cursor = null) { return poll({ cursor, config: { run: `RUN=${runDir}\nslug x`, ...config } }, { home, now: NOW }); },
  };
  if (state !== undefined) box.setState(state);
  return box;
}
const slotCfg = (n, role) => ({ role, gatedNodeId: `lane-slot-${n}`, slot: String(n), gatedStepIds: [`code-${n}`, `review-${n}`, `review-${n}-b`, `review-${n}-c`, `land-${n}`] });
const stepCfg = (id, role) => ({ role, gatedNodeId: id });
const SLOTS_1 = { slug: 'x', slots: { 1: 'lane-a', 2: null, 3: null, 4: null, 5: null, 6: null }, queue: [] };
const RUN_FRESH = { run_id: WF_ID, resumed: false, steps_done: ['setup'], plan_pr: null };

// Engine state fixtures. Layout observed on the installed Kiro engine (kiro.kiro-agent extension, 2026-10-22), from
// redacted real runs: wf_8e7f53a930509020 (review race with an aborted loser; lane-slot-6 failed after all three
// review branches failed) and wf_1cf4b73383bba5df (a step failed inside a repeat iteration). Nodes are
// {nodeId, type, status, iteration?, branchId?, failureReason?, children?}; a repeat's children are its iterations
// `<repeat id>#<i>`. The gate race wrapper (slot-1 / slot-1-skip / slot-1-go) is this lane's new recipe shape.
const rev = (b, seq, step, store) => ({ nodeId: `rev-1${b}`, type: 'sequence', status: seq, iteration: 0, branchId: `rev-1${b}`,
  children: [{ nodeId: `review-1${b}`, type: 'step', status: step, iteration: 0 }, { nodeId: `store-1${b}`, type: 'watch', status: store }] });
function iteration(i, status, kids) { return { nodeId: `lane-slot-1#${i}`, type: 'sequence', status, iteration: i, children: kids }; }
function engine(repeatStatus, iterations, runStatus = 'running') {
  return {
    workflowId: WF_ID, workflowName: 'vitana-pipeline', status: runStatus, parentSessionId: 'sess_x', workspacePath: 'ws',
    root: { nodeId: WF_ID, type: 'sequence', status: 'running', children: [
      { nodeId: 'setup', type: 'step', status: 'completed' },
      { nodeId: 'lanes', type: 'parallel', status: 'running', children: [
        { nodeId: 'slot-1', type: 'parallel', status: 'running', branchId: 'slot-1', children: [
          { nodeId: 'slot-1-skip', type: 'watch', status: 'running', branchId: 'slot-1-skip' },
          { nodeId: 'lane-slot-1', type: 'repeat', status: repeatStatus, branchId: 'lane-slot-1', children: iterations },
        ] },
      ] },
    ] },
  };
}
const go = (i) => ({ nodeId: 'slot-1-go', type: 'watch', status: 'completed', iteration: i });
const FIX = {
  running: engine('running', [iteration(0, 'running', [go(0), { nodeId: 'code-1', type: 'step', status: 'running', iteration: 0 }])]),
  paused: engine('paused', [iteration(0, 'paused', [go(0), { nodeId: 'code-1', type: 'step', status: 'paused', iteration: 0 }])], 'paused'),
  failedAtRepeat: engine('failed', [iteration(0, 'failed', [go(0), { nodeId: 'code-1', type: 'step', status: 'completed', iteration: 0 },
    { nodeId: 'reviews-1', type: 'parallel', status: 'failed', iteration: 0, failureReason: "branch 'rev-1' status=failed",
      children: [rev('', 'failed', 'failed', 'pending'), rev('-b', 'failed', 'failed', 'pending'), rev('-c', 'failed', 'failed', 'pending')] },
    { nodeId: 'land-1', type: 'step', status: 'pending' }])]),
  failedInnerStepInRepeat: engine('running', [iteration(0, 'failed', [go(0),
    { nodeId: 'code-1', type: 'step', status: 'failed', iteration: 0, failureReason: 'Step signaled error via send_message.' }])]),
  failedInnerStepInWrapper: engine('running', [iteration(0, 'running', [go(0), { nodeId: 'code-1', type: 'step', status: 'completed', iteration: 0 },
    { nodeId: 'reviews-1', type: 'parallel', status: 'failed', iteration: 0,
      children: [rev('', 'failed', 'failed', 'pending'), rev('-b', 'failed', 'failed', 'pending'), rev('-c', 'failed', 'failed', 'pending')] },
    { nodeId: 'land-1', type: 'step', status: 'pending' }])]),
  raceBranchFailedOthersRunning: engine('running', [iteration(0, 'running', [go(0), { nodeId: 'code-1', type: 'step', status: 'completed', iteration: 0 },
    { nodeId: 'reviews-1', type: 'parallel', status: 'running', iteration: 0,
      children: [rev('', 'running', 'running', 'pending'), rev('-b', 'running', 'running', 'pending'), rev('-c', 'failed', 'failed', 'pending')] },
    { nodeId: 'land-1', type: 'step', status: 'pending' }])]),
  raceWonLosersAbortedBeforeLand: engine('running', [iteration(0, 'running', [go(0), { nodeId: 'code-1', type: 'step', status: 'completed', iteration: 0 },
    { nodeId: 'reviews-1', type: 'parallel', status: 'completed', iteration: 0,
      children: [rev('', 'completed', 'completed', 'completed'), rev('-b', 'aborted', 'aborted', 'pending'), rev('-c', 'aborted', 'completed', 'aborted')] },
    { nodeId: 'land-1', type: 'step', status: 'pending' }])]),
  laterIteration: engine('running', [
    iteration(0, 'completed', [go(0), { nodeId: 'code-1', type: 'step', status: 'completed', iteration: 0 },
      { nodeId: 'reviews-1', type: 'parallel', status: 'completed', iteration: 0, children: [rev('', 'completed', 'completed', 'completed'), rev('-b', 'aborted', 'aborted', 'pending'), rev('-c', 'failed', 'failed', 'pending')] },
      { nodeId: 'land-1', type: 'step', status: 'completed', iteration: 0 }]),
    iteration(1, 'running', [go(1)])]),
  planningStepFailed: { workflowId: WF_ID, status: 'running', root: { nodeId: WF_ID, type: 'sequence', status: 'running', children: [
    { nodeId: 'spec-gate', type: 'parallel', status: 'running', children: [
      { nodeId: 'spec-skip', type: 'watch', status: 'running', branchId: 'spec-skip' },
      { nodeId: 'spec-work', type: 'sequence', status: 'failed', branchId: 'spec-work', children: [
        { nodeId: 'spec-go', type: 'watch', status: 'completed' }, { nodeId: 'spec', type: 'step', status: 'failed', failureReason: 'x' }] }] }] } },
};

test('empty slot: skip ends the race at its first poll (terminal-state), go stays idle', () => {
  const b = sandbox({ run: RUN_FRESH, slots: SLOTS_1 });
  for (const n of [2, 3, 4, 5, 6]) {
    assert.equal(b.poll(slotCfg(n, 'skip')).outcome, 'terminal-state', `slot ${n}`);
    assert.equal(b.poll(slotCfg(n, 'go')).outcome, 'idle', `slot ${n}`);
  }
  assert.deepEqual(b.blockers(), []);
});

test('filled slot: go fires (new-activity); skip is idle on every poll, also after RUN files change', () => {
  const b = sandbox({ run: RUN_FRESH, slots: SLOTS_1, state: FIX.running });
  assert.equal(b.poll(slotCfg(1, 'go')).outcome, 'new-activity');
  let r = b.poll(slotCfg(1, 'skip'));
  assert.equal(r.outcome, 'idle');
  assert.deepEqual(r.cursor, { decided: 'run' });
  b.write('run.json', { ...RUN_FRESH, steps_done: ['setup', 'investigate', 'spec', 'plan-pr', 'spar-loop', 'merge-plan'], plan_pr: { number: 1 } });
  b.write('slots.json', { ...SLOTS_1, slots: { ...SLOTS_1.slots, 1: null } });
  for (let i = 0; i < 3; i++) { r = b.poll(slotCfg(1, 'skip'), r.cursor); assert.equal(r.outcome, 'idle'); }
});

test('fresh run: no planning or approval step is skipped', () => {
  const b = sandbox({ run: RUN_FRESH });
  for (const id of ['investigate', 'spec', 'plan-pr', 'spar-loop', 'merge-plan']) {
    assert.equal(b.poll(stepCfg(id, 'skip')).outcome, 'idle', id);
    assert.equal(b.poll(stepCfg(id, 'go')).outcome, 'new-activity', id);
  }
});

test('resumed mid-planning (steps_done setup/investigate/spec, plan_pr null, no slots.json): investigate and spec skip, plan-pr runs', () => {
  const b = sandbox({ run: { ...RUN_FRESH, resumed: true, steps_done: ['setup', 'investigate', 'spec'] } });
  for (const id of ['investigate', 'spec']) {
    assert.equal(b.poll(stepCfg(id, 'skip')).outcome, 'terminal-state', id);
    assert.equal(b.poll(stepCfg(id, 'go')).outcome, 'idle', id);
  }
  for (const id of ['plan-pr', 'spar-loop', 'merge-plan']) {
    assert.equal(b.poll(stepCfg(id, 'skip')).outcome, 'idle', id);
    assert.equal(b.poll(stepCfg(id, 'go')).outcome, 'new-activity', id);
  }
});

test('plan-pr done (plan_pr set): all three planning steps skip, spar-loop still runs', () => {
  const b = sandbox({ run: { ...RUN_FRESH, resumed: true, steps_done: ['setup', 'plan-pr'], plan_pr: { number: 4312, url: 'u', head: 'h' } } });
  for (const id of ['investigate', 'spec', 'plan-pr']) assert.equal(b.poll(stepCfg(id, 'skip')).outcome, 'terminal-state', id);
  assert.equal(b.poll(stepCfg('spar-loop', 'skip')).outcome, 'idle');
  assert.equal(b.poll(stepCfg('spar-loop', 'go')).outcome, 'new-activity');
});

test('slots.json present: spar-loop and merge-plan (and planning) skip', () => {
  const b = sandbox({ run: { ...RUN_FRESH, resumed: true }, slots: SLOTS_1 });
  for (const id of ['investigate', 'spec', 'plan-pr', 'spar-loop', 'merge-plan']) {
    assert.equal(b.poll(stepCfg(id, 'skip')).outcome, 'terminal-state', id);
    assert.equal(b.poll(stepCfg(id, 'go')).outcome, 'idle', id);
  }
});

for (const [name, fixture, cfg] of [
  ['failed-at-repeat', FIX.failedAtRepeat, slotCfg(1, 'skip')],
  ['failed-inner-step-in-repeat', FIX.failedInnerStepInRepeat, slotCfg(1, 'skip')],
  ['failed-inner-step-in-wrapper', FIX.failedInnerStepInWrapper, slotCfg(1, 'skip')],
  ['failed planning step', FIX.planningStepFailed, stepCfg('spec', 'skip')],
]) {
  test(`terminal rule: ${name} → terminal-state and exactly one blockers.md line`, () => {
    const b = sandbox({ run: RUN_FRESH, slots: SLOTS_1, state: fixture });
    const r = b.poll(cfg, { decided: 'run' });
    assert.equal(r.outcome, 'terminal-state');
    assert.equal(b.blockers().length, 1);
    assert.match(b.blockers()[0], new RegExp(`^- ${NOW.replace(/[.]/g, '\\.')} run-gate: .*(failed|aborted).*${cfg.gatedNodeId}-skip watch completed the gate race`));
  });
}

for (const [name, fixture] of [
  ['running', FIX.running], ['paused (pinned non-terminal)', FIX.paused],
  ['a race branch failed while the others still run', FIX.raceBranchFailedOthersRunning],
  ['race won, losers aborted, land not started yet', FIX.raceWonLosersAbortedBeforeLand],
  ['an earlier iteration had failed / aborted losers', FIX.laterIteration],
]) {
  test(`not terminal: ${name} → idle, no blockers line`, () => {
    const b = sandbox({ run: RUN_FRESH, slots: SLOTS_1, state: fixture });
    const r = b.poll(slotCfg(1, 'skip'), { decided: 'run' });
    assert.equal(r.outcome, 'idle');
    assert.deepEqual(b.blockers(), []);
  });
}

test('idle-then-detect-failure: run → idle, running → idle, paused → idle, inner step failed → terminal-state', () => {
  const b = sandbox({ run: RUN_FRESH, slots: SLOTS_1 });
  let r = b.poll(slotCfg(1, 'skip'));
  assert.equal(r.outcome, 'idle');
  b.setState(FIX.running);
  r = b.poll(slotCfg(1, 'skip'), r.cursor); assert.equal(r.outcome, 'idle');
  b.setState(FIX.paused);
  r = b.poll(slotCfg(1, 'skip'), r.cursor); assert.equal(r.outcome, 'idle');
  b.setState(FIX.failedInnerStepInRepeat);
  r = b.poll(slotCfg(1, 'skip'), r.cursor); assert.equal(r.outcome, 'terminal-state');
  assert.match(r.payload, /code-1 failed/);
  assert.equal(b.blockers().length, 1);
});

test('missing or malformed data: go runs (fail open), skip stays idle and pins run', () => {
  const cases = [
    sandbox({}), // no run.json, no slots.json
    sandbox({ run: '{ nope', slots: '{ nope' }),
    sandbox({ run: RUN_FRESH, slots: { slug: 'x' } }),
  ];
  for (const b of cases) {
    for (const cfg of [slotCfg(2, 'go'), stepCfg('investigate', 'go')]) assert.equal(b.poll(cfg).outcome, 'new-activity');
    for (const cfg of [slotCfg(2, 'skip'), stepCfg('investigate', 'skip')]) {
      const r = b.poll(cfg);
      assert.equal(r.outcome, 'idle');
      assert.deepEqual(r.cursor, { decided: 'run' });
    }
  }
  const gone = poll({ cursor: null, config: { run: 'RUN=/nowhere/.agents/tasks/pipeline-wf_x', ...slotCfg(1, 'go') } }, { home: os.tmpdir() });
  assert.equal(gone.outcome, 'new-activity');
  assert.equal(poll({ cursor: null, config: { run: '', ...stepCfg('spec', 'skip') } }).outcome, 'idle');
  // Engine state missing (no .kiro/sessions at all), or unparseable → idle.
  const noSessions = sandbox({ run: RUN_FRESH, slots: SLOTS_1, sessions: false });
  assert.equal(noSessions.poll(slotCfg(1, 'skip'), { decided: 'run' }).outcome, 'idle');
  const bad = sandbox({ run: RUN_FRESH, slots: SLOTS_1, state: '{ nope' });
  assert.equal(bad.poll(slotCfg(1, 'skip'), { decided: 'run' }).outcome, 'idle');
  assert.equal(poll({ cursor: null, config: { role: 'other', gatedNodeId: 'spec' } }).outcome, 'idle');
});

test('writes nothing outside RUN/blockers.md', () => {
  const list = (d) => { const out = []; const w = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); out.push(f + (e.isDirectory() ? '/' : `:${fs.statSync(f).size}`)); if (e.isDirectory()) w(f); } }; w(d); return out.sort(); };
  const b = sandbox({ run: RUN_FRESH, slots: SLOTS_1, state: FIX.failedAtRepeat });
  const before = list(b.base);
  for (const cfg of [slotCfg(1, 'go'), slotCfg(1, 'skip'), slotCfg(2, 'skip'), slotCfg(2, 'go'), stepCfg('spec', 'skip'), stepCfg('spec', 'go')]) b.poll(cfg);
  b.poll(slotCfg(1, 'skip'), { decided: 'run' });
  const after = list(b.base);
  const blockers = path.join(b.runDir, 'blockers.md');
  assert.deepEqual(after.filter((f) => !f.startsWith(blockers)), before);
  assert.ok(after.some((f) => f.startsWith(blockers)));
});

test('CLI: one JSON result line on stdout, exit 0, also for bad stdin; engine state found under the home dir', () => {
  const b = sandbox({ run: RUN_FRESH, slots: SLOTS_1, state: FIX.failedAtRepeat });
  const env = { ...process.env, HOME: b.home, USERPROFILE: b.home };
  const run = (input) => spawnSync(process.execPath, [SCRIPT], { input, env, encoding: 'utf8' });
  const ok = run(JSON.stringify({ cursor: { decided: 'run' }, config: { run: `RUN=${b.runDir}`, ...slotCfg(1, 'skip') }, workspacePath: b.base }));
  assert.equal(ok.status, 0);
  const lines = ok.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).outcome, 'terminal-state');
  assert.ok('cursor' in JSON.parse(lines[0]));
  const badIn = run('{ not json');
  assert.equal(badIn.status, 0);
  assert.equal(JSON.parse(badIn.stdout).outcome, 'idle');
  assert.ok('cursor' in JSON.parse(badIn.stdout));
});

// Simulated walk of the shipped recipe: a repeat always runs iteration 0 before stopWhen; a gate race resolves on the
// first poll of its two watches (skip terminal → the work branch never starts; go not new-activity → blocked).
function agentSteps(wf, b) {
  const cfgOf = (w) => ({ ...w.config, run: `RUN=${b.runDir}` });
  const isGate = (n) => n && n.type === 'watch' && n.config && n.config.command === 'node scripts/collab/run-gate.cjs';
  const seq = (kids) => {
    let count = 0;
    for (const k of kids) {
      if (isGate(k)) { if (poll({ cursor: null, config: cfgOf(k) }, { home: b.home }).outcome !== 'new-activity') return count; continue; }
      count += walkNode(k);
    }
    return count;
  };
  function walkNode(n) {
    switch (n.type) {
      case 'step': return 1;
      case 'watch': return 0;
      case 'sequence': case 'repeat': return seq(n.steps);
      case 'parallel': {
        const skip = n.branches.find((x) => isGate(x) && x.config.role === 'skip');
        if (skip && poll({ cursor: null, config: cfgOf(skip) }, { home: b.home }).outcome === 'terminal-state') return 0;
        return n.branches.reduce((s, x) => s + walkNode(x), 0);
      }
      default: throw new Error(`unknown node ${n.type}`);
    }
  }
  const per = {};
  for (const s of wf.steps) per[s.id] = walkNode(s);
  return per;
}
const RECIPE = JSON.parse(fs.readFileSync(path.join(ROOT, '.kiro', 'workflows', 'vitana-pipeline.workflow.json'), 'utf8'));

test('simulated walk: an empty slot and a resumed plan\'s planning + approval cost 0 agent steps; a filled slot is unchanged', () => {
  const resumed = sandbox({ run: { ...RUN_FRESH, resumed: true, steps_done: ['setup', 'investigate', 'spec', 'plan-pr', 'spar-loop', 'merge-plan'], plan_pr: { number: 1 } }, slots: SLOTS_1 });
  const per = agentSteps(RECIPE, resumed);
  for (const id of ['investigate-gate', 'spec-gate', 'plan-pr-gate', 'spar-loop-gate', 'merge-plan-gate']) assert.equal(per[id], 0, id);
  assert.equal(per.lanes, 5, 'slot 1 = code + 3 racing reviews + land; slots 2-6 empty = 0');
  assert.equal(per.setup + per['staging-verify'] + per.gate2, 3);
  const fresh = sandbox({ run: RUN_FRESH });
  const perFresh = agentSteps(RECIPE, fresh);
  assert.deepEqual([perFresh['investigate-gate'], perFresh['spec-gate'], perFresh['plan-pr-gate'], perFresh['spar-loop-gate'], perFresh['merge-plan-gate']], [3, 1, 1, 1, 1]);
  const full = sandbox({ run: RUN_FRESH, slots: { slug: 'x', slots: { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e', 6: 'f' }, queue: [] } });
  assert.equal(agentSteps(RECIPE, full).lanes, 30, 'six filled slots run exactly as before: 6 x 5');
});
