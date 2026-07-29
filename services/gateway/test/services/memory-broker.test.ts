// VTID-02026/03145/03156 — unit tests for the central memory read broker
// `getMemoryContext()` (Layer 1 semantic API — memory-broker.ts).
//
// Scope (this file):
//   1. Feature-gate behavior — `memory_broker_enabled` system_controls flag,
//      including the 30s in-process cache and `invalidateBrokerFlagCache()`.
//   2. Read composition — IDENTITY (app_users) and SEMANTIC (mem_facts)
//      blocks, plus overall MemoryPack meta (streams_hit, block_count,
//      pack_size_bytes, degraded).
//   3. Tenant/user isolation — every underlying table read must be scoped
//      to the caller's tenant_id + user_id, never swapped/mixed.
//
// The EPISODIC fallback ladder and NETWORK block already have dedicated
// suites (memory-broker-episodic-fallback.test.ts, memory-broker-network.test.ts)
// — not duplicated here.

interface SupabaseMockResponse {
  data: unknown;
  error: { message: string } | null;
}

interface RecordedCall {
  table: string;
  filters: Record<string, unknown>;
  op: 'then' | 'maybeSingle';
}

function createSupabaseMock() {
  const tableResponses = new Map<string, SupabaseMockResponse>();
  const tableDelays = new Map<string, number>();
  let currentTable: string | null = null;
  let pendingFilters: Record<string, unknown> = {};
  const calls: RecordedCall[] = [];

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
  chain.is = jest.fn((col: string, val: unknown) => {
    pendingFilters[col] = val;
    return chain;
  });
  chain.gte = jest.fn((col: string, val: unknown) => {
    pendingFilters[col] = val;
    return chain;
  });
  chain.order = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);

  function resolveFor(table: string): Promise<SupabaseMockResponse> {
    const r = tableResponses.get(table) ?? { data: null, error: null };
    const delay = tableDelays.get(table);
    if (delay && delay > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(r), delay));
    }
    return Promise.resolve(r);
  }

  chain.maybeSingle = jest.fn(() => {
    const table = currentTable ?? '';
    calls.push({ table, filters: { ...pendingFilters }, op: 'maybeSingle' });
    currentTable = null;
    return resolveFor(table);
  });
  chain.then = jest.fn(
    (resolve: (v: SupabaseMockResponse) => unknown, reject?: (e: unknown) => unknown) => {
      const table = currentTable ?? '';
      calls.push({ table, filters: { ...pendingFilters }, op: 'then' });
      currentTable = null;
      // `then` on a table with no configured response falls back to an
      // empty-array result (matches the real REST-list contract), unlike
      // maybeSingle's empty-object fallback.
      const fallback: SupabaseMockResponse = { data: [], error: null };
      const r = tableResponses.has(table) ? tableResponses.get(table)! : fallback;
      const delay = tableDelays.get(table);
      const p = delay && delay > 0
        ? new Promise<SupabaseMockResponse>((res) => setTimeout(() => res(r), delay))
        : Promise.resolve(r);
      return p.then(resolve, reject);
    }
  );

  return {
    chain,
    setTable(t: string, r: SupabaseMockResponse, delayMs?: number) {
      tableResponses.set(t, r);
      if (delayMs !== undefined) tableDelays.set(t, delayMs);
    },
    calls,
    reset() {
      tableResponses.clear();
      tableDelays.clear();
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

const mockGetSystemControl = jest.fn();
jest.mock('../../src/services/system-controls-service', () => ({
  getSystemControl: (...args: any[]) => mockGetSystemControl(...args),
}));

import { getMemoryContext, invalidateBrokerFlagCache } from '../../src/services/memory-broker';

const TENANT_A = 'tenant-aaa';
const USER_B = 'user-bbb';

const BASE_INPUT = {
  tenant_id: TENANT_A,
  user_id: USER_B,
  intent: 'identity' as const,
  channel: 'conversation' as const,
  role: 'community' as const,
  latency_budget_ms: 2000,
};

function appUsersRow(overrides: Record<string, any> = {}) {
  return {
    user_id: USER_B,
    display_name: 'Dana Display',
    email: 'dana@example.com',
    locale: 'en',
    vitana_id: 'VIT-001',
    profile: {
      first_name: 'Dana',
      last_name: 'Doe',
      full_name: 'Dana Full Profile Name', // must lose to display_name
      preferred_name: 'D',
      date_of_birth: '1990-01-01',
      gender: 'female',
      pronouns: 'she/her',
    },
    ...overrides,
  };
}

function memFactRow(overrides: Record<string, any> = {}) {
  return {
    id: 'fact-1',
    fact_key: 'user_favorite_color',
    fact_value: 'blue',
    fact_value_type: 'text',
    entity: 'self',
    confidence: 0.95,
    actor_id: 'user_stated',
    asserted_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  mockGetSystemControl.mockReset();
  mockGetSystemControl.mockResolvedValue({ key: 'memory_broker_enabled', enabled: true });
  invalidateBrokerFlagCache();
});

// ---------------------------------------------------------------------------
// 1. Feature-gate behavior
// ---------------------------------------------------------------------------

describe('memory-broker feature gate (memory_broker_enabled)', () => {
  it('returns a degraded, empty pack with error=memory_broker_disabled when the flag is off', async () => {
    mockGetSystemControl.mockResolvedValue({ key: 'memory_broker_enabled', enabled: false });

    const pack = await getMemoryContext(BASE_INPUT);

    expect(pack.ok).toBe(false);
    expect(pack.error).toBe('memory_broker_disabled');
    expect(pack.blocks).toEqual({});
    expect(pack.meta.degraded).toBe(true);
    expect(pack.meta.block_count).toBe(0);
    expect(pack.meta.streams_hit).toEqual([]);
    // Disabled short-circuit must never touch the DB.
    expect(supabaseMock.calls.length).toBe(0);
  });

  it('treats a null control row as disabled (fail closed, not fail open)', async () => {
    mockGetSystemControl.mockResolvedValue(null);

    const pack = await getMemoryContext(BASE_INPUT);

    expect(pack.ok).toBe(false);
    expect(pack.error).toBe('memory_broker_disabled');
  });

  it('treats a getSystemControl rejection as disabled, not a thrown error', async () => {
    mockGetSystemControl.mockRejectedValue(new Error('system_controls unreachable'));

    await expect(getMemoryContext(BASE_INPUT)).resolves.toMatchObject({
      ok: false,
      error: 'memory_broker_disabled',
    });
  });

  it('proceeds to read blocks when the flag is enabled', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });
    const pack = await getMemoryContext(BASE_INPUT);

    expect(pack.ok).toBe(true);
    expect(pack.blocks.IDENTITY).toBeDefined();
  });

  it('caches the flag value for the TTL window — getSystemControl is called once across repeated reads', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });

    await getMemoryContext(BASE_INPUT);
    await getMemoryContext(BASE_INPUT);
    await getMemoryContext(BASE_INPUT);

    expect(mockGetSystemControl).toHaveBeenCalledTimes(1);
  });

  it('invalidateBrokerFlagCache() forces a re-check on the next read', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });

    await getMemoryContext(BASE_INPUT);
    expect(mockGetSystemControl).toHaveBeenCalledTimes(1);

    invalidateBrokerFlagCache();
    await getMemoryContext(BASE_INPUT);
    expect(mockGetSystemControl).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Input validation (checked before the flag gate)
