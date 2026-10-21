// VTID-04390 — one diary write path.
const mockWrite = jest.fn();
jest.mock('../../../src/services/orb-memory-bridge', () => ({ writeMemoryItemWithIdentity: (...a: any[]) => mockWrite(...a) }));
const mockExtract = jest.fn();
const mockPersist = jest.fn();
jest.mock('../../../src/services/diary-health-extractor', () => ({
  extractHealthFeaturesFromDiary: (...a: any[]) => mockExtract(...a),
  persistDiaryHealthFeatures: (...a: any[]) => mockPersist(...a),
}));
jest.mock('../../../src/routes/memory-repository', () => ({
  fetchVitanaIndexScoreRow: jest.fn(async () => ({ data: { score_total: 60, score_sleep: 10 } })),
  recomputeVitanaIndexForUser: jest.fn(async () => ({ data: { score_total: 63, score_sleep: 13, score_nutrition: 0, score_hydration: 0, score_exercise: 0, score_mental: 0 } })),
  fetchUserTenantId: jest.fn(async () => ({ data: { tenant_id: 'tt' } })),
}));
jest.mock('../../../src/services/diary-streak-celebrator', () => ({ celebrateDiaryStreak: jest.fn(async () => ({ days: 3 })) }));
jest.mock('../../../src/services/memory/remember', () => ({ rememberFact: jest.fn() }));

import { normalizeDiaryInput, diaryCategoryFromTags, saveDiaryEntry, deleteDiaryEntry } from '../../../src/services/memory/diary';

function admin(opts: { insertError?: any; deleted?: any[] } = {}) {
  const log: any[] = [];
  return {
    log,
    from(table: string) {
      const calls: any[] = [];
      log.push({ table, calls });
      const b: any = {};
      for (const m of ['insert', 'select', 'single', 'delete', 'eq']) b[m] = (...a: any[]) => { calls.push({ m, a }); return b; };
      b.then = (res: any) => {
        let r: any = { data: null, error: null };
        if (table === 'diary_entries' && calls.some((c) => c.m === 'insert')) r = opts.insertError ? { data: null, error: opts.insertError } : { data: { id: 'd1', created_at: '2026-09-23T08:00:00Z' }, error: null };
        if (table === 'diary_entries' && calls.some((c) => c.m === 'delete')) r = { data: opts.deleted ?? [{ id: 'd1' }], error: null };
        return Promise.resolve(r).then(res);
      };
      return b;
    },
  } as any;
}
const ID = { user_id: 'u1', tenant_id: 't1' };

beforeEach(() => {
  mockWrite.mockReset().mockResolvedValue({ ok: true, id: 'mi1' });
  mockExtract.mockReset().mockReturnValue([{ feature: 'sleep_hours', value: 6 }]);
  mockPersist.mockReset().mockResolvedValue({ written: 1 });
});

describe('normalizeDiaryInput', () => {
  it('requires a known source and some content', () => {
    expect(normalizeDiaryInput({ text: 'x', source: 'fax' })).toEqual({ ok: false, error: 'INVALID_SOURCE' });
    expect(normalizeDiaryInput({ text: '  ', source: 'text' })).toEqual({ ok: false, error: 'EMPTY_ENTRY' });
    expect(normalizeDiaryInput({ text: '', source: 'photo', attachments: ['u'] }).ok).toBe(true);
    expect(normalizeDiaryInput({ text: 'a'.repeat(10_001), source: 'text' })).toEqual({ ok: false, error: 'TOO_LONG' });
  });
  it('keeps only sane tags, duration and date', () => {
    const r: any = normalizeDiaryInput({ text: ' slept badly ', source: 'voice', tags: ['health-wellness', 5], duration: 12.6, entry_date: 'nope' });
    expect(r.input).toEqual({ text: 'slept badly', source: 'voice', tags: ['health-wellness'], duration: 13, attachments: null, entry_date: undefined });
  });
});

it('diaryCategoryFromTags maps Garden ids (dash or underscore) and defaults to notes', () => {
  expect(diaryCategoryFromTags(['diary', 'health-wellness'])).toBe('health_wellness');
  expect(diaryCategoryFromTags(['diary', 'text'])).toBe('notes');
  expect(diaryCategoryFromTags(undefined)).toBe('notes');
});

describe('saveDiaryEntry', () => {
  it('writes the diary row, one diary episode and syncs the Index', async () => {
    const a = admin();
    const r = await saveDiaryEntry(a, ID, { text: 'Slept 6 hours, felt tired', source: 'text', tags: ['diary', 'health-wellness'] });
    expect(r.ok).toBe(true);
    expect(r.entry).toEqual({ id: 'd1', created_at: '2026-09-23T08:00:00Z' });
    expect(r.memory_item_id).toBe('mi1');
    const ins = a.log.find((l: any) => l.table === 'diary_entries').calls.find((c: any) => c.m === 'insert').a[0];
    expect(ins).toMatchObject({ user_id: 'u1', text: 'Slept 6 hours, felt tired', source: 'text', tags: ['diary', 'health-wellness'] });
    const [identity, item] = mockWrite.mock.calls[0];
    expect(identity).toEqual({ tenant_id: 't1', user_id: 'u1', active_role: null });
    expect(item.importance).toBeLessThanOrEqual(50); // trg_notify_memory_garden fires above 50
    expect(item).toMatchObject({ source: 'diary', category_key: 'health_wellness', skipFiltering: true, content_json: { kind: 'diary', diary_entry_id: 'd1', diary_source: 'text' } });
    expect(r.index).toMatchObject({ health_features_written: 1, index_delta: { total: 3, sleep: 3 } });
  });

  it('a photo-only entry is saved without an episode or Index sync', async () => {
    const r = await saveDiaryEntry(admin(), ID, { text: '', source: 'photo', attachments: ['https://x/y.jpg'] });
    expect(r.ok).toBe(true);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(r.index).toBeNull();
  });

  it('an episode failure does not fail the save', async () => {
    mockWrite.mockResolvedValue({ ok: false, error: 'db' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await saveDiaryEntry(admin(), ID, { text: 'hello diary', source: 'manual' });
    expect(r.ok).toBe(true);
    expect(r.memory_item_id).toBeNull();
    warn.mockRestore();
  });

  it('a diary insert failure is reported, nothing else runs', async () => {
    const r = await saveDiaryEntry(admin({ insertError: { message: 'rls' } }), ID, { text: 'x y z', source: 'text' });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('deleteDiaryEntry', () => {
  it('deletes the diary row and its episode, scoped to the user', async () => {
    const a = admin();
    expect(await deleteDiaryEntry(a, ID, 'd1')).toEqual({ ok: true });
    const ep = a.log.find((l: any) => l.table === 'memory_items').calls;
    expect(ep).toEqual(expect.arrayContaining([{ m: 'eq', a: ['content_json->>diary_entry_id', 'd1'] }, { m: 'eq', a: ['user_id', 'u1'] }]));
  });
  it('404 when the row is not the user\'s', async () => {
    expect(await deleteDiaryEntry(admin({ deleted: [] }), ID, 'dx')).toMatchObject({ ok: false, status: 404 });
  });
});
