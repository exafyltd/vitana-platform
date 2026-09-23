// VTID-03156 / VTID-04342 — unit tests for the memory broker's episodic
// ladder, exercised through `getMemoryContext` with
// `required_blocks: ['EPISODIC']`.
//
// Contract (VTID-04366 — memory_items is the only episodic store):
//   Step 1: memory_semantic_search RPC on memory_items (query.length > 5),
//           query embedded with the memory embedder (Titan V2).
//           ≥ 1 hit → block.source === 'memory_items_semantic', stop.
//   Step 2: memory_items REST select (importance + recency order).
//           → source === 'memory_items_rest'.
// The tier-2 mem_episodes mirror is never read.
// VTID-04367: both steps are role-scoped (p_active_role / an `or` filter).
// Error tolerance: a failing step (RPC error, embedding failure) falls
// through to the next step.

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
  const calls: Array<{ kind: 'from' | 'rpc' | 'or'; arg: string; args?: any }> = [];

  const chain: any = {};
  const passThru = () => chain;
  for (const m of [
    'select', 'eq', 'is', 'gte', 'gt', 'lte', 'lt',
    'order', 'limit', 'filter', 'in', 'match', 'contains',
    'range', 'single', 'maybeSingle', 'neq', 'like', 'ilike',
  ]) {
    chain[m] = jest.fn(passThru);
  }
  chain.or = jest.fn((f: string) => {
    calls.push({ kind: 'or', arg: f });
    return chain;
  });
  chain.from = jest.fn((t: string) => {
    currentTable = t;
    calls.push({ kind: 'from', arg: t });
    return chain;
  });
  chain.rpc = jest.fn((n: string, args?: unknown) => {
    currentRpc = n;
    calls.push({ kind: 'rpc', arg: n, args });
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

jest.mock('../../src/services/memory-embedding', () => ({
  embedMemoryText: jest.fn(async () => ({ ok: true, embedding: [0.1, 0.2, 0.3] })),
}));

// Importing memory-broker drags in its own EPISODIC pipeline and
// the public entrypoint `getMemoryContext`.
import { getMemoryContext } from '../../src/services/memory-broker';
import { embedMemoryText } from '../../src/services/memory-embedding';

const mockedEmbedding = embedMemoryText as jest.MockedFunction<typeof embedMemoryText>;

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

function memoryItemRow(id: string) {
  // memory_items has no actor_id / conversation_id; the broker synthesises them.
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

describe('VTID-04342 memory-broker episodic ladder', () => {
  it('Step 1 — memory_semantic_search returns hits → source=memory_items_semantic; nothing else queried', async () => {
    supabaseMock.setRpc('memory_semantic_search', {
      data: [memoryItemRow('mi-1'), memoryItemRow('mi-2')],
      error: null,
    });
    const pack = await getMemoryContext({ ...INPUT, query: 'a meaningful query string' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.source).toBe('memory_items_semantic');
    expect(ep!.hits).toHaveLength(2);
    expect(ep!.hits[0].id).toBe('mi-1');
    // memory_items rows have no actor_id column — stable provenance label.
    expect(ep!.hits[0].actor_id).toBe('memory_items');
    expect(ep!.hits[0].kind).toBe('utterance');

    const fromCalls = supabaseMock.calls.filter(c => c.kind === 'from').map(c => c.arg);
    expect(fromCalls).not.toContain('mem_episodes');
    expect(fromCalls).not.toContain('memory_items');
    expect(mockedEmbedding).toHaveBeenCalledWith('a meaningful query string');
  });

  it('Step 2 — semantic empty → memory_items REST → source=memory_items_rest', async () => {
    supabaseMock.setRpc('memory_semantic_search', { data: [], error: null });
    supabaseMock.setTable('memory_items', {
      data: [memoryItemRow('mi-3'), memoryItemRow('mi-4')],
      error: null,
    });
    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query' });
    const ep = pack.blocks.EPISODIC;
    expect(ep!.source).toBe('memory_items_rest');
    expect(ep!.hits.map(h => h.id)).toEqual(['mi-3', 'mi-4']);
  });

  it('never reads the tier-2 mem_episodes mirror or its semantic RPC (VTID-04366)', async () => {
    supabaseMock.setTable('memory_items', { data: [memoryItemRow('mi-9')], error: null });
    await getMemoryContext({ ...INPUT, query: 'a long enough query string' });
    const fromCalls = supabaseMock.calls.filter(c => c.kind === 'from').map(c => c.arg);
    const rpcs = supabaseMock.calls.filter(c => c.kind === 'rpc').map(c => c.arg);
    expect(fromCalls).not.toContain('mem_episodes');
    expect(rpcs).not.toContain('mem_episodes_semantic_search');
  });

  it('Short queries skip the semantic step and go straight to REST', async () => {
    supabaseMock.setTable('memory_items', { data: [memoryItemRow('mi-5')], error: null });
    const pack = await getMemoryContext({ ...INPUT, query: 'hi' });
    const ep = pack.blocks.EPISODIC;
    expect(ep!.source).toBe('memory_items_rest');
    expect(ep!.hits).toHaveLength(1);
    const rpcs = supabaseMock.calls.filter(c => c.kind === 'rpc').map(c => c.arg);
    expect(rpcs).not.toContain('memory_semantic_search');
    expect(mockedEmbedding).not.toHaveBeenCalled();
  });

  it('Embedding failure does not stop the ladder — it falls through to REST', async () => {
    mockedEmbedding.mockResolvedValueOnce({ ok: false, error: 'down' } as any);
    supabaseMock.setTable('memory_items', { data: [memoryItemRow('mi-6')], error: null });
    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query string' });
    const ep = pack.blocks.EPISODIC;
    expect(ep!.source).toBe('memory_items_rest');
    expect(ep!.hits).toHaveLength(1);
    const rpcs = supabaseMock.calls.filter(c => c.kind === 'rpc').map(c => c.arg);
    expect(rpcs).not.toContain('memory_semantic_search');
  });

  it('RPC error on memory_semantic_search falls through to REST', async () => {
    supabaseMock.setRpc('memory_semantic_search', { data: null, error: { message: 'rpc down' } });
    supabaseMock.setTable('memory_items', { data: [memoryItemRow('mi-7')], error: null });
    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query string' });
    expect(pack.blocks.EPISODIC!.source).toBe('memory_items_rest');
  });

  it('All steps empty → returns an empty block, never throws', async () => {
    supabaseMock.setRpc('memory_semantic_search', { data: [], error: null });
    supabaseMock.setTable('memory_items', { data: [], error: null });
    const pack = await getMemoryContext({ ...INPUT, query: 'a long enough query string' });
    const ep = pack.blocks.EPISODIC;
    expect(ep).toBeDefined();
    expect(ep!.hits).toEqual([]);
  });
});

describe('VTID-04367 role-scoped episodic reads', () => {
  it('a community read passes p_active_role=community (personal + NULL rows only)', async () => {
    supabaseMock.setRpc('memory_semantic_search', { data: [memoryItemRow('mi-1')], error: null });
    await getMemoryContext({ ...INPUT, query: 'a meaningful query string' });
    const rpc = supabaseMock.calls.find(c => c.kind === 'rpc' && c.arg === 'memory_semantic_search');
    expect(rpc!.args.p_active_role).toBe('community');
  });

  it('a developer read passes p_active_role=developer', async () => {
    supabaseMock.setRpc('memory_semantic_search', { data: [memoryItemRow('mi-1')], error: null });
    await getMemoryContext({ ...INPUT, role: 'developer', query: 'a meaningful query string' });
    const rpc = supabaseMock.calls.find(c => c.kind === 'rpc' && c.arg === 'memory_semantic_search');
    expect(rpc!.args.p_active_role).toBe('developer');
  });

  it('lens.active_role wins over role', async () => {
    supabaseMock.setRpc('memory_semantic_search', { data: [memoryItemRow('mi-1')], error: null });
    await getMemoryContext({
      ...INPUT, role: 'community', lens: { active_role: 'staff' }, query: 'a meaningful query string',
    });
    const rpc = supabaseMock.calls.find(c => c.kind === 'rpc' && c.arg === 'memory_semantic_search');
    expect(rpc!.args.p_active_role).toBe('staff');
  });

  it('the REST fallback carries the same role filter', async () => {
    supabaseMock.setTable('memory_items', { data: [memoryItemRow('mi-2')], error: null });
    await getMemoryContext({ ...INPUT, role: 'developer', query: 'hi' });
    const or = supabaseMock.calls.find(c => c.kind === 'or');
    expect(or!.arg).toBe('active_role.is.null,active_role.eq.developer');
  });
});