// ---------------------------------------------------------------------------

describe('memory-broker input contract', () => {
  it('rejects a read with no tenant_id, without ever checking the flag or the DB', async () => {
    const pack = await getMemoryContext({ ...BASE_INPUT, tenant_id: '' });

    expect(pack.ok).toBe(false);
    expect(pack.error).toBe('tenant_id and user_id are required');
    expect(pack.meta.degraded).toBe(true);
    expect(pack.meta.block_count).toBe(0);
    expect(mockGetSystemControl).not.toHaveBeenCalled();
    expect(supabaseMock.calls.length).toBe(0);
  });

  it('rejects a read with no user_id', async () => {
    const pack = await getMemoryContext({ ...BASE_INPUT, user_id: '' });

    expect(pack.ok).toBe(false);
    expect(pack.error).toBe('tenant_id and user_id are required');
    expect(mockGetSystemControl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Read composition — IDENTITY block
// ---------------------------------------------------------------------------

describe('memory-broker IDENTITY block (fetchIdentityBlock)', () => {
  it('unpacks the profile JSONB blob into the flat IdentityBlock contract', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['IDENTITY'] });
    const block = pack.blocks.IDENTITY as any;

    expect(block).toBeDefined();
    expect(block.kind).toBe('IDENTITY');
    expect(block.source).toBe('app_users');
    expect(block.user_id).toBe(USER_B);
    expect(block.tenant_id).toBe(TENANT_A);
    expect(block.first_name).toBe('Dana');
    expect(block.last_name).toBe('Doe');
    expect(block.preferred_name).toBe('D');
    expect(block.email).toBe('dana@example.com');
    expect(block.date_of_birth).toBe('1990-01-01');
    expect(block.gender).toBe('female');
    expect(block.pronouns).toBe('she/her');
    expect(block.locale).toBe('en');
    expect(block.vitana_id).toBe('VIT-001');
  });

  it('Identity Lock invariant: the flat display_name column wins over profile.full_name', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['IDENTITY'] });
    const block = pack.blocks.IDENTITY as any;

    // appUsersRow() sets display_name='Dana Display' and a DIFFERENT
    // profile.full_name — regression guard against the columns being
    // read in the wrong priority order.
    expect(block.full_name).toBe('Dana Display');
  });

  it('falls back to profile.full_name when display_name is null', async () => {
    supabaseMock.setTable('app_users', {
      data: appUsersRow({ display_name: null }),
      error: null,
    });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['IDENTITY'] });
    const block = pack.blocks.IDENTITY as any;

    expect(block.full_name).toBe('Dana Full Profile Name');
  });

  it('omits the IDENTITY block (not a throw) when app_users has no row for this user', async () => {
    supabaseMock.setTable('app_users', { data: null, error: null });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['IDENTITY'] });

    expect(pack.ok).toBe(true);
    expect(pack.blocks.IDENTITY).toBeUndefined();
    expect(pack.meta.streams_hit).not.toContain('app_users');
  });

  it('omits the IDENTITY block on a query error, without marking the pack degraded', async () => {
    supabaseMock.setTable('app_users', { data: null, error: { message: 'db down' } });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['IDENTITY'] });

    expect(pack.blocks.IDENTITY).toBeUndefined();
    expect(pack.meta.degraded).toBe(false);
  });

  it('scopes the app_users read to the caller tenant_id + user_id, never swapped', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });

    await getMemoryContext({
      ...BASE_INPUT,
      tenant_id: 'tenant-XYZ',
      user_id: 'user-QRS',
      required_blocks: ['IDENTITY'],
    });

    const call = supabaseMock.calls.find((c) => c.table === 'app_users');
    expect(call?.filters).toEqual({ user_id: 'user-QRS', tenant_id: 'tenant-XYZ' });
  });
});

