/**
 * VTID-04399 (Plan v1 WS-1.2) — per-user core context snapshot.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  BRAIN_CORE_SNAPSHOT_SIGNAL,
  BRAIN_CORE_SNAPSHOT_MAX_CHARS,
  applyCoreContextFallback,
  boundInstruction,
  buildSnapshotValue,
  isBrainCoreSnapshotEnabled,
  parseSnapshotValue,
  readBrainCoreSnapshot,
  recordSnapshotAfterBuild,
  renderSnapshotForSession,
  scheduleSnapshotRefresh,
  shouldWriteSnapshot,
  snapshotMaxAgeMs,
  snapshotUsable,
  _clearPendingRefreshForTests,
  _pendingRefreshCountForTests,
} from '../../../src/services/conversation/brain-core-snapshot';

const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const ids = { tenantId: 't1', userId: 'u1' };

function snap(overrides: Record<string, unknown> = {}) {
  return buildSnapshotValue({ core: 'You are Vitana.\n## Verified Facts\n- name: Mara\n', lang: 'de', builtAtMs: T0, source: 'session_build', ...overrides } as any)!;
}

function fakeRepo(row: unknown, opts: { readError?: string; writeError?: string } = {}) {
  const upserts: any[] = [];
  return {
    upserts,
    repo: {
      fetchBrainCoreSnapshotRow: jest.fn(async () => ({
        data: row,
        error: opts.readError ? { message: opts.readError } : null,
      })),
      upsertBrainCoreSnapshotRow: jest.fn(async (_sb: unknown, r: unknown) => {
        upserts.push(r);
        return { error: opts.writeError ? { message: opts.writeError } : null };
      }),
    } as any,
    getSupabase: async () => ({}) as any,
  };
}

afterEach(() => {
  delete process.env.BRAIN_CORE_SNAPSHOT;
  _clearPendingRefreshForTests();
  jest.useRealTimers();
});

describe('flags and bounds', () => {
  it('is on unless exactly "false"', () => {
    expect(isBrainCoreSnapshotEnabled(undefined)).toBe(true);
    expect(isBrainCoreSnapshotEnabled('true')).toBe(true);
    expect(isBrainCoreSnapshotEnabled('false')).toBe(false);
  });

  it('max age defaults to 72 h and honours a positive override', () => {
    expect(snapshotMaxAgeMs(undefined)).toBe(72 * 3_600_000);
    expect(snapshotMaxAgeMs('12')).toBe(12 * 3_600_000);
    expect(snapshotMaxAgeMs('nope')).toBe(72 * 3_600_000);
  });

  it('bounds the stored text at a line break', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `- memory bullet ${i} with some detail\n`).join('');
    const out = boundInstruction(long);
    expect(out.length).toBeLessThanOrEqual(BRAIN_CORE_SNAPSHOT_MAX_CHARS);
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('value build / parse', () => {
  it('round-trips and rejects anything malformed', () => {
    const v = snap();
    expect(v).toMatchObject({ version: 1, role: 'community', lang: 'de', source: 'session_build' });
    expect(v.hash).toHaveLength(32);
    expect(parseSnapshotValue(JSON.parse(JSON.stringify(v)))).toEqual(v);
    expect(parseSnapshotValue(null)).toBeNull();
    expect(parseSnapshotValue({ ...v, version: 2 })).toBeNull();
    expect(parseSnapshotValue({ ...v, role: 'developer' })).toBeNull();
    expect(parseSnapshotValue({ ...v, instruction: '   ' })).toBeNull();
    expect(parseSnapshotValue({ ...v, built_at: 'not a date' })).toBeNull();
  });

  it('an empty core produces no value', () => {
    expect(buildSnapshotValue({ core: '  ', builtAtMs: T0, source: 'session_build' })).toBeNull();
  });
});

describe('usability and rendering', () => {
  it('accepts a fresh snapshot and rejects absent, too old and future-dated ones', () => {
    expect(snapshotUsable(snap(), { nowMs: T0 + 3_600_000 })).toEqual({ ok: true, ageMs: 3_600_000 });
    expect(snapshotUsable(null, { nowMs: T0 })).toEqual({ ok: false, reason: 'absent' });
    expect(snapshotUsable(snap(), { nowMs: T0 + 73 * 3_600_000 })).toEqual({ ok: false, reason: 'too_old' });
    expect(snapshotUsable(snap(), { nowMs: T0 - 10 * 60_000 })).toEqual({ ok: false, reason: 'future_dated' });
  });

  it('renders the snapshot with a dated header the model reads as intent', () => {
    const text = renderSnapshotForSession(snap(), T0 + 2 * 3_600_000);
    expect(text.startsWith('[CORE CONTEXT SNAPSHOT — assembled 2026-09-23T10:00:00.000Z (2 h ago)')).toBe(true);
    expect(text).toContain('as of that time, not as of now');
    expect(text).toContain('- name: Mara');
  });
});

describe('write decision', () => {
  it('writes when absent, stale or changed after the interval; skips unchanged and throttled', () => {
    const v = snap();
    expect(shouldWriteSnapshot({ existing: null, nextHash: 'x', nowMs: T0 })).toEqual({ write: true, reason: 'absent' });
    expect(shouldWriteSnapshot({ existing: v, nextHash: v.hash, nowMs: T0 + 60_000 })).toEqual({ write: false, reason: 'unchanged' });
    expect(shouldWriteSnapshot({ existing: v, nextHash: 'other', nowMs: T0 + 60_000 })).toEqual({ write: false, reason: 'throttled' });
    expect(shouldWriteSnapshot({ existing: v, nextHash: 'other', nowMs: T0 + 11 * 60_000 })).toEqual({ write: true, reason: 'changed' });
    expect(shouldWriteSnapshot({ existing: v, nextHash: v.hash, nowMs: T0 + 7 * 3_600_000 })).toEqual({ write: true, reason: 'stale' });
  });
});

describe('I/O', () => {
  it('reads the one row by signal name and parses it', async () => {
    const f = fakeRepo({ value: snap() });
    const out = await readBrainCoreSnapshot(ids, { repo: f.repo, getSupabase: f.getSupabase });
    expect(out?.instruction).toContain('- name: Mara');
    expect(f.repo.fetchBrainCoreSnapshotRow).toHaveBeenCalledWith(expect.anything(), 't1', 'u1', BRAIN_CORE_SNAPSHOT_SIGNAL);
  });

  it('fails open to null on a read error, a hang, or the kill switch', async () => {
    const err = fakeRepo(null, { readError: 'denied' });
    expect(await readBrainCoreSnapshot(ids, { repo: err.repo, getSupabase: err.getSupabase })).toBeNull();

    const hang = { fetchBrainCoreSnapshotRow: () => new Promise(() => {}), upsertBrainCoreSnapshotRow: jest.fn() } as any;
    const start = Date.now();
    expect(await readBrainCoreSnapshot(ids, { repo: hang, getSupabase: async () => ({}) as any, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - start).toBeLessThan(500);

    process.env.BRAIN_CORE_SNAPSHOT = 'false';
    const off = fakeRepo({ value: snap() });
    expect(await readBrainCoreSnapshot(ids, { repo: off.repo, getSupabase: off.getSupabase })).toBeNull();
    expect(off.repo.fetchBrainCoreSnapshotRow).not.toHaveBeenCalled();
  });

  it('write-through after a build respects the throttle against the row the session already read', async () => {
    const f = fakeRepo(null);
    const first = await recordSnapshotAfterBuild(
      { ...ids, core: 'core A', lang: 'de', existing: Promise.resolve(null) },
      { repo: f.repo, getSupabase: f.getSupabase, nowMs: () => T0 },
    );
    expect(first).toEqual({ written: true, reason: 'absent' });
    expect(f.upserts[0]).toMatchObject({ tenant_id: 't1', user_id: 'u1', signal_name: BRAIN_CORE_SNAPSHOT_SIGNAL, source: 'session_build' });
    expect(f.upserts[0].value.instruction).toBe('core A');

    const existing = f.upserts[0].value;
    const same = await recordSnapshotAfterBuild(
      { ...ids, core: 'core A', existing },
      { repo: f.repo, getSupabase: f.getSupabase, nowMs: () => T0 + 60_000 },
    );
    expect(same).toEqual({ written: false, reason: 'unchanged' });
    expect(f.upserts).toHaveLength(1);
  });

  it('a failed write is reported, never thrown', async () => {
    const f = fakeRepo(null, { writeError: 'rls' });
    const r = await recordSnapshotAfterBuild(
      { ...ids, core: 'core', existing: null },
      { repo: f.repo, getSupabase: f.getSupabase, nowMs: () => T0 },
    );
    expect(r).toEqual({ written: false, reason: 'write_failed' });
  });
});

describe('refresh after a session ends', () => {
  it('debounces per user, builds the community core and writes it', async () => {
    jest.useFakeTimers();
    const f = fakeRepo(null);
    const buildCore = jest.fn(async () => ({ instruction: 'full', coreInstruction: 'fresh core' }));
    const done: any[] = [];
    const deps = { repo: f.repo, getSupabase: f.getSupabase, buildCore, delayMs: 1000, nowMs: () => T0, onDone: (r: any) => done.push(r) };

    expect(scheduleSnapshotRefresh({ ...ids, role: 'community', lang: 'de' }, deps)).toEqual({ scheduled: true, reason: 'scheduled' });
    expect(scheduleSnapshotRefresh({ ...ids, role: 'community', lang: 'de' }, deps)).toEqual({ scheduled: true, reason: 'rescheduled' });
    expect(_pendingRefreshCountForTests()).toBe(1);

    jest.advanceTimersByTime(1000);
    jest.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));

    expect(buildCore).toHaveBeenCalledTimes(1);
    expect(buildCore).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1', tenant_id: 't1', role: 'community', channel: 'orb' }));
    expect(done).toEqual([{ written: true, reason: 'refreshed' }]);
    expect(f.upserts[0].value).toMatchObject({ instruction: 'fresh core', source: 'finalize_refresh', lang: 'de' });
  });

  it('does not schedule for another role, a missing identity, or with the kill switch', () => {
    expect(scheduleSnapshotRefresh({ ...ids, role: 'developer' }, { delayMs: 10 })).toEqual({ scheduled: false, reason: 'non_community_role' });
    expect(scheduleSnapshotRefresh({ tenantId: '', userId: 'u1' }, { delayMs: 10 })).toEqual({ scheduled: false, reason: 'no_identity' });
    process.env.BRAIN_CORE_SNAPSHOT = 'false';
    expect(scheduleSnapshotRefresh(ids, { delayMs: 10 })).toEqual({ scheduled: false, reason: 'disabled' });
    expect(_pendingRefreshCountForTests()).toBe(0);
  });
});

describe('the gate fallback', () => {
  it('keeps a context the fresh build already wrote', async () => {
    const s: any = { contextInstruction: 'fresh', coreContextFallback: Promise.resolve('snapshot') };
    expect(await applyCoreContextFallback(s, 50)).toEqual({ source: 'fresh', chars: 5 });
    expect(s.contextInstruction).toBe('fresh');
  });

  it('fills an empty session from the snapshot', async () => {
    const s: any = { contextInstruction: undefined, coreContextFallback: Promise.resolve('snapshot text') };
    expect(await applyCoreContextFallback(s, 50)).toEqual({ source: 'snapshot', chars: 13 });
    expect(s.contextInstruction).toBe('snapshot text');
    expect(s.contextSource).toBe('snapshot');
  });

  it('bounds the wait for a slow read and reports none', async () => {
    const s: any = { contextInstruction: '', coreContextFallback: new Promise(() => {}) };
    const start = Date.now();
    expect(await applyCoreContextFallback(s, 30)).toEqual({ source: 'none', chars: 0 });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('a fresh build that lands during the wait wins over the snapshot', async () => {
    const s: any = { contextInstruction: '' };
    s.coreContextFallback = new Promise((resolve) =>
      setTimeout(() => {
        s.contextInstruction = 'fresh landed';
        resolve('snapshot');
      }, 5),
    );
    expect(await applyCoreContextFallback(s, 100)).toEqual({ source: 'fresh', chars: 12 });
    expect(s.contextInstruction).toBe('fresh landed');
  });

  it('no snapshot promise → none', async () => {
    expect(await applyCoreContextFallback({ contextInstruction: '' } as any, 10)).toEqual({ source: 'none', chars: 0 });
  });
});

describe('metrics summary', () => {
  it('exposes the empty-context rate and the context sources', () => {
    const { summarizeConversationMetrics } = require('../../../src/services/conversation/conversation-metrics');
    const h = '2026-09-23T09:00:00.000Z';
    const row = (metric: string, dimension: string, value: number, sample_count: number) => ({ hour_start: h, metric, dimension, value, sample_count, computed_at: h });
    const out = summarizeConversationMetrics([
      row('context_setup_empty', '', 2, 40),
      row('context_setup_empty', 'transport:sse', 2, 30),
      row('context_setup_source', 'source:fresh', 30, 30),
      row('context_setup_source', 'source:snapshot', 9, 9),
      row('context_setup_source', 'source:none', 1, 1),
      row('diag_core_snapshot_used', '', 9, 9),
    ], 24);
    expect(out.speed.context_setup_empty).toEqual({ numerator: 2, denominator: 40, rate: 0.05 });
    expect(out.speed.context_sources.map((b: any) => [b.key, b.count])).toEqual([['fresh', 30], ['snapshot', 9], ['none', 1]]);
    expect(out.speed.core_snapshot_used).toBe(9);
  });
});

describe('source contracts', () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, '../../../src', p), 'utf8');

  it('the brain returns a core instruction and the full instruction is core + proactive guide', () => {
    const brain = src('services/vitana-brain.ts');
    expect(brain).toMatch(/const instruction = `\$\{coreInstruction\}\n\$\{proactiveGuideBlock\}`;/);
    expect(brain).toMatch(/return \{ instruction, contextPack, coreInstruction \};/);
  });

  it('the controller reads the snapshot for community only and writes through after a fresh build', () => {
    const c = src('orb/live/session/live-session-controller.ts');
    expect(c).toMatch(/useOrbBrain && brainRole === 'community' && bootstrapIdentity\.tenant_id/);
    expect(c).toMatch(/readBrainCoreSnapshot\(/);
    expect(c).toMatch(/recordSnapshotAfterBuild\(/);
    expect(c).toMatch(/coreContextFallback,\n/);
  });

  it('the metric tile styles are top-level rules, never inside a mobile-only block (merge regression)', () => {
    const css = fs
      .readFileSync(path.join(__dirname, '../../../src/frontend/command-hub/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
    for (const sel of ['.conv-metric-grid {', '.conv-metric-tile {', '.conv-metric-window {']) {
      const at = css.indexOf(sel);
      expect(at).toBeGreaterThan(-1);
      // Walk back to the enclosing block, if any: an unmatched '{' before
      // the rule means it is nested (e.g. inside @media (max-width: …)).
      let depth = 0;
      for (let i = at - 1; i >= 0; i--) {
        if (css[i] === '}') depth++;
        else if (css[i] === '{') {
          if (depth === 0) {
            const opener = css.slice(css.lastIndexOf('\n', i) + 1, i);
            throw new Error(`${sel} is nested inside "${opener.trim()}"`);
          }
          depth--;
        }
      }
    }
  });

  it('the gate applies the fallback after the fresh race and records the source', () => {
    const o = src('routes/orb-live.ts');
    expect(o).toMatch(/await applyCoreContextFallback\(session, CORE_SNAPSHOT_GATE_WAIT_MS\)/);
    expect(o).toMatch(/emitDiag\(session, 'core_snapshot_used'/);
    expect(o).toMatch(/context_source: coreFallback\.source/);
    expect(o).toMatch(/context_source: session\.contextSource \?\? null/);
  });
});
