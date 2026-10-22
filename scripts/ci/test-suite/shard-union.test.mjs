// VTID-05272 — tests for shard-union.mjs and the TEST-SUITE.yml shard layout.
// Run: node --test scripts/ci/test-suite/ (CI-SCRIPTS-TEST.yml)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUnion, loadArtifacts, parseList, resultNames } from './shard-union.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const G = '/home/runner/work/vitana-platform/vitana-platform/services/gateway/test';
const LIST = [`${G}/a.test.ts`, `${G}/b.test.ts`, `${G}/c.test.ts`, `${G}/d.test.ts`];

test('checkUnion: the shards together ran exactly the list', () => {
  const r = checkUnion(LIST, [[LIST[0]], [LIST[1], LIST[2]], [], [LIST[3]]]);
  assert.equal(r.ok, true);
  assert.equal(r.total, 4);
  assert.equal(r.ran, 4);
});
test('checkUnion: a file no shard ran fails', () => {
  const r = checkUnion(LIST, [[LIST[0]], [LIST[1]], [LIST[2]], []]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [LIST[3]]);
});
test('checkUnion: a file two shards ran fails; so does a file that is not listed; an empty list never passes', () => {
  const d = checkUnion(LIST, [[LIST[0], LIST[1]], [LIST[1]], [LIST[2]], [LIST[3]]]);
  assert.equal(d.ok, false);
  assert.deepEqual(d.duplicated, [LIST[1]]);
  const e = checkUnion(LIST, [[...LIST, `${G}/zz.test.ts`]]);
  assert.equal(e.ok, false);
  assert.deepEqual(e.extra, [`${G}/zz.test.ts`]);
  assert.equal(checkUnion([], [[]]).ok, false);
});
test('loadArtifacts: a missing shard result or lists that disagree are errors', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shards-'));
  try {
    const list = `ts-jest[config] (WARN) message\n${LIST.join('\n')}\n`;
    for (const n of [1, 2, 3, 4]) writeFileSync(path.join(dir, `list-${n}.txt`), list);
    writeFileSync(path.join(dir, 'shard-1.json'), JSON.stringify({ testResults: [{ name: LIST[0] }, { name: LIST[1] }] }));
    writeFileSync(path.join(dir, 'shard-2.json'), JSON.stringify({ testResults: [{ name: LIST[2] }] }));
    writeFileSync(path.join(dir, 'shard-3.json'), JSON.stringify({ testResults: [{ name: LIST[3] }] }));
    let a = loadArtifacts(dir, 4);
    assert.deepEqual(a.errors, ['shard-4.json missing (shard 4 wrote no Jest result)']);
    assert.deepEqual(a.list, LIST, 'non-path lines in the list output are ignored');
    writeFileSync(path.join(dir, 'shard-4.json'), JSON.stringify({ testResults: [] }));
    a = loadArtifacts(dir, 4);
    assert.deepEqual(a.errors, []);
    assert.equal(checkUnion(a.list, a.results).ok, true);
    writeFileSync(path.join(dir, 'list-2.txt'), LIST.slice(1).join('\n'));
    assert.ok(loadArtifacts(dir, 4).errors.some((e) => e.includes('listed different test files')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(parseList('C:\\x\\a.test.ts\r\nnoise\n'), ['C:/x/a.test.ts']);
  assert.deepEqual(resultNames({ testResults: [{ name: 'x' }, { testFilePath: 'y' }] }), ['x', 'y']);
  assert.deepEqual(resultNames(null), []);
});
test('TEST-SUITE.yml: gateway runs as 4 shards, the union job checks them, the summary needs all three', () => {
  const y = readFileSync(path.join(ROOT, '.github/workflows/TEST-SUITE.yml'), 'utf8');
  const gateway = /\n  gateway:\n([\s\S]*?)\n  gateway-shard-union:/.exec(y)?.[1] || '';
  assert.match(gateway, /name: Gateway \(Jest, shard \$\{\{ matrix\.shard \}\}\/4\)/);
  assert.match(gateway, /fail-fast: false/);
  assert.match(gateway, /shard: \[1, 2, 3, 4\]/);
  assert.match(gateway, /npx jest --silent --maxWorkers=100% --shard=\$\{\{ matrix\.shard \}\}\/4 --json --outputFile=/);
  assert.match(gateway, /npx jest --listTests > /);
  assert.match(gateway, /- name: Run Jest suite/);
  assert.doesNotMatch(gateway, /testPathIgnorePatterns|--testPathIgnore|\.skip/, 'nothing new is skipped');
  const union = /\n  gateway-shard-union:\n([\s\S]*?)\n  services:/.exec(y)?.[1] || '';
  assert.match(union, /needs: \[gateway\]/);
  assert.match(union, /if: always\(\)/);
  assert.match(union, /- name: Check shard union\n\s+run: node scripts\/ci\/test-suite\/shard-union\.mjs --dir shards --shards 4/);
  const summary = /\n  summary:\n([\s\S]*)$/.exec(y)?.[1] || '';
  assert.match(summary, /name: Test Suite Summary/);
  assert.match(summary, /needs: \[gateway, gateway-shard-union, services\]/);
  assert.match(summary, /needs\.gateway-shard-union\.result \}\}" != "success"/);
});
// VTID-05307 (speed-path-filters): dependency caching on the install steps, the
// gateway suite still runs as 4 shards (not collapsed to one job), and no gate
// job is path-filtered. Red on base (no `cache:` key on setup-node); green on head.
test('TEST-SUITE.yml: install steps declare dependency caching and the 4-shard matrix survives', () => {
  const y = readFileSync(path.join(ROOT, '.github/workflows/TEST-SUITE.yml'), 'utf8');
  const gateway = /\n  gateway:\n([\s\S]*?)\n  gateway-shard-union:/.exec(y)?.[1] || '';
  // The gateway shards cache the pnpm store keyed on the root lockfile.
  assert.match(gateway, /cache: pnpm/);
  assert.match(gateway, /cache-dependency-path: pnpm-lock\.yaml/);
  // Still 4 shards, not collapsed to a single job.
  assert.match(gateway, /shard: \[1, 2, 3, 4\]/);
  const services = /\n  services:\n([\s\S]*?)\n  summary:/.exec(y)?.[1] || '';
  // Each service matrix entry carries a cache kind and a lockfile path, wired into setup-node.
  assert.match(services, /cache: \$\{\{ matrix\.cache \}\}/);
  assert.match(services, /cache-dependency-path: \$\{\{ matrix\.lockfile \}\}/);
  assert.match(services, /cache: npm\n\s+lockfile: services\/vcaop\/package-lock\.json/);
  assert.match(services, /cache: npm\n\s+lockfile: services\/oasis-projector\/package-lock\.json/);
  assert.match(services, /cache: pnpm\n\s+lockfile: services\/openclaw-bridge\/pnpm-lock\.yaml/);
});
test('PR-GATE.yml: speed caching added but the gate still runs on every PR (never path-filtered) and enforce is untouched', () => {
  const y = readFileSync(path.join(ROOT, '.github/workflows/PR-GATE.yml'), 'utf8');
  // npm cache keyed on the gateway lockfile for the conditional "Gateway deps" install.
  assert.match(y, /cache: npm\n\s+cache-dependency-path: services\/gateway\/package-lock\.json/);
  // The required gate jobs must NOT be path-filtered: PR-GATE triggers on pull_request types only.
  const on = /\non:\n([\s\S]*?)\npermissions:/.exec(y)?.[1] || '';
  assert.match(on, /pull_request:\n\s+types: \[opened, edited, synchronize, reopened\]/);
  assert.doesNotMatch(on, /paths:/, 'a path filter on a required gate leaves it pending and wedges merges');
  // This lane does not flip the report-only enforce flag.
  assert.doesNotMatch(y, /enforce:\s*true/);
});
