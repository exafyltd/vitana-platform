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

import { buildBrainSystemInstruction } from '../src/services/vitana-brain';
import {
  buildBrainSystemInstructionCached,
  warmBrainCache,
  _resetBrainCacheForTests,
  brainCacheSize,
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
});
