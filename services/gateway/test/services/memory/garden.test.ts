// VTID-04388 — Memory Garden on the canonical store.

const mockRememberFact = jest.fn();
jest.mock('../../../src/services/memory/remember', () => ({
  rememberFact: (...a: any[]) => mockRememberFact(...a),
}));
jest.mock('../../../src/services/memory-embedding', () => ({
  embedMemoryText: jest.fn(async () => ({ ok: false, error: 'off' })),
  toPgVector: (e: number[]) => `[${e.join(',')}]`,
}));

import {
  gardenCategoryForFactKey,
  gardenCategoryForItem,
  summarizeCategories,
  listGardenEntries,
  addGardenFact,
  addGardenNote,
  deleteGardenEntry,
  editGardenEpisode,
  GARDEN_CATEGORIES,
  _resetGardenCache,
  type GardenEntry,
} from '../../../src/services/memory/garden';

type Resp = { data: any; error: any };

function client(tables: Record<string, Resp | ((calls: any[]) => Resp)>) {
  const log: Array<{ table: string; calls: any[] }> = [];
  return {
    log,
    from(table: string) {
      const calls: any[] = [];
      log.push({ table, calls });
      const b: any = {};
      for (const m of ['select', 'eq', 'is', 'or', 'order', 'limit', 'insert', 'update', 'delete', 'single', 'maybeSingle']) {
        b[m] = (...args: any[]) => { calls.push({ m, args }); return b; };
      }
      b.then = (res: any) => {
        const t = tables[table];
        const r = typeof t === 'function' ? t(calls) : t ?? { data: [], error: null };
        return Promise.resolve(r).then(res);
      };
      return b;
    },
  } as any;
}

const ID = { tenant_id: 't1', user_id: 'u1', active_role: 'community' };
const MAPPING = { data: [{ source_category: 'notes', garden_category: 'uncategorized' }, { source_category: 'health', garden_category: 'health_wellness' }], error: null };

beforeEach(() => { _resetGardenCache(); mockRememberFact.mockReset(); });

describe('categories (D5)', () => {
  it.each([
    ['user_name', 'personal_identity'],
    ['preferred_language', 'personal_identity'],
    ['spouse_name', 'network_relationships'],
    ['friend_name_1', 'network_relationships'],
    ['user_sleep_duration', 'health_wellness'],
    ['user_medication', 'health_wellness'],
    ['user_goal_financial_freedom', 'values_aspirations'],
    ['user_occupation', 'business_projects'],
    ['user_residence', 'location_environment'],
    ['user_favorite_food', 'lifestyle_routines'],
    ['something_else', 'uncategorized'],
  ])('fact %s -> %s', (key, cat) => {
    expect(gardenCategoryForFactKey(key)).toBe(cat);
  });

  it('episodes use the mapping table and fall back to uncategorized', () => {
    const m = new Map([['health', 'health_wellness'], ['notes', 'uncategorized']]);
    expect(gardenCategoryForItem('health', m)).toBe('health_wellness');
    expect(gardenCategoryForItem('health_wellness', m)).toBe('health_wellness');
    expect(gardenCategoryForItem('weird', m)).toBe('uncategorized');
    expect(gardenCategoryForItem(null, m)).toBe('uncategorized');
  });

  it('summary lists all 13 categories with counts and last update', () => {
    const e = (category: any, at: string): GardenEntry => ({ kind: 'fact', id: at, category, content: 'x', source: 's', confidence: 1, user_confirmed: false, occurred_at: at });
    const s = summarizeCategories([e('health_wellness', '2026-01-01'), e('health_wellness', '2026-02-01'), e('personal_identity', '2026-01-05')]);
    expect(s).toHaveLength(GARDEN_CATEGORIES.length);
    expect(s.find((c) => c.category === 'health_wellness')).toEqual({ category: 'health_wellness', count: 2, last_updated_at: '2026-02-01' });
    expect(s.find((c) => c.category === 'finance_assets')!.count).toBe(0);
  });
});

describe('listGardenEntries (D4)', () => {
  it('shows current facts and episodes, never raw conversation turns, newest first', async () => {
    const c = client({
      memory_category_mapping: MAPPING,
      memory_facts: { data: [{ id: 'f1', fact_key: 'user_name', fact_value: 'Dragan', provenance_source: 'user_stated', provenance_confidence: 1, extracted_at: '2026-09-01T00:00:00Z' }], error: null },
      memory_items: { data: [
        { id: 'i1', category_key: 'session_summary', source: 'system', content: 'The user talked about sleep.', content_json: { kind: 'session_summary' }, occurred_at: '2026-09-20T00:00:00Z' },
        { id: 'i2', category_key: 'notes', source: 'orb_voice', content: 'raw turn', content_json: { direction: 'user' }, occurred_at: '2026-09-21T00:00:00Z' },
      ], error: null },
    });
    const out = await listGardenEntries(c, ID);
    expect(out.map((e) => e.id)).toEqual(['i1', 'f1']);
    expect(out[1]).toMatchObject({ kind: 'fact', category: 'personal_identity', content: 'Dragan', user_confirmed: true });
    const facts = c.log.find((l: any) => l.table === 'memory_facts').calls;
    expect(facts).toContainEqual({ m: 'is', args: ['superseded_at', null] });
    expect(facts).toContainEqual({ m: 'eq', args: ['user_id', 'u1'] });
    const items = c.log.find((l: any) => l.table === 'memory_items').calls;
    expect(items).toContainEqual({ m: 'or', args: ['active_role.is.null,active_role.eq.community'] });
  });

  it('filters by category', async () => {
    const c = client({
      memory_category_mapping: MAPPING,
      memory_facts: { data: [
        { id: 'f1', fact_key: 'user_name', fact_value: 'A', provenance_source: 'assistant_inferred', extracted_at: '2026-09-01' },
        { id: 'f2', fact_key: 'user_sleep_duration', fact_value: '6h', provenance_source: 'assistant_inferred', extracted_at: '2026-09-02' },
      ], error: null },
      memory_items: { data: [], error: null },
    });
    const out = await listGardenEntries(c, ID, { category: 'health_wellness' });
    expect(out.map((e) => e.id)).toEqual(['f2']);
  });

  it('throws on a read error so the route can answer 502', async () => {
    const c = client({ memory_category_mapping: MAPPING, memory_facts: { data: null, error: { message: 'x' } }, memory_items: { data: [], error: null } });
    await expect(listGardenEntries(c, ID)).rejects.toThrow('memory_facts');
  });
});

