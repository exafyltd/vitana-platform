/**
 * VTID-03042: save_diary_entry lifted to shared dispatcher.
 *
 * Closes the L2.2b.7 parity gap reported during the German real-mic test
 * (check #5): LiveKit's agent tool was calling /memory/diary/sync-index,
 * which ONLY runs the health-feature extractor + Vitana Index recompute
 * — it does NOT write the user-visible `diary_entries` row. So Vitana
 * announced "I logged your diary" while the user saw no entry in their
 * daily diary. This handler ports Vertex's inline flow into the shared
 * dispatcher so both pipelines:
 *   1) insert diary_entries (the row the user actually sees),
 *   2) extract health features + persist,
 *   3) recompute the Vitana Index,
 *   4) celebrate any streak.
 *
 * These tests pin the contract:
 *   1. Happy path: diary_entries insert called, RPC called, OK returned.
 *   2. Insert failure is non-fatal — the extractor + RPC still run.
 *   3. Empty raw_text returns ok:false without touching the DB.
 *   4. Missing user_id returns ok:false.
 *   5. Result text is voice-friendly and mentions the entry_date.
 *   6. Index delta calculation uses pre-row vs post-RPC pillars.
 *   7. Registered in ORB_TOOL_REGISTRY so dispatchOrbTool routes to it.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

// Mock the diary-health-extractor + streak-celebrator BEFORE the import so
// the dynamic `await import('./diary-health-extractor')` inside the handler
// picks up the stubs.
jest.mock('../src/services/diary-health-extractor', () => ({
  extractHealthFeaturesFromDiary: jest.fn(() => []),
  persistDiaryHealthFeatures: jest.fn(async () => ({ written: 0 })),
}));
jest.mock('../src/services/diary-streak-celebrator', () => ({
  celebrateDiaryStreak: jest.fn(async () => null),
}));

import {
  ORB_TOOL_REGISTRY,
  dispatchOrbTool,
  tool_save_diary_entry,
} from '../src/services/orb-tools-shared';

const USER_UUID = '11111111-1111-4111-8111-111111111111';
const TENANT_UUID = '22222222-2222-4222-8222-222222222222';

interface DbCall {
  table: string;
  op: 'insert' | 'select' | 'rpc';
  payload?: unknown;
}

function makeStubSupabase(opts: {
  diaryInsertError?: { message: string } | null;
  preIndexRow?: Record<string, number> | null;
  rpcReturn?: { data: unknown; error?: { message: string } | null };
}) {
  const calls: DbCall[] = [];
  return {
    from(table: string) {
      if (table === 'diary_entries') {
        return {
          insert: async (row: Record<string, unknown>) => {
            calls.push({ table, op: 'insert', payload: row });
            return { error: opts.diaryInsertError ?? null };
          },
        };
      }
      if (table === 'vitana_index_scores') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  calls.push({ table, op: 'select' });
                  return { data: opts.preIndexRow ?? null, error: null };
                },
              }),
            }),
          }),
        };
      }
      return {} as never;
    },
    async rpc(name: string, args: unknown) {
      calls.push({ table: 'rpc', op: 'rpc', payload: { name, args } });
      return opts.rpcReturn ?? { data: null, error: null };
    },
    _calls: calls,
  };
}

const identity = {
  user_id: USER_UUID,
  tenant_id: TENANT_UUID,
  role: 'community',
  vitana_id: null,
};

describe('VTID-03042 — save_diary_entry lifted to shared dispatcher', () => {
  test('1. happy path: inserts diary_entries + calls index RPC + returns ok', async () => {
    const sb = makeStubSupabase({
      preIndexRow: {
        score_total: 100,
        score_nutrition: 20,
        score_hydration: 20,
        score_exercise: 20,
        score_sleep: 20,
        score_mental: 20,
      },
      rpcReturn: {
        data: {
          ok: true,
          score_total: 120,
          score_nutrition: 24,
          score_hydration: 24,
          score_exercise: 24,
          score_sleep: 24,
          score_mental: 24,
        },
      },
    });
    const result = await tool_save_diary_entry(
      { raw_text: 'I meditated for twenty minutes and drank two liters of water.' },
      identity,
      sb as never,
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(sb._calls.some((c) => c.table === 'diary_entries' && c.op === 'insert')).toBe(true);
    expect(sb._calls.some((c) => c.op === 'rpc')).toBe(true);
    const r = result.result as { entry_date: string; diary_entry_written: boolean; index_delta: { total: number } | null };
    expect(r.diary_entry_written).toBe(true);
    expect(r.index_delta?.total).toBe(20); // 120 - 100
    // YYYY-MM-DD pattern, computed from today.
    expect(r.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('2. diary_entries insert failure is non-fatal — RPC still runs, result still ok', async () => {
    const sb = makeStubSupabase({
      diaryInsertError: { message: 'RLS denied' },
      preIndexRow: null,
      rpcReturn: { data: { ok: true, score_total: 100 } },
    });
    const result = await tool_save_diary_entry(
      { raw_text: 'Walked for thirty minutes this afternoon, felt great.' },
      identity,
      sb as never,
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const r = result.result as { diary_entry_written: boolean };
    expect(r.diary_entry_written).toBe(false);
    expect(sb._calls.some((c) => c.op === 'rpc')).toBe(true); // still called
  });

  test('3. empty raw_text returns ok:false without touching the DB', async () => {
    const sb = makeStubSupabase({});
    const result = await tool_save_diary_entry({ raw_text: '   ' }, identity, sb as never);
    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.error).toMatch(/raw_text/i);
    expect(sb._calls).toHaveLength(0);
  });

  test('4. missing user_id returns ok:false without touching the DB', async () => {
    const sb = makeStubSupabase({});
    const result = await tool_save_diary_entry(
      { raw_text: 'A reasonable diary entry of the right length.' },
      { ...identity, user_id: '' },
      sb as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.error).toMatch(/user_id/i);
    expect(sb._calls).toHaveLength(0);
  });

  test('5. text is voice-friendly and mentions the entry_date', async () => {
    const sb = makeStubSupabase({
      preIndexRow: null,
      rpcReturn: { data: { ok: true, score_total: 50 } },
    });
    const result = await tool_save_diary_entry(
      { raw_text: 'Slept seven hours, well rested.' },
      identity,
      sb as never,
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(typeof result.text).toBe('string');
    expect(result.text).toMatch(/Diary entry logged for \d{4}-\d{2}-\d{2}/);
  });

  test('6. entry_date arg passes through when valid; otherwise defaults to today', async () => {
    const sb = makeStubSupabase({
      preIndexRow: null,
      rpcReturn: { data: { ok: true, score_total: 50 } },
    });
    const result = await tool_save_diary_entry(
      { raw_text: 'A solid entry for yesterday.', entry_date: '2026-04-01' },
      identity,
      sb as never,
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const r = result.result as { entry_date: string };
    expect(r.entry_date).toBe('2026-04-01');

    // Invalid format falls back to today.
    const sb2 = makeStubSupabase({
      preIndexRow: null,
      rpcReturn: { data: { ok: true, score_total: 50 } },
    });
    const result2 = await tool_save_diary_entry(
      { raw_text: 'Another entry.', entry_date: 'not-a-date' },
      identity,
      sb2 as never,
    );
    if (result2.ok !== true) return;
    const r2 = result2.result as { entry_date: string };
    expect(r2.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r2.entry_date).not.toBe('not-a-date');
  });

  test('7. registered in ORB_TOOL_REGISTRY and routes via dispatchOrbTool', async () => {
    expect(ORB_TOOL_REGISTRY.save_diary_entry).toBe(tool_save_diary_entry);
    const sb = makeStubSupabase({
      preIndexRow: null,
      rpcReturn: { data: { ok: true, score_total: 50 } },
    });
    const result = await dispatchOrbTool(
      'save_diary_entry',
      { raw_text: 'Did some yoga and meditation today, twenty minutes total.' },
      identity,
      sb as never,
    );
    expect(result.ok).toBe(true);
  });
});
