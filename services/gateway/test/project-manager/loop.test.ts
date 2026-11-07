/**
 * VTID-05274 — the live PM loop (plan kiro-autonomy-fallback §5 C6): the
 * Postgres lease on pm_lease (T26) and `startPmLoop`, which runs the act tick in
 * `live` and the decide-only tick otherwise.
 */
import { PgLeaseManager, getLastLease, type LeaseClient } from '../../src/services/project-manager/lease';
import { startPmLoop } from '../../src/services/project-manager/loop';
import { getStatusSnapshot } from '../../src/services/project-manager';
import type { ActDeps } from '../../src/services/project-manager/act';
import type { ObservedState, PmMode } from '../../src/services/project-manager/types';

function client(fn: LeaseClient['tryAcquire']): LeaseClient {
  return { tryAcquire: fn };
}
const err = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('T26 PgLeaseManager on pm_lease', () => {
  it('row free → acquired (TTL passed through), last_lease acquired', async () => {
    const seen: number[] = [];
    const m = new PgLeaseManager(client(async (holder, ttl) => { seen.push(ttl); return { rows: [{ holder, expires_at: '2026-10-20T12:01:30Z' }] }; }), 90_000);
    expect(await m.acquire('task-1')).toEqual({ acquired: true, holder: 'task-1', expires_at: '2026-10-20T12:01:30Z' });
    expect(seen).toEqual([90_000]);
    expect(getLastLease()).toBe('acquired');
  });
  it('held by another task (no row updated) → held_by_other', async () => {
    const m = new PgLeaseManager(client(async () => ({ rows: [] })), 90_000);
    expect(await m.acquire('task-1')).toEqual({ acquired: false, reason: 'held_by_other' });
    expect(getLastLease()).toBe('held_by_other');
  });
  it.each(['42P01', 'PGRST205'])('missing relation (%s) → table_absent', async (code) => {
    const m = new PgLeaseManager(client(async () => { throw err(code); }), 90_000);
    expect(await m.acquire('task-1')).toEqual({ acquired: false, reason: 'table_absent' });
    expect(getLastLease()).toBe('table_absent');
  });
  it('any other error → error (never throws)', async () => {
    const m = new PgLeaseManager(client(async () => { throw err('57P01'); }), 90_000);
    const o = await m.acquire('task-1');
    expect(o).toMatchObject({ acquired: false, reason: 'error' });
    expect(getLastLease()).toBe('error');
  });
});

function observer(seen: PmMode[]) {
  return { async observe(mode: PmMode): Promise<ObservedState> { seen.push(mode); return { mode, lanes: [], rotations: [], claude: { flag: false, oldest_assigned_at: null, last_action_at: null } }; } };
}
function actDeps(acquired: string[]): ActDeps {
  return {
    safeMerge: async () => { throw new Error('no merge expected'); },
    laneWriter: { write: async () => 'written' as const },
    gate2Poster: { post: async () => undefined },
    gate2Evidence: { resolve: async () => ({ verified_commit: '', production_commit: '', commits: [] }) },
    lease: { acquire: async (h: string) => { acquired.push(h); return { acquired: true, holder: h, expires_at: 'x' }; } },
  };
}

describe('startPmLoop', () => {
  const prev = process.env.PM_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PM_MODE;
    else process.env.PM_MODE = prev;
  });

  it('live → act tick (takes the lease); status shows the fallback', async () => {
    process.env.PM_MODE = 'live';
    const acquired: string[] = [];
    const seen: PmMode[] = [];
    const timers: Array<() => void> = [];
    const loop = startPmLoop({
      deps: () => ({ observer: observer(seen), act: actDeps(acquired), emitter: { emit: async () => undefined } }),
      intervalMs: 120000,
      setIntervalFn: (fn) => { timers.push(fn); return { unref() { /* test */ } } as any; },
      clearIntervalFn: () => undefined,
    });
    await loop.tick();
    expect(seen).toEqual(['live']);
    expect(acquired).toHaveLength(1);
    expect(timers).toHaveLength(1);
    const snap = getStatusSnapshot();
    expect(snap.claude).toEqual({ available: false, reason: 'flag_false' });
    expect(snap.fallback).toBe(true);
    loop.stop();
  });

  it('dry_run → decide-only tick (never takes the lease)', async () => {
    process.env.PM_MODE = 'dry_run';
    const acquired: string[] = [];
    const seen: PmMode[] = [];
    const loop = startPmLoop({
      deps: () => ({ observer: observer(seen), act: actDeps(acquired), emitter: { emit: async () => undefined } }),
      setIntervalFn: () => ({ unref() { /* test */ } }) as any,
      clearIntervalFn: () => undefined,
    });
    await loop.tick();
    expect(seen).toEqual(['dry_run']);
    expect(acquired).toHaveLength(0);
    loop.stop();
  });

  it('a tick error is caught; overlapping ticks are skipped', async () => {
    process.env.PM_MODE = 'live';
    let n = 0;
    let release: () => void = () => undefined;
    const slow = { observe: () => { n++; return new Promise<ObservedState>((res) => { release = () => res({ mode: 'live', lanes: [], rotations: [] }); }); } };
    const loop = startPmLoop({
      deps: () => ({ observer: slow, act: actDeps([]) }),
      setIntervalFn: () => ({ unref() { /* test */ } }) as any,
      clearIntervalFn: () => undefined,
    });
    const first = loop.tick();
    await loop.tick();
    expect(n).toBe(1);
    release();
    await first;
    const failing = startPmLoop({
      deps: () => ({ observer: { observe: async () => { throw new Error('boom'); } }, act: actDeps([]) }),
      setIntervalFn: () => ({ unref() { /* test */ } }) as any,
      clearIntervalFn: () => undefined,
    });
    await expect(failing.tick()).resolves.toBeUndefined();
    loop.stop();
    failing.stop();
  });
});
