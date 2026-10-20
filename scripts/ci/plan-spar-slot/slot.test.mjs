// VTID-05272 — tests for slot.mjs and the PLAN-SPAR.yml slot step.
// Run: node --test scripts/ci/plan-spar-slot/*.test.mjs (CI-SCRIPTS-TEST.yml)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mayStart, runPhase, SLOT_STEP, SPAR_STEP } from './slot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ME = 500;

test('mayStart: 0 or 1 older run ahead → start; 2 older → wait', () => {
  assert.equal(mayStart(ME, []).start, true);
  assert.equal(mayStart(ME, [{ id: 400, phase: 'sparring' }]).start, true);
  assert.equal(mayStart(ME, [{ id: 400, phase: 'waiting' }]).start, true);
  const two = mayStart(ME, [{ id: 400, phase: 'sparring' }, { id: 450, phase: 'waiting' }]);
  assert.equal(two.start, false);
  assert.deepEqual(two.ahead, [400, 450]);
  assert.equal(mayStart(ME, [{ id: 400, phase: 'sparring' }, { id: 450, phase: 'waiting' }], 3).start, true, 'cap is a parameter');
});
test('mayStart: younger waiting runs are ignored (FIFO); a run that is sparring holds a slot whatever its age', () => {
  assert.equal(mayStart(ME, [{ id: 600, phase: 'waiting' }, { id: 700, phase: 'waiting' }]).start, true);
  assert.equal(mayStart(ME, [{ id: 600, phase: 'sparring' }, { id: 400, phase: 'waiting' }]).start, false);
  assert.equal(mayStart(ME, [{ id: ME, phase: 'waiting' }, { id: 400, phase: 'sparring' }]).start, true, 'this run itself is not counted');
});
test('mayStart: a skipped run (own commit) or one not yet at the slot step holds no slot', () => {
  const skipped = runPhase([{ steps: [{ name: 'Skip our own commit', status: 'completed', conclusion: 'success' }, { name: SLOT_STEP, status: 'completed', conclusion: 'skipped' }, { name: SPAR_STEP, status: 'queued', conclusion: null }] }]);
  assert.equal(skipped, 'idle');
  const early = runPhase([{ steps: [{ name: 'Base checkout (trusted code)', status: 'in_progress', conclusion: null }, { name: SLOT_STEP, status: 'queued', conclusion: null }] }]);
  assert.equal(early, 'idle');
  assert.equal(mayStart(ME, [{ id: 400, phase: skipped }, { id: 450, phase: early }]).start, true);
  assert.equal(runPhase([{ steps: [{ name: SLOT_STEP, status: 'in_progress' }] }]), 'waiting');
  assert.equal(runPhase([{ steps: [{ name: SLOT_STEP, status: 'completed', conclusion: 'success' }, { name: SPAR_STEP, status: 'in_progress' }] }]), 'sparring');
  assert.equal(runPhase([]), 'idle');
});
test('PLAN-SPAR.yml: slot step before Spar with cap 2; paths, concurrency and the Spar call unchanged', () => {
  const y = readFileSync(path.join(ROOT, '.github/workflows/PLAN-SPAR.yml'), 'utf8');
  const slotAt = y.indexOf(`- name: ${SLOT_STEP}`);
  const sparAt = y.indexOf(`- name: ${SPAR_STEP}\n`);
  assert.ok(slotAt > 0 && sparAt > slotAt, 'the slot step comes right before Spar');
  const slot = y.slice(slotAt, sparAt);
  assert.match(slot, /if: steps\.guard\.outputs\.skip != 'true'/);
  assert.match(slot, /node base\/scripts\/ci\/plan-spar-slot\/slot\.mjs .*--cap 2/s);
  assert.match(y, /paths:\n\s+- '\.kiro\/specs\/\*\/plan\.md'\n\s+- '\.kiro\/specs\/\*\/sparring\/\*responses-\*\.md'\n/);
  assert.match(y, /group: plan-spar-\$\{\{ github\.event\.pull_request\.number \}\}\n\s+cancel-in-progress: false/);
  assert.match(y, /actions: read/);
  assert.match(y, /node base\/scripts\/collab\/plan-spar\.mjs --dir head --base-sha "\$BASE_SHA"/);
  assert.equal((y.match(/- name: /g) || []).length, 7, 'exactly one step added (6 → 7)');
});
test('PLAN-SPAR.yml differs from main only by the slot step and the actions: read permission', { skip: !hasOriginMain() }, () => {
  const base = execFileSync('git', ['-C', ROOT, 'show', 'origin/main:.github/workflows/PLAN-SPAR.yml'], { encoding: 'utf8' });
  if (base.includes(`- name: ${SLOT_STEP}`)) return; // already on main: nothing to compare
  const y = readFileSync(path.join(ROOT, '.github/workflows/PLAN-SPAR.yml'), 'utf8');
  const stripped = y
    .replace(/  actions: read # VTID-05272[^\n]*\n/, '')
    .replace(/      # VTID-05272 \(plan kiro-autonomy-fallback §7 rule 2\)[\s\S]*?(?=      - name: Spar\n)/, '');
  assert.equal(stripped, base);
});
function hasOriginMain() {
  try { execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', '-q', 'origin/main'], { stdio: 'ignore' }); return true; } catch { return false; }
}
