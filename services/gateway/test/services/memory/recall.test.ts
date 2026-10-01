// VTID-04452 — the ORB live prompt reads memory through one recall().
import { recallOrbMemoryItems, packToRecallItems, isOrbRecallEnabled } from '../../../src/services/memory/recall';
import type { MemoryPack } from '../../../src/services/memory-broker';

const ID = { user_id: 'u1', tenant_id: 't1' };
const T = '2026-09-23T08:00:00Z';

function pack(over: Partial<MemoryPack> = {}): MemoryPack {
  return {
    ok: true,
    intent: 'recall_history',
    blocks: {
      SEMANTIC: {
        kind: 'SEMANTIC',
        source: 'memory_facts',
        fetched_at: T,
        facts: [
          { id: 'f1', fact_key: 'child_name', fact_value: 'Mia', fact_value_type: 'text', entity: 'disclosed', confidence: 0.95, actor_id: 'user_stated', asserted_at: T },
          { id: 'f2', fact_key: 'empty', fact_value: '  ', fact_value_type: 'text', entity: 'self', confidence: 0.9, actor_id: 'x', asserted_at: T },
        ],
      },
      EPISODIC: {
        kind: 'EPISODIC',
        source: 'memory_items_rest',
        fetched_at: T,
        hits: [
          { id: 'e1', kind: 'utterance', content: 'Knee hurt after the run', category_key: 'health_wellness', source: 'session_summary', importance: 40, occurred_at: T, actor_id: 'memory_items', conversation_id: null },
          { id: 'e2', kind: 'utterance', content: '', category_key: null, source: null, importance: 10, occurred_at: T, actor_id: 'memory_items', conversation_id: null },
        ],
      },
      DIARY: {
        kind: 'DIARY',
        source: 'memory_diary_entries',
        fetched_at: T,
        entries: [{ id: 'd1', occurred_at: T, category_key: 'sleep-quality', content: 'Bad sleep' }],
      },
    },
    meta: { streams_hit: ['memory_facts', 'memory_items', 'memory_diary_entries'], latency_ms_per_stream: {}, total_latency_ms: 12, degraded: false, pack_size_bytes: 1, block_count: 3 },
    ...over,
  } as MemoryPack;
}

describe('packToRecallItems', () => {
  it('maps facts, diary and episodes into the bridge item shape and drops empties', () => {
    const r = packToRecallItems(pack());
    expect(r.items.map(i => i.id)).toEqual(['f1', 'd1', 'e1']);
    expect(r.items[0]).toMatchObject({ source: 'memory_facts', content: 'child_name: Mia', importance: 95, category_key: 'personal' });
    expect(r.items[1]).toMatchObject({ source: 'diary', category_key: 'sleep_quality', importance: 60 });
    expect(r.items[2]).toMatchObject({ source: 'session_summary', category_key: 'health_wellness', importance: 40 });
    expect(r).toMatchObject({ facts: 2, episodes: 2, diary: 1 });
  });

  it('never reads ai_memory: no item has that source', () => {
    expect(packToRecallItems(pack()).items.some(i => i.source === 'ai_memory')).toBe(false);
  });
});

describe('recallOrbMemoryItems', () => {
  it('asks the broker for facts, episodes and diary, scoped to the session role', async () => {
    const read = jest.fn(async () => pack());
    const r = await recallOrbMemoryItems({ ...ID, active_role: 'developer' }, { read: read as any, query: 'how is my knee' });
    expect(r.ok).toBe(true);
    const input = (read.mock.calls[0] as any[])[0];
    expect(input).toMatchObject({
      tenant_id: 't1', user_id: 'u1', channel: 'orb-live', role: 'developer',
      lens: { active_role: 'developer' }, query: 'how is my knee',
    });
    expect(input.required_blocks.sort()).toEqual(['DIARY', 'EPISODIC', 'SEMANTIC']);
    expect(input.latency_budget_ms).toBe(1500);
  });

  it('personal session sends no role', async () => {
    const read = jest.fn(async () => pack());
    await recallOrbMemoryItems(ID, { read: read as any });
    const input = (read.mock.calls[0] as any[])[0];
    expect(input.role).toBeUndefined();
    expect(input.lens).toBeUndefined();
  });

  it('reports not-ok when the broker is disabled, so the caller falls back', async () => {
    const r = await recallOrbMemoryItems(ID, { read: (async () => pack({ ok: false, blocks: {}, error: 'memory_broker_disabled' })) as any });
    expect(r).toMatchObject({ ok: false, error: 'memory_broker_disabled', items: [] });
  });

  it('reports not-ok when every section timed out', async () => {
    const r = await recallOrbMemoryItems(ID, { read: (async () => pack({ blocks: {}, meta: { ...pack().meta, degraded: true } })) as any });
    expect(r).toMatchObject({ ok: false, error: 'no_sections_loaded' });
  });

  it('never throws', async () => {
    const r = await recallOrbMemoryItems(ID, { read: (async () => { throw new Error('boom'); }) as any });
    expect(r).toMatchObject({ ok: false, error: 'boom' });
  });

  it('keeps a partial pack (one section loaded) and marks it degraded', async () => {
    const p = pack();
    const r = await recallOrbMemoryItems(ID, {
      read: (async () => ({ ...p, blocks: { SEMANTIC: p.blocks.SEMANTIC }, meta: { ...p.meta, degraded: true } })) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.items.map(i => i.id)).toEqual(['f1']);
  });
});

describe('isOrbRecallEnabled', () => {
  const prev = process.env.MEMORY_ORB_RECALL_ENABLED;
  afterEach(() => { process.env.MEMORY_ORB_RECALL_ENABLED = prev; });
  it('is off unless exactly "true"', () => {
    delete process.env.MEMORY_ORB_RECALL_ENABLED;
    expect(isOrbRecallEnabled()).toBe(false);
    process.env.MEMORY_ORB_RECALL_ENABLED = 'TRUE';
    expect(isOrbRecallEnabled()).toBe(false);
    process.env.MEMORY_ORB_RECALL_ENABLED = 'true';
    expect(isOrbRecallEnabled()).toBe(true);
  });
});
