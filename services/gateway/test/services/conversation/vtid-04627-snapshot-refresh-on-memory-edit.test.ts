/**
 * VTID-04627 — a memory edit rebuilds the core snapshot within seconds.
 *
 * Found by the live memory suite (VTID-04600, B-REC-01): a fact added in the
 * Memory Garden was missing from the next voice session, because the session
 * ran on a snapshot built before the fact existed. A Garden delete had the
 * mirror problem: the forgotten value stayed in the snapshot.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  refreshSnapshotAfterMemoryEdit,
  scheduleSnapshotRefresh,
  _clearPendingRefreshForTests,
  _pendingRefreshCountForTests,
} from '../../../src/services/conversation/brain-core-snapshot';

const ids = { tenantId: 't1', userId: 'u1' };
const T0 = Date.parse('2026-09-26T10:00:00.000Z');

function fakeDeps() {
  const upserts: any[] = [];
  const buildCore = jest.fn(async () => ({ coreInstruction: 'core with user_pet_name: Bello', instruction: 'x' }));
  return {
    upserts,
    buildCore,
    deps: {
      repo: {
        fetchBrainCoreSnapshotRow: jest.fn(),
        upsertBrainCoreSnapshotRow: jest.fn(async (_sb: unknown, r: unknown) => {
          upserts.push(r);
          return { error: null };
        }),
      } as any,
      getSupabase: async () => ({}) as any,
      buildCore,
      nowMs: () => T0,
    },
  };
}

afterEach(() => {
  _clearPendingRefreshForTests();
  delete process.env.BRAIN_CORE_SNAPSHOT;
  delete process.env.BRAIN_CORE_SNAPSHOT_EDIT_REFRESH_DELAY_MS;
  jest.useRealTimers();
});

describe('refreshSnapshotAfterMemoryEdit', () => {
  it('rebuilds the community snapshot after a short delay', async () => {
    jest.useFakeTimers();
    const f = fakeDeps();
    const done: any[] = [];
    expect(refreshSnapshotAfterMemoryEdit(ids, { ...f.deps, onDone: (r) => done.push(r) })).toEqual({ scheduled: true, reason: 'scheduled' });
    jest.advanceTimersByTime(2_999);
    expect(f.buildCore).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    jest.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.buildCore).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1', tenant_id: 't1', role: 'community' }));
    expect(done).toEqual([{ written: true, reason: 'refreshed' }]);
    expect(f.upserts[0].value.instruction).toContain('Bello');
  });

  it('never cancels the delayed post-session refresh (separate lane)', () => {
    const f = fakeDeps();
    scheduleSnapshotRefresh({ ...ids, role: 'community' }, { ...f.deps, delayMs: 90_000 });
    refreshSnapshotAfterMemoryEdit(ids, f.deps);
    expect(_pendingRefreshCountForTests()).toBe(2);
    // A second edit debounces only its own lane.
    expect(refreshSnapshotAfterMemoryEdit(ids, f.deps).reason).toBe('rescheduled');
    expect(_pendingRefreshCountForTests()).toBe(2);
  });

  it('honours the delay env var and the kill switch', () => {
    process.env.BRAIN_CORE_SNAPSHOT_EDIT_REFRESH_DELAY_MS = '500';
    jest.useFakeTimers();
    const f = fakeDeps();
    refreshSnapshotAfterMemoryEdit(ids, f.deps);
    jest.advanceTimersByTime(500);
    expect(f.buildCore).toHaveBeenCalledTimes(1);
    process.env.BRAIN_CORE_SNAPSHOT = 'false';
    expect(refreshSnapshotAfterMemoryEdit(ids, f.deps)).toEqual({ scheduled: false, reason: 'disabled' });
  });
});

describe('every member memory write path triggers the refresh', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../../../src', p), 'utf8');

  it('Memory Garden add / edit / delete (emitWrite runs on every successful write)', () => {
    const src = read('routes/memory-garden.ts');
    const emit = src.slice(src.indexOf('function emitWrite'), src.indexOf('function sendWrite'));
    expect(emit).toContain('refreshSnapshotAfterMemoryEdit(');
    for (const verb of ['added', 'edited', 'deleted']) expect(src).toContain(`emitWrite(identity, '${verb}'`);
  });

  it('remember_fact (tool and backstop share buildRememberFactDeps)', () => {
    const src = read('services/orb-tools-shared.ts');
    const deps = src.slice(src.indexOf('export async function buildRememberFactDeps'), src.indexOf('export async function tool_remember_fact'));
    expect(deps).toMatch(/if \(result\.ok\)[\s\S]*refreshSnapshotAfterMemoryEdit\(/);
    expect(deps).not.toContain('write: rememberFact,');
  });

  it('forget_memory voice tool', () => {
    const src = read('services/orb-tools/diary-memory-tools.ts');
    const fn = src.slice(src.indexOf('export async function tool_forget_memory'), src.indexOf('DIARY_MEMORY_TOOL_HANDLERS'));
    expect(fn.indexOf('refreshSnapshotAfterMemoryEdit')).toBeGreaterThan(fn.indexOf('deleteMemoryItem'));
  });
});
