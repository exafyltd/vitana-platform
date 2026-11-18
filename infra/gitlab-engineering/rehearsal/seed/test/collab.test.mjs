// The collab tooling copied from main of the platform checkout (tools/collab/, see manifest.json) must work on its own in a job container.
import test from 'node:test';
import assert from 'node:assert/strict';

test('the copied land-guard finds the lane of a merge request title', async () => {
  const guard = await import('../tools/collab/land-guard.mjs');
  assert.equal(guard.laneKeyOf('VTID-05540 (rehearsal/lane-01): rehearsal lane 1 of 12'), 'rehearsal/lane-01');
  assert.equal(typeof guard.reviewCurrent, 'function');
  assert.equal(typeof guard.mergeDecision, 'function');
});

test('the copied queue lists protected gate files, and CLAUDE.md is one of them', async () => {
  const queue = await import('../tools/collab/queue.mjs');
  assert.ok(Array.isArray(queue.PROTECTED_GATE_PATHS) && queue.PROTECTED_GATE_PATHS.length > 0);
  assert.ok(queue.PROTECTED_GATE_PATHS.includes('CLAUDE.md'));
});
