// VTID-04343 — the DIARY block reads BOTH diary stores.
//
// The app's Daily Diary writes `diary_entries` (273 rows live) while the
// broker used to read only `memory_diary_entries` (1 row), so every turn
// reported diary_loaded=0. These tests pin the merge: both tables are read,
// entries come back newest-first, blanks are dropped, and one missing table
// does not blank the other.

const tableResponses = new Map<string, { data: unknown; error: { message: string } | null }>();
const fromCalls: string[] = [];

function makeChain(table: string) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit', 'is', 'in', 'lte', 'neq', 'gt']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(tableResponses.get(table) ?? { data: [], error: null }).then(resolve);
  return chain;
}

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({
    from: (t: string) => {
      fromCalls.push(t);
      return makeChain(t);
    },
    rpc: () => makeChain('__rpc'),
  })),
}));

import { getMemoryContext } from '../../src/services/memory-broker';

const INPUT = {
  tenant_id: 'tenant-aaa',
  user_id: 'user-bbb',
  intent: 'recall_recent' as const,
  channel: 'conversation' as const,
  role: 'community' as const,
  latency_budget_ms: 2000,
  required_blocks: ['DIARY' as const],
};

beforeEach(() => {
  tableResponses.clear();
  fromCalls.length = 0;
});

describe('VTID-04343 DIARY block merges diary_entries + memory_diary_entries', () => {
  it('reads both tables and returns entries newest-first', async () => {
    tableResponses.set('memory_diary_entries', {
      data: [{ id: 'md1', occurred_at: '2026-09-20T08:00:00Z', category_key: 'health', content: 'legacy entry' }],
      error: null,
    });
    tableResponses.set('diary_entries', {
      data: [
        { id: 'd1', created_at: '2026-09-22T07:00:00Z', text: 'Slept badly, knee hurts', tags: ['health'] },
        { id: 'd2', created_at: '2026-09-21T19:00:00Z', text: 'Great walk with Mia', tags: [] },
        { id: 'd3', created_at: '2026-09-21T10:00:00Z', text: '   ', tags: [] },
      ],
      error: null,
    });

    const pack = await getMemoryContext(INPUT);
    const diary = pack.blocks.DIARY!;
    expect(fromCalls).toEqual(expect.arrayContaining(['diary_entries', 'memory_diary_entries']));
    expect(diary.entries.map(e => e.id)).toEqual(['d1', 'd2', 'md1']);
    expect(diary.entries[0].category_key).toBe('health');
    expect(diary.entries[1].category_key).toBe('diary');
    expect(diary.entries[0].content).toBe('Slept badly, knee hurts');
  });

  it('one missing table does not blank the other', async () => {
    tableResponses.set('memory_diary_entries', { data: null, error: { message: 'relation does not exist' } });
    tableResponses.set('diary_entries', {
      data: [{ id: 'd1', created_at: '2026-09-22T07:00:00Z', text: 'Only app diary', tags: null }],
      error: null,
    });
    const pack = await getMemoryContext(INPUT);
    expect(pack.blocks.DIARY!.entries.map(e => e.id)).toEqual(['d1']);
  });
});
