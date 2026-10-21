// VTID-04391 — one daily_learning episode per user per local day.
const mockRouter = jest.fn();
jest.mock('../../../src/services/llm-router', () => ({ callViaRouter: (...a: any[]) => mockRouter(...a) }));
jest.mock('../../../src/services/memory-embedding', () => ({ embedMemoryText: jest.fn(async () => ({ ok: false })), toPgVector: jest.fn() }));

import {
  localDate,
  renderDay,
  cleanLearning,
  gatherDay,
  writeDailyLearning,
  MAX_DAY_INPUT_CHARS,
  MAX_LEARNING_CHARS,
  type DayItem,
} from '../../../src/services/memory/daily-learning';

function sb(tables: Record<string, (calls: any[]) => any>) {
  const log: any[] = [];
  return {
    log,
    from(table: string) {
      const calls: any[] = [];
      log.push({ table, calls });
      const b: any = {};
      for (const m of ['select', 'eq', 'is', 'gte', 'neq', 'or', 'in', 'order', 'limit', 'insert', 'single']) b[m] = (...a: any[]) => { calls.push({ m, a }); return b; };
      b.then = (res: any) => Promise.resolve((tables[table] ?? (() => ({ data: [], error: null })))(calls)).then(res);
      return b;
    },
  } as any;
}
const ID = { tenant_id: 't1', user_id: 'u1' };
const ITEMS: DayItem[] = [
  { kind: 'session_summary', text: 'The user said they slept badly.', at: '2026-09-23T09:00:00Z' },
  { kind: 'diary', text: 'Skipped my walk,  too tired.', at: '2026-09-23T08:00:00Z' },
];

beforeEach(() => mockRouter.mockReset().mockResolvedValue({ ok: true, text: 'The user slept badly and skipped the walk.', provider: 'bedrock' }));

it('localDate is the user\'s calendar date, not UTC', () => {
  const at = new Date('2026-09-23T23:30:00Z');
  expect(localDate(at, 'UTC')).toBe('2026-09-23');
  expect(localDate(at, 'Europe/Berlin')).toBe('2026-09-24');
  expect(localDate(at, 'America/New_York')).toBe('2026-09-23');
});

it('renderDay orders oldest first, labels each line and caps the input', () => {
  expect(renderDay(ITEMS)).toBe('Diary: Skipped my walk, too tired.\nConversation: The user said they slept badly.');
  const long = renderDay([{ kind: 'diary', text: 'x'.repeat(MAX_DAY_INPUT_CHARS * 2), at: 'a' }]);
  expect(long.length).toBe(MAX_DAY_INPUT_CHARS);
});

it('cleanLearning drops NONE and caps the length', () => {
  expect(cleanLearning('NONE')).toBeNull();
  expect(cleanLearning(' "ok." ')).toBe('ok.');
  expect(cleanLearning('y'.repeat(2000))!.length).toBe(MAX_LEARNING_CHARS);
});

it('gatherDay keeps only items of the requested local date', async () => {
  const c = sb({
    memory_items: () => ({ data: [
      { content: 'yesterday', category_key: 'session_summary', source: 'system', occurred_at: '2026-09-22T10:00:00Z' },
      { content: 'today diary', category_key: 'notes', source: 'diary', occurred_at: '2026-09-23T10:00:00Z' },
    ], error: null }),
    memory_facts: () => ({ data: [{ fact_key: 'user_sleep_duration', fact_value: '5h', extracted_at: '2026-09-23T11:00:00Z' }], error: null }),
  });
  const out = await gatherDay(c, ID, '2026-09-23', 'UTC', new Date('2026-09-23T21:00:00Z'));
  expect(out).toEqual([
    { kind: 'diary', text: 'today diary', at: '2026-09-23T10:00:00Z' },
    { kind: 'fact', text: 'user sleep duration: 5h', at: '2026-09-23T11:00:00Z' },
  ]);
});

describe('writeDailyLearning', () => {
  it('writes one localized episode with the date and importance <= 50', async () => {
    let row: any = null;
    const c = sb({ memory_items: (calls) => {
      const ins = calls.find((x: any) => x.m === 'insert');
      if (ins) { row = ins.a[0]; return { data: { id: 'dl1' }, error: null }; }
      return { data: [], error: null };
    } });
    const r = await writeDailyLearning(c, ID, '2026-09-23', ITEMS, { locale: 'de' });
    expect(r).toMatchObject({ status: 'written', id: 'dl1' });
    expect(mockRouter.mock.calls[0][0]).toBe('memory');
    expect(mockRouter.mock.calls[0][2].systemPrompt).toMatch(/^LANGUAGE: Respond ONLY in German/);
    expect(row).toMatchObject({ category_key: 'daily_learning', source: 'system', content_json: { kind: 'daily_learning', date: '2026-09-23', inputs: { diary: 1, sessions: 1, facts: 0 } } });
    expect(row.importance).toBeLessThanOrEqual(50); // trg_notify_memory_garden fires above 50
  });

  it('nothing for an empty day, no model call', async () => {
    expect(await writeDailyLearning(sb({}), ID, 'd', [])).toEqual({ status: 'nothing_to_learn' });
    expect(mockRouter).not.toHaveBeenCalled();
  });

  it('already written for that date: no model call', async () => {
    const c = sb({ memory_items: () => ({ data: [{ id: 'x' }], error: null }) });
    expect(await writeDailyLearning(c, ID, 'd', ITEMS)).toEqual({ status: 'already_written' });
    expect(mockRouter).not.toHaveBeenCalled();
  });

  it('shadow mode computes but writes nothing; NONE writes nothing', async () => {
    const c = sb({});
    expect(await writeDailyLearning(c, ID, 'd', ITEMS, { shadow: true })).toEqual({ status: 'shadow' });
    mockRouter.mockResolvedValue({ ok: true, text: 'NONE' });
    expect(await writeDailyLearning(c, ID, 'd', ITEMS)).toEqual({ status: 'nothing_to_learn' });
    expect(c.log.some((l: any) => l.calls.some((x: any) => x.m === 'insert'))).toBe(false);
  });

  it('a concurrent insert (23505) is already written; a router failure is reported', async () => {
    const c = sb({ memory_items: (calls) => calls.some((x: any) => x.m === 'insert') ? { data: null, error: { message: 'duplicate key value violates unique constraint' } } : { data: [], error: null } });
    expect(await writeDailyLearning(c, ID, 'd', ITEMS)).toEqual({ status: 'already_written' });
    mockRouter.mockResolvedValue({ ok: false, error: 'down' });
    expect(await writeDailyLearning(c, ID, 'd', ITEMS)).toEqual({ status: 'llm_failed', error: 'down' });
  });
});