// ---------------------------------------------------------------------------
// 2. Read composition — SEMANTIC block
// ---------------------------------------------------------------------------

describe('memory-broker SEMANTIC block (fetchSemanticBlock)', () => {
  it('maps mem_facts rows into SemanticFact entries', async () => {
    supabaseMock.setTable('mem_facts', {
      data: [memFactRow(), memFactRow({ id: 'fact-2', fact_key: 'user_pet', fact_value: 'dog', confidence: null })],
      error: null,
    });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['SEMANTIC'] });
    const block = pack.blocks.SEMANTIC as any;

    expect(block).toBeDefined();
    expect(block.source).toBe('mem_facts');
    expect(block.facts).toHaveLength(2);
    expect(block.facts[0]).toEqual({
      id: 'fact-1',
      fact_key: 'user_favorite_color',
      fact_value: 'blue',
      fact_value_type: 'text',
      entity: 'self',
      confidence: 0.95,
      actor_id: 'user_stated',
      asserted_at: '2026-07-01T00:00:00Z',
    });
    // Null confidence defaults to 1.0, not 0 or undefined.
    expect(block.facts[1].confidence).toBe(1.0);
  });

  it('only reads active (valid_to IS NULL) facts', async () => {
    supabaseMock.setTable('mem_facts', { data: [memFactRow()], error: null });

    await getMemoryContext({ ...BASE_INPUT, required_blocks: ['SEMANTIC'] });

    const call = supabaseMock.calls.find((c) => c.table === 'mem_facts');
    expect(call?.filters).toMatchObject({
      tenant_id: TENANT_A,
      user_id: USER_B,
      valid_to: null,
    });
  });

  it('omits the SEMANTIC block on error without marking the pack degraded', async () => {
    supabaseMock.setTable('mem_facts', { data: null, error: { message: 'timeout' } });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['SEMANTIC'] });

    expect(pack.blocks.SEMANTIC).toBeUndefined();
    expect(pack.meta.degraded).toBe(false);
  });

  it('returns an empty (not missing) SEMANTIC block when the user has no facts yet', async () => {
    supabaseMock.setTable('mem_facts', { data: [], error: null });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['SEMANTIC'] });
    const block = pack.blocks.SEMANTIC as any;

    expect(block).toBeDefined();
    expect(block.facts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Tenant / user isolation
// ---------------------------------------------------------------------------

describe('memory-broker tenant/user isolation', () => {
  it('two different tenants for the same user_id produce independently-scoped reads', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });
    supabaseMock.setTable('mem_facts', { data: [memFactRow()], error: null });

    await getMemoryContext({
      ...BASE_INPUT,
      tenant_id: 'tenant-1',
      user_id: USER_B,
      required_blocks: ['IDENTITY', 'SEMANTIC'],
    });
    await getMemoryContext({
      ...BASE_INPUT,
      tenant_id: 'tenant-2',
      user_id: USER_B,
      required_blocks: ['IDENTITY', 'SEMANTIC'],
    });

    const appUsersCalls = supabaseMock.calls.filter((c) => c.table === 'app_users');
    const factsCalls = supabaseMock.calls.filter((c) => c.table === 'mem_facts');
    expect(appUsersCalls.map((c) => c.filters.tenant_id)).toEqual(['tenant-1', 'tenant-2']);
    expect(factsCalls.map((c) => c.filters.tenant_id)).toEqual(['tenant-1', 'tenant-2']);
  });

  it('never queries with a merged/undefined tenant_id or user_id', async () => {
    supabaseMock.setTable('mem_facts', { data: [], error: null });

    await getMemoryContext({
      ...BASE_INPUT,
      tenant_id: 'tenant-only',
      user_id: 'user-only',
      required_blocks: ['SEMANTIC'],
    });

    const call = supabaseMock.calls.find((c) => c.table === 'mem_facts');
    expect(call?.filters.tenant_id).toBe('tenant-only');
    expect(call?.filters.user_id).toBe('user-only');
    expect(call?.filters.tenant_id).not.toBeUndefined();
    expect(call?.filters.user_id).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pack composition — block selection, meta, budget
// ---------------------------------------------------------------------------

describe('memory-broker pack composition', () => {
  it('default block selection for the "identity" intent is exactly IDENTITY + SEMANTIC', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });
    supabaseMock.setTable('mem_facts', { data: [memFactRow()], error: null });

    const pack = await getMemoryContext({ ...BASE_INPUT, intent: 'identity' });

    expect(Object.keys(pack.blocks).sort()).toEqual(['IDENTITY', 'SEMANTIC']);
    expect(pack.meta.block_count).toBe(2);
  });

  it('required_blocks overrides the intent default — unrequested blocks are never fetched', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });
    supabaseMock.setTable('mem_facts', { data: [memFactRow()], error: null });

    const pack = await getMemoryContext({
      ...BASE_INPUT,
      intent: 'identity', // default would be ['IDENTITY','SEMANTIC']
      required_blocks: ['SEMANTIC'],
    });

    expect(Object.keys(pack.blocks)).toEqual(['SEMANTIC']);
    expect(supabaseMock.calls.some((c) => c.table === 'app_users')).toBe(false);
  });

  it('pack_size_bytes reflects the exact serialized size of the returned blocks', async () => {
    supabaseMock.setTable('mem_facts', { data: [memFactRow()], error: null });

    const pack = await getMemoryContext({ ...BASE_INPUT, required_blocks: ['SEMANTIC'] });

    expect(pack.meta.pack_size_bytes).toBe(JSON.stringify(pack.blocks).length);
    expect(pack.meta.pack_size_bytes).toBeGreaterThan(2); // more than just "{}"
  });

  it('streams_hit lists the underlying source name for every block actually returned', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });
    supabaseMock.setTable('mem_facts', { data: [memFactRow()], error: null });

    const pack = await getMemoryContext({
      ...BASE_INPUT,
      required_blocks: ['IDENTITY', 'SEMANTIC'],
    });

    expect(pack.meta.streams_hit.sort()).toEqual(['app_users', 'mem_facts']);
  });

  it('a block whose fetch exceeds latency_budget_ms is dropped and the pack is marked degraded', async () => {
    // app_users resolves far slower than the budget.
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null }, 150);

    const pack = await getMemoryContext({
      ...BASE_INPUT,
      required_blocks: ['IDENTITY'],
      latency_budget_ms: 20,
    });

    expect(pack.blocks.IDENTITY).toBeUndefined();
    expect(pack.meta.degraded).toBe(true);
    expect(pack.meta.latency_ms_per_stream['app_users']).toBe(20);
    expect(pack.meta.streams_hit).not.toContain('app_users');
  }, 10000);

  it('a fast block still succeeds even when another required block times out', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null }, 150);
    supabaseMock.setTable('mem_facts', { data: [memFactRow()], error: null });

    const pack = await getMemoryContext({
      ...BASE_INPUT,
      required_blocks: ['IDENTITY', 'SEMANTIC'],
      latency_budget_ms: 20,
    });

    expect(pack.blocks.IDENTITY).toBeUndefined();
    expect(pack.blocks.SEMANTIC).toBeDefined();
    expect(pack.meta.degraded).toBe(true);
  }, 10000);

  it('falls back to the ["IDENTITY"] default when required_blocks is empty and the intent is unknown', async () => {
    supabaseMock.setTable('app_users', { data: appUsersRow(), error: null });

    // Cast through `any` — this deliberately exercises the `?? ['IDENTITY']`
    // fallback for an intent key that doesn't exist in DEFAULT_BLOCKS_BY_INTENT.
    const pack = await getMemoryContext({
      ...BASE_INPUT,
      intent: 'not_a_real_intent' as any,
    });

    expect(Object.keys(pack.blocks)).toEqual(['IDENTITY']);
  });
});
