// BOOTSTRAP-MEMORY-DAILY-LEARNING — unit tests for the NETWORK block's
// fetchNetworkBlock, exercised through the public `getMemoryContext`
// entry-point with `required_blocks: ['NETWORK']`.
//
// Context: fetchNetworkBlock previously read `mem_graph_edges`, a table
// with zero writers anywhere in the codebase, so the NETWORK block was
// always empty and Vitana never surfaced a user's network/relationships.
// AP-0909 now populates `relationship_edges` + `relationship_nodes`
// (verified live schema: no `user_id`/`valid_to` on relationship_edges,
// display column is `title` not `display_name` on relationship_nodes).
// These tests lock in the corrected read path.

interface SupabaseMockResponse {
  data: unknown;
  error: { message: string } | null;
}

function createSupabaseMock() {
  const tableResponses = new Map<string, SupabaseMockResponse>();
  let currentTable: string | null = null;
  const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
  let pendingFilters: Record<string, unknown> = {};

  const chain: any = {};
  chain.from = jest.fn((t: string) => {
    currentTable = t;
    pendingFilters = {};
    return chain;
  });
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn((col: string, val: unknown) => {
    pendingFilters[col] = val;
    return chain;
  });
  chain.in = jest.fn((col: string, vals: unknown[]) => {
    pendingFilters[col] = vals;
    return chain;
  });
  chain.order = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.then = jest.fn((resolve: (v: SupabaseMockResponse) => unknown) => {
    const table = currentTable ?? '';
    calls.push({ table, filters: pendingFilters });
    const r = tableResponses.get(table) ?? { data: [], error: null };
    currentTable = null;
    return Promise.resolve(r).then(resolve);
  });

  return {
    chain,
    setTable(t: string, r: SupabaseMockResponse) {
      tableResponses.set(t, r);
    },
    calls,
    reset() {
      tableResponses.clear();
      calls.length = 0;
      currentTable = null;
      pendingFilters = {};
    },
  };
}

const supabaseMock = createSupabaseMock();

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => supabaseMock.chain),
}));

import { getMemoryContext } from '../../src/services/memory-broker';

const INPUT = {
  tenant_id: 'tenant-aaa',
  user_id: 'user-bbb',
  intent: 'social_query' as const,
  channel: 'conversation' as const,
  role: 'community',
  latency_budget_ms: 2000,
  required_blocks: ['NETWORK' as const],
};

beforeEach(() => {
  supabaseMock.reset();
});

describe('BOOTSTRAP-MEMORY-DAILY-LEARNING NETWORK block (fetchNetworkBlock)', () => {
  it('reads relationship_edges (not mem_graph_edges) filtered by tenant + user as source', async () => {
    supabaseMock.setTable('relationship_edges', {
      data: [
        {
          source_type: 'person',
          source_id: 'user-bbb',
          target_type: 'person',
          target_id: 'node-mariia',
          edge_type: 'suggested',
          strength: 0.8,
          last_interaction_at: '2026-07-01T00:00:00Z',
        },
      ],
      error: null,
    });
    supabaseMock.setTable('relationship_nodes', {
      data: [{ id: 'node-mariia', title: 'Mariia', node_type: 'person' }],
      error: null,
    });

    const pack = await getMemoryContext(INPUT);

    expect(pack.ok).toBe(true);
    const block = pack.blocks.NETWORK as any;
    expect(block).toBeDefined();
    expect(block.source).toBe('relationship_edges');
    expect(block.people).toEqual([
      {
        node_id: 'node-mariia',
        display_name: 'Mariia',
        node_type: 'person',
        edge_type: 'suggested',
        strength: 0.8,
        last_interaction_at: '2026-07-01T00:00:00Z',
      },
    ]);

    const edgeCall = supabaseMock.calls.find((c) => c.table === 'relationship_edges');
    expect(edgeCall?.filters).toMatchObject({
      tenant_id: 'tenant-aaa',
      source_type: 'person',
      source_id: 'user-bbb',
    });

    // The dead table must never be queried by this path again.
    expect(supabaseMock.calls.some((c) => c.table === 'mem_graph_edges')).toBe(false);
  });

  it('resolves display_name from relationship_nodes.title (not a nonexistent display_name column)', async () => {
    supabaseMock.setTable('relationship_edges', {
      data: [
        {
          source_type: 'person',
          source_id: 'user-bbb',
          target_type: 'person',
          target_id: 'node-1',
          edge_type: 'suggested',
          strength: 0.5,
          last_interaction_at: null,
        },
      ],
      error: null,
    });
    supabaseMock.setTable('relationship_nodes', {
      data: [{ id: 'node-1', title: 'Alex', node_type: 'person' }],
      error: null,
    });

    const pack = await getMemoryContext(INPUT);
    const block = pack.blocks.NETWORK as any;
    expect(block.people[0].display_name).toBe('Alex');

    const nodeCall = supabaseMock.calls.find((c) => c.table === 'relationship_nodes');
    expect(nodeCall?.filters).toMatchObject({ id: ['node-1'] });
  });

  it('falls back to null display_name and the edge target_type when no relationship_nodes row exists', async () => {
    // e.g. a 'connected' edge whose target_id is a real app user id, not a
    // projected relationship_nodes row.
    supabaseMock.setTable('relationship_edges', {
      data: [
        {
          source_type: 'person',
          source_id: 'user-bbb',
          target_type: 'person',
          target_id: 'real-app-user-id',
          edge_type: 'connected',
          strength: 1,
          last_interaction_at: '2026-06-30T00:00:00Z',
        },
      ],
      error: null,
    });
    supabaseMock.setTable('relationship_nodes', { data: [], error: null });

    const pack = await getMemoryContext(INPUT);
    const block = pack.blocks.NETWORK as any;
    expect(block.people[0]).toEqual({
      node_id: 'real-app-user-id',
      display_name: null,
      node_type: 'person',
      edge_type: 'connected',
      strength: 1,
      last_interaction_at: '2026-06-30T00:00:00Z',
    });
  });

  it('returns an empty NETWORK block (not null) when the user has no edges yet', async () => {
    supabaseMock.setTable('relationship_edges', { data: [], error: null });

    const pack = await getMemoryContext(INPUT);
    const block = pack.blocks.NETWORK as any;
    expect(block).toBeDefined();
    expect(block.people).toEqual([]);
    // No edges → no lookup query needed.
    expect(supabaseMock.calls.some((c) => c.table === 'relationship_nodes')).toBe(false);
  });

  it('degrades gracefully (drops the block) when relationship_edges errors', async () => {
    supabaseMock.setTable('relationship_edges', {
      data: null,
      error: { message: 'boom' },
    });

    const pack = await getMemoryContext(INPUT);
    expect(pack.blocks.NETWORK).toBeUndefined();
  });
});
