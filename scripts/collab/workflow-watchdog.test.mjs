// VTID-05337 — tests for scripts/collab/workflow-watchdog.mjs (plan pipeline-speed, lane restart-watchdog, D7).
// Run: node --test scripts/collab/workflow-watchdog.test.mjs
// Fixtures live in temp dirs only (a temp home via VITANA_WATCHDOG_HOME and a temp workspace); never the real ~/.kiro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(HERE, 'workflow-watchdog.mjs');
const ME = 'sess_11111111-1111-4111-8111-111111111111';
const OTHER = 'sess_22222222-2222-4222-8222-222222222222';
const RESTART = 'Interrupted by agent restart; the previously running step was paused for resume.';
const NOW = Date.parse('2026-10-22T18:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-watchdog-'));
  const home = path.join(dir, 'home');
  const ws = path.join(dir, 'workspace');
  const otherWs = path.join(dir, 'other-workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  mkdirSync(otherWs, { recursive: true });
  return { dir, home, ws, otherWs, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One engine run folder: <home>/.kiro/sessions/<hash>/workflows/<id>/workflow-state.json (+ run.beat). */
function run(f, { hash = 'h1', id, status, workspacePath = f.ws, parent = ME, pauseReason, stopInitiator, beatMin, name = 'vitana-pipeline', raw }) {
  const d = path.join(f.home, '.kiro', 'sessions', hash, 'workflows', id);
  mkdirSync(d, { recursive: true });
  if (raw !== undefined) { writeFileSync(path.join(d, 'workflow-state.json'), raw); return; }
  const state = { workflowId: id, workflowName: name, status, workspacePath, parentSessionId: parent, createdAt: ago(120),
    inputs: {}, artifacts: {}, capturedOutputs: {}, root: { id: 'main', status } };
  if (pauseReason) state.pauseReason = pauseReason;
  if (stopInitiator) state.stopInitiator = stopInitiator;
  writeFileSync(path.join(d, 'workflow-state.json'), JSON.stringify(state));
  if (beatMin !== undefined) writeFileSync(path.join(d, 'run.beat'), JSON.stringify({ pid: 1, instanceId: 'x', stampedAt: ago(beatMin) }));
}

function exec(f, { event = 'SessionStart', session = ME, cwd = f.ws, stdin } = {}) {
  const input = stdin !== undefined ? stdin : JSON.stringify({ session_id: session, hook_event_name: event, cwd });
  const r = spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', cwd: f.ws,
    env: { ...process.env, VITANA_WATCHDOG_HOME: f.home, VITANA_WATCHDOG_NOW: new Date(NOW).toISOString() } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function listing(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d)) { const p = path.join(d, e); const s = statSync(p);
    out.push(`${path.relative(dir, p)}|${s.isDirectory() ? 'd' : s.size}|${s.mtimeMs}`); if (s.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
}

function mixed(f) {
  run(f, { id: 'wf_own_restart', status: 'paused', pauseReason: RESTART, beatMin: 300 });
  run(f, { id: 'wf_other_restart', status: 'paused', pauseReason: RESTART, parent: OTHER, hash: 'h2' });
  run(f, { id: 'wf_own_user', status: 'paused', pauseReason: 'Paused by user.', stopInitiator: 'user' });
  run(f, { id: 'wf_stale', status: 'running', beatMin: 45, parent: OTHER });
  run(f, { id: 'wf_fresh', status: 'running', beatMin: 2 });
  run(f, { id: 'wf_done', status: 'completed', beatMin: 600 });
  run(f, { id: 'wf_failed', status: 'failed' });
  run(f, { id: 'wf_aborted', status: 'aborted' });
  run(f, { id: 'wf_elsewhere', status: 'paused', pauseReason: RESTART, workspacePath: f.otherWs });
  run(f, { id: 'wf_elsewhere_stale', status: 'running', beatMin: 90, workspacePath: f.otherWs });
}

test('SessionStart: only this workspace\'s paused and stale-running runs are reported', () => {
  const f = fixture();
  try {
    mixed(f);
    const r = exec(f);
    assert.equal(r.code, 0);
    for (const id of ['wf_own_restart', 'wf_other_restart', 'wf_own_user', 'wf_stale']) assert.match(r.out, new RegExp(id));
    for (const id of ['wf_fresh', 'wf_done', 'wf_failed', 'wf_aborted', 'wf_elsewhere', 'wf_elsewhere_stale']) assert.doesNotMatch(r.out, new RegExp(`${id}\\b`));
    assert.match(r.out, /WORKFLOW WATCHDOG/);
  } finally { f.done(); }
});

test('restart pause vs user pause: user pauses are listed, never resumed', () => {
  const f = fixture();
  try {
    mixed(f);
    const lines = exec(f).out.split(/\r?\n/);
    const user = lines.findIndex((l) => l.includes('wf_own_user'));
    assert.ok(user >= 0);
    const block = lines.slice(user, user + 2).join('\n');
    assert.match(block, /paused by user — not resumed/);
    assert.doesNotMatch(block, /update_workflow/);
    const restart = lines.findIndex((l) => l.includes('wf_own_restart'));
    assert.match(lines.slice(restart, restart + 2).join('\n'), /agent restart/);
  } finally { f.done(); }
});

test('own run vs other session\'s run get different instructions', () => {
  const f = fixture();
  try {
    mixed(f);
    const lines = exec(f).out.split(/\r?\n/);
    const own = lines.findIndex((l) => l.includes('wf_own_restart'));
    const ownBlock = lines.slice(own, own + 2).join('\n');
    assert.match(ownBlock, /inspect_workflow wf_own_restart/);
    assert.match(ownBlock, /update_workflow update_status running/);
    const other = lines.findIndex((l) => l.includes('wf_other_restart'));
    const otherBlock = lines.slice(other, other + 2).join('\n');
    assert.match(otherBlock, new RegExp(OTHER));
    assert.match(otherBlock, /open that session|Resume/);
    assert.doesNotMatch(otherBlock, /update_workflow/);
    const stale = lines.findIndex((l) => l.includes('wf_stale'));
    assert.match(lines.slice(stale, stale + 2).join('\n'), /heartbeat/);
  } finally { f.done(); }
});

test('UserPromptSubmit reports only the session\'s own runs', () => {
  const f = fixture();
  try {
    mixed(f);
    const r = exec(f, { event: 'UserPromptSubmit' });
    assert.equal(r.code, 0);
    assert.match(r.out, /wf_own_restart/);
    assert.doesNotMatch(r.out, /wf_other_restart|wf_stale\b/);
    const none = exec(f, { event: 'UserPromptSubmit', session: 'sess_nobody' });
    assert.equal(none.code, 0);
    assert.equal(none.out, '');
  } finally { f.done(); }
});

test('workspace match is case-insensitive with normalised separators on win32', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    run(f, { id: 'wf_case', status: 'paused', pauseReason: RESTART, workspacePath: f.ws.toUpperCase().replace(/\\/g, '/') + '/' });
    assert.match(exec(f).out, /wf_case/);
  } finally { f.done(); }
});

test('missing sessions dir: falls back to run ids from .agents/tasks/pipeline-*/run.json, exit 0', () => {
  const f = fixture();
  try {
    const rd = path.join(f.ws, '.agents', 'tasks', 'pipeline-wf_fallback1');
    mkdirSync(rd, { recursive: true });
    writeFileSync(path.join(rd, 'run.json'), JSON.stringify({ run_id: 'wf_fallback1', slug: 's' }));
    mkdirSync(path.join(f.ws, '.agents', 'tasks', 'pipeline-broken'), { recursive: true });
    writeFileSync(path.join(f.ws, '.agents', 'tasks', 'pipeline-broken', 'run.json'), '{not json');
    const r = exec(f);
    assert.equal(r.code, 0);
    assert.match(r.out, /wf_fallback1/);
    assert.match(r.out, /inspect_workflow wf_fallback1/);
    // UserPromptSubmit cannot tell whose run a bare run id is: silent.
    assert.equal(exec(f, { event: 'UserPromptSubmit' }).out, '');
  } finally { f.done(); }
});

test('run.json is only a fallback: with engine state present it adds nothing', () => {
  const f = fixture();
  try {
    run(f, { id: 'wf_known', status: 'completed' });
    for (const id of ['wf_known', 'wf_cleaned_up']) {
      const rd = path.join(f.ws, '.agents', 'tasks', `pipeline-${id}`);
      mkdirSync(rd, { recursive: true });
      writeFileSync(path.join(rd, 'run.json'), JSON.stringify({ run_id: id }));
    }
    assert.equal(exec(f).out, '', 'engine state wins; local RUN folders are not re-reported');
  } finally { f.done(); }
});

test('malformed JSON is skipped, the rest is still reported', () => {
  const f = fixture();
  try {
    run(f, { id: 'wf_bad', raw: '{"status": "paused",' });
    run(f, { id: 'wf_good', status: 'paused', pauseReason: RESTART });
    const d = path.join(f.home, '.kiro', 'sessions', 'h1', 'workflows', 'wf_badbeat');
    run(f, { id: 'wf_badbeat', status: 'running' });
    writeFileSync(path.join(d, 'run.beat'), 'garbage');
    const r = exec(f);
    assert.equal(r.code, 0);
    assert.match(r.out, /wf_good/);
    assert.doesNotMatch(r.out, /wf_bad\b/);
  } finally { f.done(); }
});

test('nothing found → empty stdout, exit 0; bad stdin → exit 0', () => {
  const f = fixture();
  try {
    run(f, { id: 'wf_done', status: 'completed' });
    run(f, { id: 'wf_fresh', status: 'running', beatMin: 1 });
    const r = exec(f);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    const bad = exec(f, { stdin: 'not json' });
    assert.equal(bad.code, 0);
  } finally { f.done(); }
});

test('read-only: no file is written in home or workspace', () => {
  const f = fixture();
  try {
    mixed(f);
    const before = listing(f.dir);
    exec(f);
    exec(f, { event: 'UserPromptSubmit' });
    assert.deepEqual(listing(f.dir), before);
  } finally { f.done(); }
});

test('hook file: v1, SessionStart + UserPromptSubmit command hooks running the watchdog', () => {
  const h = JSON.parse(readFileSync(path.join(ROOT, '.kiro', 'hooks', 'vitana-workflow-watchdog.json'), 'utf8'));
  assert.equal(h.version, 'v1');
  assert.ok(Array.isArray(h.hooks));
  assert.deepEqual(h.hooks.map((x) => x.trigger).sort(), ['SessionStart', 'UserPromptSubmit']);
  for (const x of h.hooks) {
    assert.equal(typeof x.name, 'string');
    assert.deepEqual(x.action, { type: 'command', command: 'node scripts/collab/workflow-watchdog.mjs' });
  }
});

test('vitana-pipeline-start.json hooks[0] is unchanged', () => {
  const h = JSON.parse(readFileSync(path.join(ROOT, '.kiro', 'hooks', 'vitana-pipeline-start.json'), 'utf8'));
  assert.equal(h.version, 'v1');
  assert.equal(h.hooks.length, 1);
  assert.deepEqual(h.hooks[0], {
    name: 'vitana-pipeline-start',
    description: 'VTID-05275: every Kiro IDE session starts on the Vitana pipeline.',
    trigger: 'SessionStart',
    action: {
      type: 'agent',
      prompt: 'Load .kiro/steering/vitana-pipeline.md; run the queue (node scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1>); resume any plan driver whose heartbeat (refs/heads/collab-driver/<slug>) is older than 45 minutes. Every owner task that results in a commit runs the pipeline end to end (.kiro/workflows/vitana-pipeline.workflow.json); the only owner stop is Gate 2 (plus an escalated sparring verdict).',
    },
  });
});
