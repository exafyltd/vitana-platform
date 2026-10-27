// VTID-05353 (plan pm-ci-load, lane pr-ci-concurrency): superseded PR runs of `unit` and the Phase 2B doc gate cancel.
// Run: node --test scripts/ci/workflow-concurrency/concurrency.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (f) => readFileSync(path.join(root, '.github/workflows', f), 'utf8');
// The PR-GATE.yml pattern exactly (PR-GATE.yml:22-24): one group per PR number, no github.ref fallback.
const WORKFLOWS = [
  { file: 'UNIT.yml', group: 'unit-${{ github.event.pull_request.number }}' },
  { file: 'PHASE-2B-DOC-GATE.yml', group: 'phase-2b-doc-gate-${{ github.event.pull_request.number }}' },
];

for (const { file, group } of WORKFLOWS) {
  test(`${file}: superseded runs of the same PR cancel (top-level concurrency, PR-number group)`, () => {
    const y = read(file);
    const m = /^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m.exec(y);
    assert.ok(m, `${file} needs a top-level concurrency block`);
    assert.equal(m[1].trim(), group);
    assert.equal(m[2].trim(), 'true');
    assert.ok(!/github\.ref/.test(m[1]), 'no github.ref fallback');
  });

  test(`${file}: no trigger-level path filter and only pull_request triggers (a required check never stays pending)`, () => {
    const y = read(file);
    const on = /^on:([\s\S]*?)^(?=\S)/m.exec(y)?.[1] ?? '';
    assert.ok(!/paths(-ignore)?:/.test(on), `${file} must not filter paths at the trigger`);
    assert.ok(/pull_request/.test(on), `${file} still runs on pull_request`);
    assert.ok(!/\bpush\b/.test(on), `${file} has no push trigger (the PR-number group would be empty)`);
  });
}

test('PR-GATE.yml still uses the same pattern (reference)', () => {
  assert.match(read('PR-GATE.yml'), /^concurrency:\n {2}group: pr-gate-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true$/m);
});
