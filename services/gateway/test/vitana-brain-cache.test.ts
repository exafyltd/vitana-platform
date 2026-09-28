/**
 * ORB-BRAIN-CACHE (DEV-COMHU-0513) — unit tests for the per-identity brain
 * instruction cache. Covers flag-off passthrough, hit/miss, TTL expiry,
 * concurrent de-dupe, failure non-caching, key isolation, and prewarm warming.
 * `buildBrainSystemInstruction` is fully mocked so these tests don't load the
 * heavy real brain stack.
 */

jest.mock('../src/services/vitana-brain', () => ({
  buildBrainSystemInstruction: jest.fn(),
}));

// VTID-04556: the cache-mechanics tests below run with no memory store (the
// freshness probe answers null = "cannot know", the pre-04556 behaviour).
// The probe itself has its own tests at the end of this file.
const mockGetSupabase = jest.fn((): any => null);
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockGetSupabase() }));

import { buildBrainSystemInstruction } from '../src/services/vitana-brain';
import {
  buildBrainSystemInstructionCached,
  warmBrainCache,
  _resetBrainCacheForTests,
  brainCacheSize,
  memoryChangedSince,
} from '../src/services/vitana-brain-cache';

const mockBuild = buildBrainSystemInstruction as jest.Mock;
const FLAG = 'FEATURE_ORB_BRAIN_CACHE_ENV';
const baseInput = { user_id: 'u1', tenant_id: 't1', role: 'community', channel: 'orb' } as any;

