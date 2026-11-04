// VTID-05513: superseded PR runs are cancelled per PR; pushes to main and schedules never are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const wfDir = join(root, '.github', 'workflows');
const BLOCK = [
  'concurrency:',
  '  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
  "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
].join('\n');
const EXISTING = ['UNIT.yml', 'TEST-SUITE.yml', 'PHASE-2B-DOC-GATE.yml', 'CALENDAR-REGRESSION.yml'];
const PROTECTED = ['PR-GATE.yml', 'PLAN-SPAR.yml'];
const read = (name) => readFileSync(join(wfDir, name), 'utf8');
const laneFiles = () => readFileSync(join(root, '.kiro/specs/ci-superseded-pr-runs/lanes/platform-superseded-concurrency.md'), 'utf8')
  .split('\n').filter((l) => l.startsWith('  - .github/workflows/')).map((l) => l.slice(4).split('/').pop());

test('the 38 lane workflows carry the per-PR superseded-run concurrency block exactly once', () => {
  const files = laneFiles();
  assert.equal(files.length, 38, 'lane declares 38 workflows');
  for (const name of files) {
    const text = read(name);
    assert.equal(text.split(BLOCK).length - 1, 1, `${name} has the block once`);
    assert.equal(text.split('\nconcurrency:').length - 1, 1, `${name} has one concurrency key`);
  }
});

test('protected gate files and production workflows are not changed', () => {
  for (const name of PROTECTED) assert.ok(!read(name).includes(BLOCK), `${name} untouched`);
  for (const name of readdirSync(wfDir).filter((n) => n.startsWith('AWS-PROD-'))) {
    assert.ok(!read(name).includes(BLOCK), `${name} untouched`);
  }
});

test('workflows that already had a concurrency block keep their own group', () => {
  for (const name of EXISTING) {
    assert.ok(!read(name).includes(BLOCK), `${name} keeps its existing concurrency`);
  }
});
