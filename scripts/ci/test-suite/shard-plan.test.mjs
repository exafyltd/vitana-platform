// Tests for shard-plan.mjs (duration-balanced gateway Jest shards).
// Run: node --test scripts/ci/test-suite/ (CI-SCRIPTS-TEST.yml)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planShards, verifyCoverage, weightsFromDoc, weightsFromJestJson, relKey, WEIGHTS_SCHEMA } from './shard-plan.mjs';

const ROOT = '/home/runner/work/vitana-platform/vitana-platform/services/gateway';
const f = (rel) => path.posix.join(ROOT, rel);

test('planShards: every file lands in exactly one shard', () => {
  const files = Array.from({ length: 37 }, (_, i) => f(`test/t${i}.test.ts`));
  const weights = new Map(files.map((x, i) => [relKey(x, ROOT), (i * 7919) % 500 + 1]));
  const plan = planShards(files, { shards: 4, weights, root: ROOT });
  const all = plan.buckets.flat();
  assert.equal(all.length, 37);
  assert.equal(new Set(all).size, 37);
});

test('planShards: balances durations better than a count-based split would', () => {
  // One slow file and many fast ones: a count split puts the slow file with 9 others.
  const files = Array.from({ length: 40 }, (_, i) => f(`test/x${i}.test.ts`));
  const weights = new Map(files.map((x, i) => [relKey(x, ROOT), i === 0 ? 1000 : 100]));
  const plan = planShards(files, { shards: 4, weights, root: ROOT });
  // Count split: the slow file shares a shard with nine fast ones (1900 ms). Duration split: 1300 ms at most.
  assert.ok(Math.max(...plan.loads) <= 1300, `loads ${plan.loads}`);
  assert.ok(Math.max(...plan.loads) - Math.min(...plan.loads) <= 300, `loads ${plan.loads}`);
});

test('planShards: is deterministic regardless of input order', () => {
  const files = ['c', 'a', 'b', 'd', 'e'].map((x) => f(`test/${x}.test.ts`));
  const weights = new Map([['test/a.test.ts', 5], ['test/b.test.ts', 5], ['test/c.test.ts', 9]]);
  const a = planShards(files, { shards: 2, weights, root: ROOT });
  const b = planShards([...files].reverse(), { shards: 2, weights, root: ROOT });
  assert.deepEqual(a.buckets, b.buckets);
});

test('planShards: files without a weight get the median and are reported', () => {
  const files = [f('test/known1.test.ts'), f('test/known2.test.ts'), f('test/new.test.ts')];
  const weights = new Map([['test/known1.test.ts', 100], ['test/known2.test.ts', 300]]);
  const plan = planShards(files, { shards: 2, weights, root: ROOT });
  assert.deepEqual(plan.defaulted, ['test/new.test.ts']);
  assert.equal(plan.fallback, 200);
});

test('verifyCoverage: passes for a complete plan', () => {
  const files = [f('test/a.test.ts'), f('test/b.test.ts'), f('test/c.test.ts')];
  const r = verifyCoverage(files, { shards: 4, weights: new Map(), root: ROOT });
  assert.equal(r.ok, true);
  assert.equal(r.total, 3);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.duplicated, []);
});

test('verifyCoverage: an empty list is not a pass', () => {
  assert.equal(verifyCoverage([], { shards: 4, weights: new Map(), root: ROOT }).ok, false);
});

test('weightsFromDoc: rejects a document with another schema', () => {
  assert.throws(() => weightsFromDoc({ schema: 'other', weights: {} }), /not a/);
  assert.equal(weightsFromDoc({ schema: WEIGHTS_SCHEMA, weights: { 'test/a.test.ts': 5 } }).get('test/a.test.ts'), 5);
});

test('weightsFromJestJson: takes each file wall time, skips files without timestamps', () => {
  const doc = weightsFromJestJson({
    testResults: [
      { name: f('test/b.test.ts'), startTime: 1000, endTime: 1450 },
      { name: f('test/a.test.ts'), startTime: 0, endTime: 0.2 },
      { name: f('test/none.test.ts') },
    ],
  }, ROOT);
  assert.equal(doc.schema, WEIGHTS_SCHEMA);
  assert.deepEqual(doc.weights, { 'test/a.test.ts': 1, 'test/b.test.ts': 450 });
});

test('proveUnion: detects a file in no shard, a file in two shards and a file never listed', async () => {
  const { proveUnion } = await import('./prove-shard-coverage.mjs');
  const list = ['/r/a.test.ts', '/r/b.test.ts', '/r/c.test.ts'];
  assert.equal(proveUnion(list, [['/r/a.test.ts'], ['/r/b.test.ts', '/r/c.test.ts']]).ok, true);
  assert.deepEqual(proveUnion(list, [['/r/a.test.ts'], ['/r/b.test.ts']]).missing, ['/r/c.test.ts']);
  assert.deepEqual(proveUnion(list, [['/r/a.test.ts', '/r/b.test.ts'], ['/r/b.test.ts', '/r/c.test.ts']]).twice, ['/r/b.test.ts']);
  assert.deepEqual(proveUnion(list, [['/r/a.test.ts', '/r/b.test.ts', '/r/c.test.ts', '/r/z.test.ts']]).extra, ['/r/z.test.ts']);
  assert.equal(proveUnion([], [[]]).ok, false);
});
