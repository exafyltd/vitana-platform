/**
 * Diary + Memory voice tools (VTID-02757) — unit tests.
 *
 * Mocked SupabaseClient (no network). Per tool: happy path with speakable
 * text containing the actual content, plus the unauthenticated gate and the
 * key edge states (empty diary, broken streak, confirm-gated delete).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  tool_list_diary_entries,
  tool_get_diary_streak,
  tool_get_memory_timeline,
  tool_recall_memory_about,
  tool_get_memory_garden_summary,
  tool_forget_memory,
  DIARY_MEMORY_TOOL_HANDLERS,
  DIARY_MEMORY_TOOL_DECLARATIONS,
} from '../../src/services/orb-tools/diary-memory-tools';

const IDENT: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const NO_USER: OrbToolIdentity = { user_id: '', tenant_id: 't-1', role: null };
const NO_TENANT: OrbToolIdentity = { user_id: 'u-1', tenant_id: null, role: null };

// ---------------------------------------------------------------------------
// Chainable fake SupabaseClient
// ---------------------------------------------------------------------------

interface TableResult {
  data?: unknown;
  error?: { message: string } | null;
}

interface CallRecord {
  table: string;
  op: 'select' | 'insert' | 'delete';
  filters: Array<Record<string, unknown>>;
  inserted?: unknown;
}

type TableConfig = TableResult | ((call: CallRecord) => TableResult);

function fakeSb(config: Record<string, TableConfig>) {
  const calls: CallRecord[] = [];
  const client = {
    from(table: string) {
      const call: CallRecord = { table, op: 'select', filters: [] };
      calls.push(call);
      const resolveVal = () => {
        const cfg = config[table];
        const res = typeof cfg === 'function' ? cfg(call) : cfg ?? { data: [], error: null };
        return { data: res.data ?? null, error: res.error ?? null };
      };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.gte = chain;
      builder.lte = chain;
      builder.is = chain;
      builder.ilike = chain;
      builder.eq = (k: string, v: unknown) => {
        call.filters.push({ [k]: v });
        return builder;
      };
      builder.in = (k: string, v: unknown) => {
        call.filters.push({ [`in:${k}`]: v });
        return builder;
      };
      builder.insert = (row: unknown) => {
        call.op = 'insert';
        call.inserted = row;
        return builder;
      };
      builder.delete = () => {
        call.op = 'delete';
        return builder;
      };
      builder.maybeSingle = () => Promise.resolve(resolveVal());
      builder.then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(resolveVal()).then(onFulfilled, onRejected);
      return builder;
    },
  };
  return { sb: client as unknown as SupabaseClient, calls };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('diary-memory-tools module shape', () => {
  const NAMES = [
    'list_diary_entries',
    'get_diary_streak',
    'get_memory_timeline',
    'recall_memory_about',
    'get_memory_garden_summary',
    'forget_memory',
  ];

  it.each(NAMES)('%s has a handler and a declaration', (name) => {
    expect(typeof DIARY_MEMORY_TOOL_HANDLERS[name]).toBe('function');
    expect(DIARY_MEMORY_TOOL_DECLARATIONS.find((d) => d.name === name)).toBeDefined();
  });

  it('declarations avoid Vertex-rejected OpenAPI keys (default/minimum/maximum/format)', () => {
    const json = JSON.stringify(DIARY_MEMORY_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
      expect(json).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// list_diary_entries
// ---------------------------------------------------------------------------

describe('tool_list_diary_entries', () => {
  it('lists entries newest first with speakable content', async () => {
    const { sb } = fakeSb({
      diary_entries: {
        data: [
          { id: 'd-2', text: 'Ran 5km in the park and felt great', source: 'voice', tags: ['diary'], created_at: isoDaysAgo(0) },
          { id: 'd-1', text: 'Drank 2 liters of water today', source: 'voice', tags: ['diary'], created_at: isoDaysAgo(1) },
        ],
      },
    });
    const res = await tool_list_diary_entries({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('2 diary entries');
    expect(res.text).toContain('Ran 5km in the park');
    expect(res.text).toContain('Drank 2 liters of water');
    expect((res.result as { count: number }).count).toBe(2);
  });

  it('empty diary answers plainly and offers to log', async () => {
    const { sb } = fakeSb({ diary_entries: { data: [] } });
    const res = await tool_list_diary_entries(
      { date_from: '2026-06-01', date_to: '2026-06-30' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no diary entries');
    expect(res.text).toContain('2026-06-01');
  });

  it('rejects malformed dates', async () => {
    const { sb } = fakeSb({ diary_entries: { data: [] } });
    const res = await tool_list_diary_entries({ date_from: 'last week' }, IDENT, sb);
    expect(res.ok).toBe(false);
  });

  it('requires an authenticated user', async () => {
    const { sb } = fakeSb({ diary_entries: { data: [] } });
    const res = await tool_list_diary_entries({}, NO_USER, sb);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('authenticated');
  });

  it('surfaces DB errors as ok:false without throwing', async () => {
    const { sb } = fakeSb({ diary_entries: { error: { message: 'db down' } } });
    const res = await tool_list_diary_entries({}, IDENT, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_diary_streak
// ---------------------------------------------------------------------------

describe('tool_get_diary_streak', () => {
  it('computes current streak (today+yesterday) and longest run across a gap', async () => {
    const { sb } = fakeSb({
      diary_entries: {
        data: [
          { created_at: isoDaysAgo(0) },
          { created_at: isoDaysAgo(0) }, // duplicate same day — counts once
          { created_at: isoDaysAgo(1) },
          // gap of 2+ days breaks the streak
          { created_at: isoDaysAgo(10) },
          { created_at: isoDaysAgo(11) },
          { created_at: isoDaysAgo(12) },
        ],
      },
    });
    const res = await tool_get_diary_streak({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result as { current_streak_days: number; longest_streak_days: number };
    expect(r.current_streak_days).toBe(2);
    expect(r.longest_streak_days).toBe(3);
    expect(res.text).toContain('2 consecutive days');
    expect(res.text).toContain('3 days');
  });

  it('broken streak reports the last entry day honestly', async () => {
    const { sb } = fakeSb({
      diary_entries: { data: [{ created_at: isoDaysAgo(5) }, { created_at: isoDaysAgo(6) }] },
    });
    const res = await tool_get_diary_streak({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as { current_streak_days: number }).current_streak_days).toBe(0);
    expect(res.text).toContain('broken');
  });

  it('no entries yet — zero streak with encouragement, not an error', async () => {
    const { sb } = fakeSb({ diary_entries: { data: [] } });
    const res = await tool_get_diary_streak({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no diary entries');
  });

  it('requires an authenticated user', async () => {
    const { sb } = fakeSb({ diary_entries: { data: [] } });
    const res = await tool_get_diary_streak({}, NO_USER, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_memory_timeline
// ---------------------------------------------------------------------------

describe('tool_get_memory_timeline', () => {
  it('merges memory items, facts, and diary entries newest first', async () => {
    const { sb } = fakeSb({
      memory_items: {
        data: [
          { id: 'm-1', category_key: 'health', source: 'orb_voice', content: 'Started a new sleep routine', occurred_at: isoDaysAgo(3) },
        ],
      },
      memory_facts: {
        data: [
          { id: 'f-1', fact_key: 'fiancee_name', fact_value: 'Mariia', extracted_at: isoDaysAgo(2) },
        ],
      },
      diary_entries: {
        data: [{ id: 'd-1', text: 'Morning yoga for 30 minutes', created_at: isoDaysAgo(1) }],
      },
    });
    const res = await tool_get_memory_timeline({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const text = res.text as string;
    expect(text).toContain('Morning yoga for 30 minutes');
    expect(text).toContain('fiancee name: Mariia');
    expect(text).toContain('Started a new sleep routine');
    // Newest first: diary (1d) before fact (2d) before item (3d).
    expect(text.indexOf('Morning yoga')).toBeLessThan(text.indexOf('Mariia'));
    expect(text.indexOf('Mariia')).toBeLessThan(text.indexOf('sleep routine'));
    expect((res.result as { count: number }).count).toBe(3);
  });

  it('empty window answers plainly', async () => {
    const { sb } = fakeSb({
      memory_items: { data: [] },
      memory_facts: { data: [] },
      diary_entries: { data: [] },
    });
    const res = await tool_get_memory_timeline(
      { date_from: '2026-01-01', date_to: '2026-01-31' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('No memories');
  });

  it('requires user AND tenant (memory_items is tenant-scoped)', async () => {
    const { sb } = fakeSb({});
    expect((await tool_get_memory_timeline({}, NO_USER, sb)).ok).toBe(false);
    expect((await tool_get_memory_timeline({}, NO_TENANT, sb)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recall_memory_about
// ---------------------------------------------------------------------------

describe('tool_recall_memory_about', () => {
  it('returns facts and memories about the topic, speakable', async () => {
    const { sb } = fakeSb({
      memory_items: {
        data: [
          { id: 'm-1', category_key: 'network_relationships', content: 'My sister Anna lives in Berlin', occurred_at: isoDaysAgo(4) },
        ],
      },
      memory_facts: {
        data: [{ id: 'f-1', fact_key: 'sister_name', fact_value: 'Anna', extracted_at: isoDaysAgo(4) }],
      },
    });
    const res = await tool_recall_memory_about({ topic: 'sister' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('sister name = Anna');
    expect(res.text).toContain('My sister Anna lives in Berlin');
    expect(res.text).toContain('only this content');
  });

  it('deduplicates facts matched by both key and value', async () => {
    const fact = { id: 'f-1', fact_key: 'sister_name', fact_value: 'my sister Anna', extracted_at: isoDaysAgo(1) };
    const { sb } = fakeSb({
      memory_items: { data: [] },
      memory_facts: { data: [fact] }, // same row returned for both ilike queries
    });
    const res = await tool_recall_memory_about({ topic: 'sister' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as { facts: unknown[] }).facts).toHaveLength(1);
  });

  it('expands a garden category to its source categories for the filter', async () => {
    const { sb, calls } = fakeSb({
      memory_items: { data: [] },
      memory_facts: { data: [] },
      memory_category_mapping: {
        data: [
          { source_category: 'health', garden_category: 'health_wellness' },
          { source_category: 'tasks', garden_category: 'business_projects' },
        ],
      },
    });
    const res = await tool_recall_memory_about(
      { topic: 'sleep', category: 'health_wellness' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    const itemCall = calls.find((c) => c.table === 'memory_items');
    const inFilter = itemCall?.filters.find((f) => 'in:category_key' in f);
    expect(inFilter?.['in:category_key']).toEqual(
      expect.arrayContaining(['health_wellness', 'health']),
    );
    expect(inFilter?.['in:category_key']).not.toEqual(expect.arrayContaining(['tasks']));
  });

  it('empty result is honest and forbids invention', async () => {
    const { sb } = fakeSb({ memory_items: { data: [] }, memory_facts: { data: [] } });
    const res = await tool_recall_memory_about({ topic: 'skydiving' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('No stored memories');
    expect(res.text).toContain('do not invent');
  });

  it('requires a topic and an authenticated user+tenant', async () => {
    const { sb } = fakeSb({});
    expect((await tool_recall_memory_about({}, IDENT, sb)).ok).toBe(false);
    expect((await tool_recall_memory_about({ topic: 'x' }, NO_USER, sb)).ok).toBe(false);
    expect((await tool_recall_memory_about({ topic: 'x' }, NO_TENANT, sb)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_memory_garden_summary
// ---------------------------------------------------------------------------

describe('tool_get_memory_garden_summary', () => {
  it('maps source categories to garden categories with labels and counts', async () => {
    const { sb } = fakeSb({
      memory_garden_config: {
        data: [
          { category_key: 'health_wellness', label: 'Health & Wellness', display_order: 2 },
          { category_key: 'business_projects', label: 'Business & Projects', display_order: 6 },
        ],
      },
      memory_category_mapping: {
        data: [
          { source_category: 'health', garden_category: 'health_wellness' },
          { source_category: 'tasks', garden_category: 'business_projects' },
        ],
      },
      memory_items: {
        data: [
          { category_key: 'health' },
          { category_key: 'health' },
          { category_key: 'tasks' },
        ],
      },
    });
    const res = await tool_get_memory_garden_summary({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('3 memories');
    expect(res.text).toContain('Health & Wellness: 2');
    expect(res.text).toContain('Business & Projects: 1');
    const result = res.result as { total: number; categories: Array<{ count: number }> };
    expect(result.total).toBe(3);
    expect(result.categories[0].count).toBe(2); // sorted biggest first
  });

  it('empty garden explains how memories grow', async () => {
    const { sb } = fakeSb({
      memory_garden_config: { data: [] },
      memory_category_mapping: { data: [] },
      memory_items: { data: [] },
    });
    const res = await tool_get_memory_garden_summary({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('empty');
  });

  it('requires user AND tenant', async () => {
    const { sb } = fakeSb({});
    expect((await tool_get_memory_garden_summary({}, NO_USER, sb)).ok).toBe(false);
    expect((await tool_get_memory_garden_summary({}, NO_TENANT, sb)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forget_memory
// ---------------------------------------------------------------------------

describe('tool_forget_memory', () => {
  const ITEM = {
    id: 'm-9',
    category_key: 'notes',
    content: 'I hate mornings',
    occurred_at: isoDaysAgo(2),
  };

  it('without confirm: describes the memory and asks for confirmation (no delete)', async () => {
    const { sb, calls } = fakeSb({
      memory_items: (call) => (call.op === 'select' ? { data: ITEM } : { error: { message: 'should not delete' } }),
    });
    const res = await tool_forget_memory({ memory_id: 'm-9' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('I hate mornings');
    expect(res.text).toContain('confirm=true');
    expect((res.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
    expect(calls.some((c) => c.op === 'delete')).toBe(false);
  });

  it('with confirm=true: deletes the row and writes the memory_deletions ledger', async () => {
    const { sb, calls } = fakeSb({
      memory_items: (call) => (call.op === 'select' ? { data: ITEM } : { data: null, error: null }),
      memory_deletions: { data: null, error: null },
    });
    const res = await tool_forget_memory({ memory_id: 'm-9', confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('forgotten');
    expect(res.text).toContain('I hate mornings');
    const del = calls.find((c) => c.table === 'memory_items' && c.op === 'delete');
    expect(del).toBeDefined();
    // Delete is scoped by id + tenant + user (service role bypasses RLS).
    expect(del?.filters).toEqual(
      expect.arrayContaining([{ id: 'm-9' }, { tenant_id: 't-1' }, { user_id: 'u-1' }]),
    );
    const ledger = calls.find((c) => c.table === 'memory_deletions' && c.op === 'insert');
    expect(ledger).toBeDefined();
    expect((ledger?.inserted as { entity_type: string }).entity_type).toBe('memory_item');
  });

  it('unknown memory_id returns ok:false, not a fake success', async () => {
    const { sb } = fakeSb({ memory_items: { data: null } });
    const res = await tool_forget_memory({ memory_id: 'nope', confirm: true }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('not found');
  });

  it('requires memory_id and an authenticated user+tenant', async () => {
    const { sb } = fakeSb({});
    expect((await tool_forget_memory({}, IDENT, sb)).ok).toBe(false);
    expect((await tool_forget_memory({ memory_id: 'm-1' }, NO_USER, sb)).ok).toBe(false);
    expect((await tool_forget_memory({ memory_id: 'm-1' }, NO_TENANT, sb)).ok).toBe(false);
  });
});
