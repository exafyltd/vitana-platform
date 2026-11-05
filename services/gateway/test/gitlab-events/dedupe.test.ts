/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5 "Retries are dropped by webhook-id", §8) — delivery dedupe.
 *
 * Per gateway task, in memory (plan §8: a duplicate across tasks is possible and moves no state).
 * Pins: an id is recorded once; a failed record is not remembered, so GitLab's retry can record it;
 * a duplicate that arrives while the first delivery is still being recorded waits for it and never
 * records a second time; ids are forgotten after the TTL and the oldest is dropped at the cap.
 */

import { DEDUPE_MAX_IDS, DEDUPE_TTL_MS, DeliveryDedupe } from '../../src/services/gitlab-events/dedupe';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('VTID-05541 DeliveryDedupe', () => {
  it('defaults: ids are kept 24 hours, at most 10,000 of them', () => {
    expect(DEDUPE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEDUPE_MAX_IDS).toBe(10_000);
  });

  it('records an id once; a later delivery with the same id is a duplicate and records nothing', async () => {
    const d = new DeliveryDedupe();
    const record = jest.fn(async () => true);
    expect(d.seen('msg_1')).toBe(false);
    expect(await d.once('msg_1', record)).toBe('recorded');
    expect(d.seen('msg_1')).toBe(true);
    expect(await d.once('msg_1', record)).toBe('duplicate');
    expect(record).toHaveBeenCalledTimes(1);
    expect(await d.once('msg_2', record)).toBe('recorded');
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('a failed record is not remembered: the retry records it', async () => {
    const d = new DeliveryDedupe();
    expect(await d.once('msg_1', async () => false)).toBe('failed');
    expect(d.seen('msg_1')).toBe(false);
    const retry = jest.fn(async () => true);
    expect(await d.once('msg_1', retry)).toBe('recorded');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a record that throws counts as failed and is not remembered', async () => {
    const d = new DeliveryDedupe();
    expect(await d.once('msg_1', async () => { throw new Error('db down'); })).toBe('failed');
    expect(d.seen('msg_1')).toBe(false);
  });

  it('a concurrent duplicate waits for the first delivery and records nothing itself', async () => {
    const d = new DeliveryDedupe();
    const gate = deferred<boolean>();
    const first = jest.fn(() => gate.promise);
    const second = jest.fn(async () => true);
    const a = d.once('msg_1', first);
    const b = d.once('msg_1', second);
    gate.resolve(true);
    expect(await a).toBe('recorded');
    expect(await b).toBe('duplicate');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('when the first of two concurrent deliveries fails, both answer failed and a later retry records', async () => {
    const d = new DeliveryDedupe();
    const gate = deferred<boolean>();
    const a = d.once('msg_1', () => gate.promise);
    const second = jest.fn(async () => true);
    const b = d.once('msg_1', second);
    gate.resolve(false);
    expect(await a).toBe('failed');
    expect(await b).toBe('failed');
    expect(second).not.toHaveBeenCalled();
    expect(await d.once('msg_1', async () => true)).toBe('recorded');
  });

  it('forgets an id after the TTL', async () => {
    let now = 1_000_000;
    const d = new DeliveryDedupe({ ttlMs: 60_000, now: () => now });
    await d.once('msg_1', async () => true);
    now += 59_999;
    expect(d.seen('msg_1')).toBe(true);
    now += 2;
    expect(d.seen('msg_1')).toBe(false);
    const again = jest.fn(async () => true);
    expect(await d.once('msg_1', again)).toBe('recorded');
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('tells apart long ids that share a prefix (ids are hashed, not cut)', async () => {
    const d = new DeliveryDedupe();
    const a = `${'x'.repeat(5000)}a`;
    const b = `${'x'.repeat(5000)}b`;
    expect(await d.once(a, async () => true)).toBe('recorded');
    expect(await d.once(b, async () => true)).toBe('recorded');
    expect(await d.once(a, async () => true)).toBe('duplicate');
  });

  it('drops the oldest id when the cap is reached', async () => {
    const d = new DeliveryDedupe({ maxIds: 3 });
    for (const id of ['a', 'b', 'c', 'd']) await d.once(id, async () => true);
    expect(d.size()).toBe(3);
    expect(d.seen('a')).toBe(false);
    expect(['b', 'c', 'd'].every((id) => d.seen(id))).toBe(true);
  });
});
