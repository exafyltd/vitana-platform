'use strict';
// Reviewer output store (scripts/collab/store-review.cjs). Run: node --test scripts/collab/store-review.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { store, runDirFrom } = require('./store-review.cjs');

const SCRIPT = path.join(__dirname, 'store-review.cjs');
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
function runDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'store-review-'));
  const run = path.join(d, '.agents', 'tasks', 'pipeline-wf_0123abcd');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'slots.json'), JSON.stringify({ slots: { 1: 'lane-a' }, queue: [] }));
  return run;
}
function review(model, head = HEAD) {
  return [
    JSON.stringify({ verdict: 'accept', head_sha: head, findings: [], model, agent: 'vitana-lane-reviewer' }),
    '',
    '### 2026-10-22T00:00:00Z · <reviewer session> · review',
    'review: accept',
    `Collab-Review: my-plan/lane-b`,
    `Collab-Reviewer: agent:vitana-lane-reviewer (${model})`,
  ].join('\n');
}
function cfg(run, model, output) { return { config: { run: `RUN=${run}\nslug: my-plan`, model, slot: '1', output } }; }

test('stores the verdict output under RUN/reviews/<lane>-<head7>.out-<model>.md', () => {
  const run = runDir();
  const note = store(cfg(run, 'claude-opus-5.5', review('claude-opus-5.5')));
  const file = path.join(run, 'reviews', 'lane-b-abcdef0.out-claude-opus-5.5.md');
  assert.match(note, /^stored /);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), review('claude-opus-5.5') + '\n');
});
test('never overwrites an existing output file', () => {
  const run = runDir();
  store(cfg(run, 'claude-sonnet-5.5', review('claude-sonnet-5.5')));
  const note = store(cfg(run, 'claude-sonnet-5.5', review('claude-sonnet-5.5').replace('accept', 'changes')));
  assert.match(note, /^kept existing /);
  assert.match(fs.readFileSync(path.join(run, 'reviews', 'lane-b-abcdef0.out-claude-sonnet-5.5.md'), 'utf8'), /"verdict":"accept"/);
});
test('falls back to RUN/slots.json for the lane id', () => {
  const run = runDir();
  const out = review('claude-sonnet-4.5').split('\n').filter((l) => !l.startsWith('Collab-Review:')).join('\n');
  assert.match(store(cfg(run, 'claude-sonnet-4.5', out)), /lane-a-abcdef0\.out-claude-sonnet-4\.5\.md/);
});
test('writes nothing for a no-review answer, a model_unavailable line, a bad head or a non-Claude model', () => {
  const run = runDir();
  assert.match(store(cfg(run, 'claude-sonnet-5.5', 'no review needed (accepted)')), /^not stored: no verdict/);
  assert.match(store(cfg(run, 'claude-sonnet-5.5', '{"error":"model_unavailable","agent":"vitana-lane-reviewer"}')), /^not stored: no verdict/);
  assert.match(store(cfg(run, 'claude-sonnet-5.5', review('claude-sonnet-5.5', 'abc'))), /head_sha/);
  assert.match(store(cfg(run, 'gemini-2.5-pro', review('gemini-2.5-pro'))), /not a Claude model id/);
  assert.strictEqual(fs.existsSync(path.join(run, 'reviews')), false);
});
test('a missing RUN folder is reported, not thrown', () => {
  assert.match(store(cfg(path.join(os.tmpdir(), 'nope', '.agents', 'tasks', 'pipeline-wf_x'), 'claude-sonnet-5.5', review('claude-sonnet-5.5'))), /RUN folder not found/);
});
test('reads RUN from a RUN= line or from a pipeline path in prose', () => {
  assert.strictEqual(runDirFrom('RUN=C:/x/.agents/tasks/pipeline-wf_1/\nslug'), 'C:/x/.agents/tasks/pipeline-wf_1');
  assert.strictEqual(runDirFrom('RUN path: C:\\x\\.agents\\tasks\\pipeline-wf_2, slug s'), 'C:\\x\\.agents\\tasks\\pipeline-wf_2');
  assert.strictEqual(runDirFrom('no path here'), null);
});
test('as the watch command: always one terminal-state result on stdout, exit 0, also on bad input', () => {
  const run = runDir();
  for (const stdin of [JSON.stringify({ cursor: null, ...cfg(run, 'claude-opus-5.5', review('claude-opus-5.5')), workspacePath: run }), '{ nope', '']) {
    const r = spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout.trim());
    assert.strictEqual(res.outcome, 'terminal-state');
    assert.strictEqual(res.cursor, null);
    assert.strictEqual(typeof res.payload, 'string');
  }
  assert.ok(fs.existsSync(path.join(run, 'reviews', 'lane-b-abcdef0.out-claude-opus-5.5.md')));
});
