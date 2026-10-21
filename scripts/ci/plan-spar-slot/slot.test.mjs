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
  // 6 original steps + the VTID-05272 slot step + the VTID-05306 needs-rebase producer step = 8.
  assert.equal((y.match(/- name: /g) || []).length, 8, 'slot step + needs-rebase step added (6 → 8)');
});

// lane plan-spar-checks (VTID-05306) — producer-only needs-rebase proof. Asserts ONLY the producer
// contract: the statuses: write permission, and that the empty-PLAN_SPAR_PUSH_TOKEN path posts a
// plan-spar/needs-rebase commit status on the bot head. No consumer behaviour is asserted.
test('PLAN-SPAR.yml: producer needs-rebase status on the GITHUB_TOKEN bot-head push (VTID-05306)', () => {
  const y = readFileSync(path.join(ROOT, '.github/workflows/PLAN-SPAR.yml'), 'utf8');
  // R3-F1: the explicit permissions block must grant statuses: write, else the POST 403s.
  assert.match(y, /^permissions:\r?\n(?:[^\n]*\n)*?\s+statuses: write/m, 'permissions block grants statuses: write');
  // The producer step exists, after "Commit the round" (the push), guarded by the empty-secret path.
  const commitAt = y.indexOf('- name: Commit the round');
  const stepAt = y.indexOf('- name: Signal needs-rebase on the bot head');
  assert.ok(commitAt > 0 && stepAt > commitAt, 'the status step comes after the round-commit push');
  const commentAt = y.indexOf('- name: Comment', stepAt);
  const step = y.slice(stepAt, commentAt > stepAt ? commentAt : undefined);
  assert.match(step, /if: steps\.guard\.outputs\.skip != 'true' && secrets\.PLAN_SPAR_PUSH_TOKEN == ''/,
    'skipped on our own commit and when the PAT secret is present');
  assert.match(step, /git -C head rev-parse HEAD/, 'reads the pushed bot head SHA');
  assert.match(step, /gh api -X POST "repos\/\$\{\{ github\.repository \}\}\/statuses\/\$\{sha\}"/,
    'posts via the statuses API on the bot head');
  assert.match(step, /context='plan-spar\/needs-rebase'/, 'the status context is plan-spar/needs-rebase');
  // Exactly one producer mechanism: the commit status, never re-run / re-dispatch / the Checks API.
  assert.doesNotMatch(step, /workflow run|\/dispatches|\/rerun|check-runs|checks:/,
    'no re-dispatch, re-run or Checks API');
  // Producer-only: the status step itself must not invoke the deferred consumer (the branch update).
  assert.doesNotMatch(step, /gh pr update-branch/, 'the consumer (gh pr update-branch) is deferred, not run here');
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
