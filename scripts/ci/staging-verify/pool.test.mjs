// VTID-05672: unit tests for the staging-verify pool helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createLocks } from './pool.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('limiter never runs more than the limit at once', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const task = () => limit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
  });
  await Promise.all(Array.from({ length: 8 }, task));
  assert.equal(peak, 2);
});

test('limiter returns results and rejections per task', async () => {
  const limit = createLimiter(3);
  const ok = limit(async () => 'a');
  const bad = limit(async () => { throw new Error('boom'); });
  assert.equal(await ok, 'a');
  await assert.rejects(bad, /boom/);
});

test('locks: tasks with the same key never overlap', async () => {
  const lock = createLocks();
  const log = [];
  const job = (name) => lock('dir', async () => {
    log.push(`start ${name}`);
    await sleep(5);
    log.push(`end ${name}`);
  });
  await Promise.all([job('a'), job('b'), job('c')]);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('locks: different keys run in parallel', async () => {
  const lock = createLocks();
  let active = 0;
  let peak = 0;
  const job = (key) => lock(key, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(10);
    active -= 1;
  });
  await Promise.all([job('x'), job('y')]);
  assert.equal(peak, 2);
});

test('locks: a failing task does not block the next one', async () => {
  const lock = createLocks();
  const first = lock('dir', async () => { throw new Error('fail'); });
  const second = lock('dir', async () => 'ok');
  await assert.rejects(first, /fail/);
  assert.equal(await second, 'ok');
});
