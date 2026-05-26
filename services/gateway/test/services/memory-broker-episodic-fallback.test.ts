// VTID-03156 — unit tests for the legacy episodic fallback ladder
// the memory broker absorbed from `context-pack-builder.ts`
// (CPB-1 / CPB-2).
//
// Contract under test, exercised through the public `getMemoryContext`
// entry-point with `required_blocks: ['EPISODIC']`:
//
//   Step 1: mem_episodes_semantic_search RPC (when query.length > 5).
//           If it returns ≥ 1 hit → block.source === 'mem_episodes', stop.
//   Step 2: mem_episodes recency-order select.
//           If it returns ≥ 1 hit → block.source === 'mem_episodes', stop.
//   Step 3: memory_semantic_search RPC (when query.length > 5).
//           Only fires after steps 1+2 produced 0 hits.
//           If ≥ 1 hit → block.source === 'memory_items_semantic', stop.
//   Step 4: memory_items REST select (importance + recency order).
//           Only fires after step 3 produced 0 hits.
//           Always returns a block (possibly empty) → source === 'memory_items_rest'.
//
// Plus error tolerance: when an individual step fails (RPC error or
// embedding failure) the broker falls through to the next step.

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// ---------------------------------------------------------------------------

interface SupabaseMockResponse {
  data: unknown;
  error: { message: string } | null;
}

function createSupabaseMock() {
  const tableResponses = new Map<string, SupabaseMockResponse>();
  const rpcResponses = new Map<string, SupabaseMockResponse>();
  let currentTable: string | null = null;
  let currentRpc: string | null = null;
  // Track the order in which from/rpc were invoked so tests can
  // verify that step N actually fired only when expected.
  const calls: Array<{ kind: 'from'; arg: string } | { kind: 'rpc'; arg: string }> = [];

  const chain: any = {};
  const passThru = () => chain;
  for (const m of [
    'select', 'eq', 'is', 'gte', 'gt', 'lte', 'lt',
    'order', 'limit', 'filter', 'in', 'match', 'contains',
    'range', 'single', 'maybeSingle', 'neq', 'like', 'ilike',
  ]) {
    chain[m] = jest.fn(passThru);
  }
  chain.from = jest.fn((t: string) => {
    currentTable = t;
    calls.push({ kind: 'from', arg: t });
    return chain;
  });
  chain.rpc = jest.fn((n: string, _args?: unknown) => {
    currentRpc = n;
    calls.push({ kind: 'rpc', arg: n });
    return chain;
  });
  chain.then = jest.fn((resolve: (v: SupabaseMockResponse) => unknown) => {
    let r: SupabaseMockResponse;
    if (currentRpc) {
      r = rpcResponses.get(currentRpc) ?? { data: [], error: null };
      currentRpc = null;
    } else if (currentTable) {
      r = tableResponses.get(currentTable) ?? { data: [], error: null };
      currentTable = null;
    } else {
      r = { data: [], error: null };
    }
    return Promise.resolve(r).then(resolve);
  });

  return {
    chain,
    setTable(t: string, r: SupabaseMockResponse) { tableResponses.set(t, r); },
    setRpc(n: string, r: SupabaseMockResponse) { rpcResponses.set(n, r); },
    calls,
    reset() {
      tableResponses.clear();
      rpcResponses.clear();
      currentTable = null;
      currentRpc = null;
      calls.length = 0;
    },
  };
}

const supabaseMock = createSupabaseMock();

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => supabaseMock.chain),
}));

jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn(async () => ({ ok: true, embedding: [0.1, 0.2, 0.3] })),
}));

// Importing memory-broker drags in its own EPISODIC pipeline and
// the public entrypoint `getMemoryContext`.
import { getMemoryContext } from '../../src/services/memory-broker';
import { generateEmbedding } from '../../src/services/embedding-service';

const mockedEmbedding = generateEmbedding as jest.MockedFunction<typeof generateEmbedding>;

const INPUT = {
  tenant_id: 'tenant-aaa',
  user_id: 'user-bbb',
  intent: 'recall_history' as const,
  channel: 'conversation' as const,
  role: 'community',
  latency_budget_ms: 2000,
  required_blocks: ['EPISODIC' as const],
};