describe('vitana-brain-cache', () => {
  const prev = process.env[FLAG];
  beforeEach(() => {
    _resetBrainCacheForTests();
    mockBuild.mockReset();
    mockBuild.mockImplementation(() => Promise.resolve({ instruction: 'INSTR', contextPack: {} }));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it('flag OFF → passthrough, no caching (each call rebuilds)', async () => {
    delete process.env[FLAG];
    await buildBrainSystemInstructionCached(baseInput);
    await buildBrainSystemInstructionCached(baseInput);
    expect(mockBuild).toHaveBeenCalledTimes(2);
    expect(brainCacheSize()).toBe(0);
  });

  it('flag ON → MISS then HIT (one build serves two calls)', async () => {
    process.env[FLAG] = 'staging+prod';
    const a = await buildBrainSystemInstructionCached(baseInput);
    const b = await buildBrainSystemInstructionCached(baseInput);
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('flag ON → rebuilds after the 5-min TTL expires', async () => {
    process.env[FLAG] = 'staging+prod';
    let t = 1000;
    const now = () => t;
    await buildBrainSystemInstructionCached(baseInput, { now });
    t += 5 * 60 * 1000 + 1; // just past TTL
    await buildBrainSystemInstructionCached(baseInput, { now });
    expect(mockBuild).toHaveBeenCalledTimes(2);
  });

  it('flag ON → concurrent callers share ONE in-flight build (no stampede)', async () => {
    process.env[FLAG] = 'staging+prod';
    let resolve!: (v: unknown) => void;
    mockBuild.mockImplementation(() => new Promise((r) => { resolve = r as (v: unknown) => void; }));
    const p1 = buildBrainSystemInstructionCached(baseInput);
    const p2 = buildBrainSystemInstructionCached(baseInput);
    resolve({ instruction: 'X', contextPack: {} });
    await Promise.all([p1, p2]);
    expect(mockBuild).toHaveBeenCalledTimes(1);
  });

  it('flag ON → failures are NOT cached (next call rebuilds)', async () => {
    process.env[FLAG] = 'staging+prod';
    mockBuild.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await expect(buildBrainSystemInstructionCached(baseInput)).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 0)); // let the eviction .catch run
    mockBuild.mockImplementation(() => Promise.resolve({ instruction: 'OK', contextPack: {} }));
    const r = await buildBrainSystemInstructionCached(baseInput);
    expect(r.instruction).toBe('OK');
    expect(mockBuild).toHaveBeenCalledTimes(2);
  });

  it('flag ON → different user is a separate cache entry (no cross-user leak)', async () => {
    process.env[FLAG] = 'staging+prod';
    await buildBrainSystemInstructionCached(baseInput);
    await buildBrainSystemInstructionCached({ ...baseInput, user_id: 'u2' });
    expect(mockBuild).toHaveBeenCalledTimes(2);
    expect(brainCacheSize()).toBe(2);
  });

  it('warmBrainCache makes the next real call a HIT', async () => {
    process.env[FLAG] = 'staging+prod';
    warmBrainCache(baseInput);
    await new Promise((r) => setTimeout(r, 0)); // let the warm build settle
    await buildBrainSystemInstructionCached(baseInput);
    expect(mockBuild).toHaveBeenCalledTimes(1);
  });

  it('warmBrainCache is a no-op when the flag is OFF', async () => {
    delete process.env[FLAG];
    warmBrainCache(baseInput);
    await new Promise((r) => setTimeout(r, 0));
    expect(brainCacheSize()).toBe(0);
  });

  // VTID-03504 — the stampede guard must not depend on the caching flag.
  describe('single-flight de-dupe is independent of ORB_BRAIN_CACHE', () => {
    it('flag OFF → concurrent callers still share ONE in-flight build', async () => {
      delete process.env[FLAG];
      let resolve!: (v: unknown) => void;
      mockBuild.mockImplementation(() => new Promise((r) => { resolve = r as (v: unknown) => void; }));

      // Ten simultaneous starts — the shape of a widget reconnect storm.
      const calls = Array.from({ length: 10 }, () => buildBrainSystemInstructionCached(baseInput));
      resolve({ instruction: 'X', contextPack: {} });
      const results = await Promise.all(calls);

      expect(mockBuild).toHaveBeenCalledTimes(1);
      expect(results.every((r) => r.instruction === 'X')).toBe(true);
    });

    it('flag OFF → the slot is released once the build settles (next call rebuilds)', async () => {
      delete process.env[FLAG];
      await buildBrainSystemInstructionCached(baseInput);
      expect(brainCacheSize()).toBe(0);
      await buildBrainSystemInstructionCached(baseInput);
      expect(mockBuild).toHaveBeenCalledTimes(2);
    });

    it('flag OFF → a rejected build does not wedge the slot', async () => {
      delete process.env[FLAG];
      mockBuild.mockImplementationOnce(() => Promise.reject(new Error('boom')));
      await expect(buildBrainSystemInstructionCached(baseInput)).rejects.toThrow('boom');
      await new Promise((r) => setTimeout(r, 0));
      expect(brainCacheSize()).toBe(0);
      const r = await buildBrainSystemInstructionCached(baseInput);
      expect(r.instruction).toBe('INSTR');
    });

    it('flag ON → a build outliving the TTL is joined, not duplicated', async () => {
      process.env[FLAG] = 'staging+prod';
      let t = 1000;
      const now = () => t;
      let resolve!: (v: unknown) => void;
      mockBuild.mockImplementation(() => new Promise((r) => { resolve = r as (v: unknown) => void; }));

      const first = buildBrainSystemInstructionCached(baseInput, { now });
      t += 5 * 60 * 1000 + 1; // past the TTL, but the build has not finished
      const second = buildBrainSystemInstructionCached(baseInput, { now });

      resolve({ instruction: 'SLOW', contextPack: {} });
      await Promise.all([first, second]);
      expect(mockBuild).toHaveBeenCalledTimes(1);
    });

    it('concurrent callers for DIFFERENT users are not collapsed together', async () => {
      delete process.env[FLAG];
      const resolvers: Array<(v: unknown) => void> = [];
      mockBuild.mockImplementation(() => new Promise((r) => { resolvers.push(r as (v: unknown) => void); }));

      const a = buildBrainSystemInstructionCached(baseInput);
      const b = buildBrainSystemInstructionCached({ ...baseInput, user_id: 'u2' });
      expect(mockBuild).toHaveBeenCalledTimes(2);
      resolvers.forEach((r) => r({ instruction: 'Y', contextPack: {} }));
      await Promise.all([a, b]);
    });
  });

  describe('VTID-04556 — memory freshness on a cache hit', () => {
    it('rebuilds when the member\'s memory changed after the cached build', async () => {
      process.env[FLAG] = 'staging+prod';
      const changed = jest.fn().mockResolvedValue(true);
      await buildBrainSystemInstructionCached(baseInput, { memoryChangedSince: changed });
      await buildBrainSystemInstructionCached(baseInput, { memoryChangedSince: changed });
      expect(mockBuild).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it('serves the cached build while memory is unchanged', async () => {
      process.env[FLAG] = 'staging+prod';
      const unchanged = jest.fn().mockResolvedValue(false);
      const a = await buildBrainSystemInstructionCached(baseInput, { memoryChangedSince: unchanged });
      const b = await buildBrainSystemInstructionCached(baseInput, { memoryChangedSince: unchanged });
      expect(mockBuild).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });

    it('asks about writes after the time the cached build started', async () => {
      process.env[FLAG] = 'staging+prod';
      let t = 50_000;
      const probe = jest.fn().mockResolvedValue(false);
      await buildBrainSystemInstructionCached(baseInput, { now: () => t, memoryChangedSince: probe });
      t += 10_000;
      await buildBrainSystemInstructionCached(baseInput, { now: () => t, memoryChangedSince: probe });
      expect(probe).toHaveBeenCalledWith(baseInput, 50_000);
    });
  });

  describe('memoryChangedSince (store probe)', () => {
    const client = (facts: any, items: any) => ({
      from: (table: string) => {
        const res = table === 'memory_facts' ? facts : items;
        const q: any = { select: () => q, eq: () => q, gt: () => q, limit: () => (res instanceof Promise ? res : Promise.resolve(res)) };
        return q;
      },
    });
    afterEach(() => mockGetSupabase.mockImplementation(() => null));

    it('null when no store is configured', async () => {
      await expect(memoryChangedSince(baseInput, 0)).resolves.toBeNull();
    });
    it('true when a fact or an item was written after the build', async () => {
      mockGetSupabase.mockImplementation(() => client({ data: [], error: null }, { data: [{ id: 'x' }], error: null }));
      await expect(memoryChangedSince(baseInput, 0)).resolves.toBe(true);
    });
    it('false when nothing newer exists', async () => {
      mockGetSupabase.mockImplementation(() => client({ data: [], error: null }, { data: [], error: null }));
      await expect(memoryChangedSince(baseInput, 0)).resolves.toBe(false);
    });
    it('true (rebuild) when the probe errors', async () => {
      mockGetSupabase.mockImplementation(() => client({ data: null, error: { message: 'x' } }, { data: [], error: null }));
      await expect(memoryChangedSince(baseInput, 0)).resolves.toBe(true);
    });
    it('true (rebuild) when the probe is slower than its timeout', async () => {
      const never = new Promise(() => {});
      mockGetSupabase.mockImplementation(() => client(never, never));
      await expect(memoryChangedSince(baseInput, 0)).resolves.toBe(true);
    });
  });
});

