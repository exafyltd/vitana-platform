/**
 * VTID-04884: a voice diary entry becomes a memory episode, as a typed one
 * does (VTID-04390). Production 2026-10-05: both diary entries since
 * 2026-09-23 came in by voice and neither reached memory_items, because
 * tool_save_diary_entry wrote diary_entries directly.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockWrite = jest.fn();
jest.mock('../../../src/services/orb-memory-bridge', () => ({
  ...jest.requireActual('../../../src/services/orb-memory-bridge'),
  writeMemoryItemWithIdentity: (...a: unknown[]) => mockWrite(...a),
}));
jest.mock('../../../src/services/diary-streak-celebrator', () => ({ celebrateDiaryStreak: async () => null }));

type Call = { table: string; ops: Array<[string, unknown[]]> };
/** A chainable supabase-js stand-in; `resolve` decides each query's result. */
function fakeClient(resolve: (c: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const builder = (call: Call): any =>
    new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') {
          const r = resolve(call);
          return (ok: any, ko: any) => Promise.resolve(r).then(ok, ko);
        }
        return (...args: unknown[]) => { call.ops.push([prop, args]); return builder(call); };
      },
    });
  return {
    calls,
    client: {
      from: (table: string) => { const c: Call = { table, ops: [] }; calls.push(c); return builder(c); },
      rpc: async () => ({ data: null, error: null }),
    } as any,
  };
}
const has = (c: Call, op: string) => c.ops.some(([o]) => o === op);

let admin: ReturnType<typeof fakeClient>;
jest.mock('../../../src/lib/supabase', () => ({ getSupabase: () => admin.client }));

import { tool_save_diary_entry } from '../../../src/services/orb-tools-shared';
import { saveDiaryEntry } from '../../../src/services/memory/diary';

const ID = { user_id: '11111111-1111-1111-1111-111111111111', tenant_id: '22222222-2222-2222-2222-222222222222', role: 'community' };
const TEXT = 'Heute war ich laufen und habe gut geschlafen.';

beforeEach(() => {
  mockWrite.mockReset();
  mockWrite.mockResolvedValue({ ok: true, id: 'mem-1' });
  admin = fakeClient((c) => (c.table === 'memory_items' && has(c, 'update') ? { data: [], error: null } : { data: null, error: null }));
});

/** The tool's own client: no recent voice row unless `recent` is given. */
function toolClient(opts: { recent?: { id: string; text: string; created_at: string }; insertError?: string; insertNoRow?: boolean } = {}) {
  return fakeClient((c) => {
    if (c.table === 'diary_entries' && has(c, 'insert')) {
      if (opts.insertError) return { data: null, error: { message: opts.insertError } };
      return { data: opts.insertNoRow ? null : { id: 'diary-new', created_at: '2026-10-05T10:00:00Z' }, error: null };
    }
    if (c.table === 'diary_entries' && has(c, 'maybeSingle')) return { data: opts.recent ?? null, error: null };
    return { data: null, error: null };
  });
}