describe('writes', () => {
  it('a user fact goes through rememberFact with the Garden provenance at full confidence', async () => {
    mockRememberFact.mockResolvedValue({ ok: true, fact_id: 'f9' });
    const r = await addGardenFact(client({}), ID, 'User_Favorite_Drink', ' green tea ');
    expect(r).toEqual({ ok: true, id: 'f9' });
    expect(mockRememberFact.mock.calls[0][0]).toMatchObject({
      fact_key: 'user_favorite_drink', fact_value: 'green tea', provenance_source: 'user_stated_via_memory_garden_ui', provenance_confidence: 1, actor: 'memory-garden',
    });
  });

  it('rejects a bad key or empty value, and maps the Identity Lock to 403', async () => {
    expect(await addGardenFact(client({}), ID, 'bad key!', 'v')).toMatchObject({ ok: false, status: 400 });
    expect(await addGardenFact(client({}), ID, 'user_name', '  ')).toMatchObject({ ok: false, status: 400 });
    mockRememberFact.mockResolvedValue({ ok: false, blocked: 'identity_lock', error: 'identity_locked' });
    expect(await addGardenFact(client({}), ID, 'user_name', 'X')).toMatchObject({ ok: false, status: 403, error: 'IDENTITY_LOCKED' });
  });

  it('a note is a memory_items row marked user_stated', async () => {
    let inserted: any = null;
    const c = client({ memory_items: (calls) => { inserted = calls.find((x: any) => x.m === 'insert')?.args[0]; return { data: { id: 'n1' }, error: null }; } });
    const r = await addGardenNote(c, ID, 'I prefer morning walks', 'lifestyle_routines');
    expect(r).toEqual({ ok: true, id: 'n1' });
    expect(inserted.importance).toBeLessThanOrEqual(50); // trg_notify_memory_garden fires above 50
    expect(inserted).toMatchObject({ category_key: 'lifestyle_routines', source: 'upload', active_role: null, content_json: { kind: 'garden_note', provenance: 'user_stated' } });
  });

  it('editing an episode clears its embedding and 404s when nothing matched', async () => {
    let upd: any = null;
    const c = client({ memory_items: (calls) => { upd = calls.find((x: any) => x.m === 'update')?.args[0]; return { data: [], error: null }; } });
    expect(await editGardenEpisode(c, ID, 'x', 'new text')).toMatchObject({ ok: false, status: 404 });
    expect(upd).toMatchObject({ content: 'new text', embedding: null });
  });

  it('an episode can be moved to another category', async () => {
    let upd: any = null;
    const c = client({ memory_items: (calls) => { upd = calls.find((x: any) => x.m === 'update')?.args[0]; return { data: [{ id: 'e1', content_json: {} }], error: null }; } });
    expect(await editGardenEpisode(c, ID, 'e1', 'text', 'future_plans')).toEqual({ ok: true, id: 'e1' });
    expect(upd.category_key).toBe('future_plans');
  });

  it('editing a diary episode updates its diary row too', async () => {
    const c = client({ memory_items: { data: [{ id: 'e1', content_json: { diary_entry_id: 'd7' } }], error: null } });
    await editGardenEpisode(c, ID, 'e1', 'new diary text');
    const diary = c.log.find((l: any) => l.table === 'diary_entries');
    expect(diary.calls).toEqual(expect.arrayContaining([{ m: 'update', args: [{ text: 'new diary text' }] }, { m: 'eq', args: ['id', 'd7'] }]));
  });

  it('forgetting a fact deletes every row of its key for this user only', async () => {
    const deletes: any[] = [];
    const c = client({
      memory_facts: (calls) => {
        if (calls.some((x: any) => x.m === 'delete')) { deletes.push(calls); return { data: null, error: null }; }
        return { data: { fact_key: 'spouse_name' }, error: null };
      },
    });
    expect(await deleteGardenEntry(c, ID, 'fact', 'f1')).toEqual({ ok: true, id: 'f1' });
    expect(deletes[0]).toEqual(expect.arrayContaining([
      { m: 'eq', args: ['tenant_id', 't1'] },
      { m: 'eq', args: ['user_id', 'u1'] },
      { m: 'eq', args: ['fact_key', 'spouse_name'] },
    ]));
  });

  it('forgetting an unknown fact is 404 and deletes nothing', async () => {
    const c = client({ memory_facts: { data: null, error: null } });
    expect(await deleteGardenEntry(c, ID, 'fact', 'nope')).toMatchObject({ ok: false, status: 404 });
    expect(c.log.filter((l: any) => l.calls.some((x: any) => x.m === 'delete'))).toHaveLength(0);
  });
});