beforeEach(() => {
  supabaseMock.reset();
  mockedEmbedding.mockReset();
  mockedEmbedding.mockResolvedValue({ ok: true, embedding: [0.1, 0.2, 0.3] } as any);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function episodicHit(id: string, occurred_at = '2026-05-26T00:00:00Z') {
  return {
    id,
    kind: 'utterance',
    content: `content for ${id}`,
    category_key: 'cat',
    source: 'conversation',
    importance: 50,
    occurred_at,
    actor_id: 'user-bbb',
    conversation_id: null,
  };
}

function memoryItemRow(id: string) {
  // The legacy memory_items table is column-thinner than mem_episodes
  // (no actor_id / conversation_id). The broker synthesises those.
  return {
    id,
    category_key: 'cat',
    content: `legacy content for ${id}`,
    importance: 70,
    occurred_at: '2026-05-25T00:00:00Z',
    source: 'voice',
  };
}

// ---------------------------------------------------------------------------
// Fallback-ladder tests
// ---------------------------------------------------------------------------

describe('VTID-03156 memory-broker episodic fallback ladder', () => {
  it('Step 1 — mem_episodes_semantic_search returns hits → block.source=mem_episodes; no legacy calls', async () => {
    supabaseMock.setRpc('mem_episodes_semantic_search', {
      data: [episodicHit('ep-1'), episodicHit('ep-2')],
      error: null,
    });
    const pack = await getMemoryContext({ ...INPUT, query: 'a meaningful query string' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.source).toBe('mem_episodes');
    expect(ep!.hits).toHaveLength(2);

    const rpcs = supabaseMock.calls.filter(c => c.kind === 'rpc').map(c => c.arg);
    expect(rpcs).toContain('mem_episodes_semantic_search');
    // Step 3 (legacy RPC) must not fire.
    expect(rpcs).not.toContain('memory_semantic_search');
    // Steps 2/4 (table reads) must not fire.
    const fromCalls = supabaseMock.calls.filter(c => c.kind === 'from').map(c => c.arg);
    expect(fromCalls).not.toContain('mem_episodes');
    expect(fromCalls).not.toContain('memory_items');
  });

  it('Step 2 — semantic empty, mem_episodes recency has hits → source=mem_episodes; no legacy calls', async () => {
    supabaseMock.setRpc('mem_episodes_semantic_search', { data: [], error: null });
    supabaseMock.setTable('mem_episodes', {
      data: [episodicHit('ep-3'), episodicHit('ep-4'), episodicHit('ep-5')],
      error: null,
    });
    const pack = await getMemoryContext({ ...INPUT, query: 'another long-enough query' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.source).toBe('mem_episodes');
    expect(ep!.hits).toHaveLength(3);

    const fromCalls = supabaseMock.calls.filter(c => c.kind === 'from').map(c => c.arg);
    expect(fromCalls).toContain('mem_episodes');
    expect(fromCalls).not.toContain('memory_items');
    const rpcs = supabaseMock.calls.filter(c => c.kind === 'rpc').map(c => c.arg);
    expect(rpcs).not.toContain('memory_semantic_search');
  });

  it('Step 3 — mem_episodes empty, memory_semantic_search returns hits → source=memory_items_semantic', async () => {
    supabaseMock.setRpc('mem_episodes_semantic_search', { data: [], error: null });
    supabaseMock.setTable('mem_episodes', { data: [], error: null });
    supabaseMock.setRpc('memory_semantic_search', {
      data: [memoryItemRow('mi-1'), memoryItemRow('mi-2')],
      error: null,
    });
    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.source).toBe('memory_items_semantic');
    expect(ep!.hits).toHaveLength(2);
    expect(ep!.hits[0].id).toBe('mi-1');
    // memory_items rows have no actor_id column — the broker should
    // surface a stable provenance label rather than null/undefined.
    expect(ep!.hits[0].actor_id).toBe('memory_items');
    expect(ep!.hits[0].kind).toBe('utterance');

    // Step 4 (REST) must not fire.
    const fromCalls = supabaseMock.calls.filter(c => c.kind === 'from').map(c => c.arg);
    expect(fromCalls).not.toContain('memory_items');
  });

  it('Step 4 — every earlier step empty → memory_items REST → source=memory_items_rest', async () => {
    supabaseMock.setRpc('mem_episodes_semantic_search', { data: [], error: null });
    supabaseMock.setTable('mem_episodes', { data: [], error: null });
    supabaseMock.setRpc('memory_semantic_search', { data: [], error: null });
    supabaseMock.setTable('memory_items', {
      data: [memoryItemRow('mi-3'), memoryItemRow('mi-4')],
      error: null,
    });
    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.source).toBe('memory_items_rest');
    expect(ep!.hits).toHaveLength(2);
    expect(ep!.hits.map(h => h.id)).toEqual(['mi-3', 'mi-4']);
  });

  it('Short queries skip both semantic steps; ladder goes recency → REST', async () => {
    // query.length ≤ 5 → semantic gates close. mem_episodes recency is
    // empty so the broker falls through directly to memory_items REST.
    supabaseMock.setTable('mem_episodes', { data: [], error: null });
    supabaseMock.setTable('memory_items', { data: [memoryItemRow('mi-5')], error: null });

    const pack = await getMemoryContext({ ...INPUT, query: 'hi' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.source).toBe('memory_items_rest');
    expect(ep!.hits).toHaveLength(1);

    // Neither RPC was called.
    const rpcs = supabaseMock.calls.filter(c => c.kind === 'rpc').map(c => c.arg);
    expect(rpcs).not.toContain('mem_episodes_semantic_search');
    expect(rpcs).not.toContain('memory_semantic_search');
  });

  it('Embedding failure does not stop the ladder — it falls through to recency', async () => {
    mockedEmbedding.mockResolvedValueOnce({ ok: false, error: 'down' } as any);
    supabaseMock.setTable('mem_episodes', { data: [episodicHit('ep-6')], error: null });

    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query string' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.source).toBe('mem_episodes');
    expect(ep!.hits).toHaveLength(1);
  });

  it('RPC error on mem_episodes_semantic_search falls through to recency', async () => {
    supabaseMock.setRpc('mem_episodes_semantic_search', {
      data: null,
      error: { message: 'rpc down' },
    });
    supabaseMock.setTable('mem_episodes', { data: [episodicHit('ep-7')], error: null });

    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query string' });
    const ep = pack.blocks.EPISODIC;
    expect(ep!.source).toBe('mem_episodes');
    expect(ep!.hits).toHaveLength(1);
  });

  it('All steps empty → returns the empty mem_episodes block, never throws', async () => {
    // mem_episodes recency returns 0 → the broker tries legacy semantic
    // (returns 0) → REST returns 0. Final block should be the empty
    // mem_episodes recency block (the "last-resort" branch).
    supabaseMock.setRpc('mem_episodes_semantic_search', { data: [], error: null });
    supabaseMock.setTable('mem_episodes', { data: [], error: null });
    supabaseMock.setRpc('memory_semantic_search', { data: [], error: null });
    supabaseMock.setTable('memory_items', { data: [], error: null });

    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query string' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.hits).toEqual([]);
  });
});
