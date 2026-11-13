// VTID-05672: runner-level tests for dedupe, reuse and failure propagation.
// Real temp git repos and real child processes; no staging calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runExisting, runSuite } from './run.mjs';

// A counter script outside the repo: each run appends one line, so the test sees real invocations.
function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `sv-${name}-`));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const counter = join(root, 'count.txt');
  writeFileSync(join(repo, 'count.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(counter)}, process.argv[2] + '\\n');\nprocess.exit(process.argv[3] === 'fail' ? 1 : 0);\n`);
  writeFileSync(join(repo, 'README.md'), name + '\n');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-qm', 'fixture');
  const runs = () => (existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { repo, runs };
}

test('a shared command runs once; later suites reuse it with reused_from', async () => {
  const { repo, runs } = fixture('dedupe');
  const t = { kind: 'existing', ref: 'node count.mjs shared ok', cwd: '.' };
  const first = await runExisting(repo, t, 'VTID-A');
  const second = await runExisting(repo, t, 'VTID-B');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reused_from, 'VTID-A');
  assert.equal(first.reused_from, undefined);
  assert.deepEqual(runs(), ['shared']);
});

test('a different argv is a different key and runs again', async () => {
  const { repo, runs } = fixture('keys');
  await runExisting(repo, { kind: 'existing', ref: 'node count.mjs one ok', cwd: '.' }, 'VTID-A');
  await runExisting(repo, { kind: 'existing', ref: 'node count.mjs two ok', cwd: '.' }, 'VTID-B');
  assert.deepEqual(runs(), ['one', 'two']);
});

test('a failed shared command fails every dependent row, without running again', async () => {
  const { repo, runs } = fixture('failure');
  const t = { kind: 'existing', ref: 'node count.mjs broken fail', cwd: '.' };
  const first = await runExisting(repo, t, 'VTID-A');
  const second = await runExisting(repo, t, 'VTID-B');
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(second.reused_from, 'VTID-A');
  assert.deepEqual(runs(), ['broken']);
});

test('runSuite keeps manifest order and records reused_from on the row', async () => {
  const { repo } = fixture('rows');
  const outDir = mkdtempSync(join(tmpdir(), 'sv-out-'));
  const tests = [
    { kind: 'existing', name: 'first', ref: 'node count.mjs rows ok', cwd: '.' },
    { kind: 'existing', name: 'second', ref: 'node count.mjs rows2 ok', cwd: '.' },
    { kind: 'existing', name: 'third', ref: 'node count.mjs rows ok', cwd: '.' },
  ];
  const rowsA = await runSuite('community-app', repo, outDir, 'VTID-A', tests.slice(0, 2));
  const rowsB = await runSuite('community-app', repo, outDir, 'VTID-B', [tests[2]]);
  assert.deepEqual(rowsA.map((r) => r.name), ['first', 'second']);
  assert.equal(rowsA[0].reused_from, undefined);
  assert.deepEqual(rowsB.map((r) => r.name), ['third']);
  assert.equal(rowsB[0].reused_from, 'VTID-A');
  assert.equal(rowsB[0].ok, true);
});