describe('VTID-04884 voice diary → memory episode', () => {
  it('a new voice entry writes one episode linked to its diary row (fails on the old code)', async () => {
    const sb = toolClient();
    const r = await tool_save_diary_entry({ raw_text: TEXT } as any, ID as any, sb.client);
    expect(r.ok).toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const [identity, item] = mockWrite.mock.calls[0] as [any, any];
    expect(identity).toEqual({ tenant_id: ID.tenant_id, user_id: ID.user_id, active_role: null });
    expect(item).toMatchObject({
      source: 'diary', content: TEXT, importance: 50, occurred_at: '2026-10-05T10:00:00Z',
      content_json: { kind: 'diary', diary_entry_id: 'diary-new', diary_source: 'voice', tags: ['diary', 'voice', 'orb'] },
    });
  });

  it('a coalesced fragment updates the same episode and writes no second one', async () => {
    const recent = { id: 'diary-old', text: 'Erster Teil.', created_at: new Date(Date.now() - 5_000).toISOString() };
    admin = fakeClient((c) => (c.table === 'memory_items' && has(c, 'update') ? { data: [{ id: 'mem-old' }], error: null } : { data: null, error: null }));
    const r = await tool_save_diary_entry({ raw_text: 'Zweiter Teil.' } as any, ID as any, toolClient({ recent }).client);
    expect(r.ok).toBe(true);
    const upd = admin.calls.find((c) => c.table === 'memory_items' && has(c, 'update'))!;
    expect(upd.ops).toContainEqual(['update', [{ content: 'Erster Teil. Zweiter Teil.' }]]);
    expect(upd.ops).toContainEqual(['eq', ['content_json->>diary_entry_id', 'diary-old']]);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('a coalesced fragment whose row has no episode yet writes it (repairs an earlier failure)', async () => {
    const recent = { id: 'diary-old', text: 'Erster Teil.', created_at: new Date(Date.now() - 5_000).toISOString() };
    await tool_save_diary_entry({ raw_text: 'Zweiter Teil.' } as any, ID as any, toolClient({ recent }).client);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect((mockWrite.mock.calls[0] as any[])[1].content_json.diary_entry_id).toBe('diary-old');
  });

  it('an episode failure leaves the spoken result unchanged', async () => {
    const ok = await tool_save_diary_entry({ raw_text: TEXT } as any, ID as any, toolClient().client);
    mockWrite.mockResolvedValue({ ok: false, error: 'boom' });
    const failed = await tool_save_diary_entry({ raw_text: TEXT } as any, ID as any, toolClient().client);
    expect(failed).toEqual(ok);
  });

  it('a failed or empty insert skips the episode, non-fatal as before', async () => {
    const a = await tool_save_diary_entry({ raw_text: TEXT } as any, ID as any, toolClient({ insertError: 'nope' }).client);
    const b = await tool_save_diary_entry({ raw_text: TEXT } as any, ID as any, toolClient({ insertNoRow: true }).client);
    expect(a.ok && b.ok).toBe(true);
    expect((a.result as any).diary_entry_written).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('saveDiaryEntry still writes the same episode', async () => {
    const sb = fakeClient((c) => (c.table === 'diary_entries' && has(c, 'insert')
      ? { data: { id: 'd1', created_at: '2026-10-05T09:00:00Z' }, error: null } : { data: null, error: null }));
    const r = await saveDiaryEntry(sb.client, { user_id: ID.user_id, tenant_id: ID.tenant_id },
      { text: TEXT, source: 'text', tags: ['diary', 'text'] } as any);
    expect(r.ok && r.memory_item_id).toBe('mem-1');
    expect((mockWrite.mock.calls[0] as any[])[1]).toMatchObject({
      source: 'diary', importance: 50, skipFiltering: true, category_key: 'notes',
      content_json: { kind: 'diary', diary_entry_id: 'd1', diary_source: 'text', tags: ['diary', 'text'] },
    });
  });
});

describe('VTID-04884 every diary writer writes the episode', () => {
  const SRC = path.join(__dirname, '../../../src');
  const files: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name)) files.push(p);
  });
  walk(SRC);
  const INSERT = /from\(\s*['"]diary_entries['"]\s*\)\s*\.insert\(/;
  const writers = files.filter((f) => INSERT.test(fs.readFileSync(f, 'utf8')));

  it('finds both known writers (the guard cannot pass by matching nothing)', () => {
    const rel = writers.map((f) => path.relative(SRC, f)).sort();
    expect(rel).toEqual(expect.arrayContaining(['services/memory/diary.ts', 'services/orb-tools-shared.ts']));
  });

  it('each writer also writes the memory episode', () => {
    for (const f of writers) {
      expect([f, /writeDiaryEpisode|saveDiaryEntry/.test(fs.readFileSync(f, 'utf8'))]).toEqual([f, true]);
    }
  });
});
