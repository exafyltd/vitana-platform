/**
 * VTID-01106/VTID-01186: ORB Memory Bridge — Unit Tests
 *
 * Covers `src/services/orb-memory-bridge.ts`:
 *  - Environment detection: isDevSandbox / isMemoryBridgeEnabled / resetMemoryBridgeCache
 *  - shouldStoreInMemory — the memory-flooding filter (pure function)
 *  - Write path: writeDevMemoryItem (DEV_IDENTITY) + writeMemoryItemWithIdentity
 *    (authenticated identity) — what gets persisted, category classification,
 *    importance boosting, tenant/user scoping, Tier-2 mirror fan-out
 *  - Read path: fetchDevMemoryContext + fetchRecentOrbUserTurns — retrieval
 *    hookup, tenant/user scoping, error handling
 *  - buildMemoryEnhancedInstruction / formatRecentTurnsBlock — pure prompt
 *    formatting helpers
 *
 * Mocking strategy: `@supabase/supabase-js`'s createClient is mocked with a
 * small chainable query-builder stand-in (same convention as
 * test/services/memory-facts-service.test.ts), plus jest.mock() at the
 * module boundary for oasis-event-service and mem-tier2-writer (fire-and-
 * forget Tier 2 mirror), matching this codebase's established convention.
 */

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Chainable Supabase query-builder mock
// ---------------------------------------------------------------------------

type ChainCall = { method: string; args: any[] };
type TableResult = { data: any; error: any };

function makeBuilder(resolver: (table: string, calls: ChainCall[]) => TableResult, table: string) {
  const calls: ChainCall[] = [];
  const builder: any = { __table: table, __calls: calls };
  const chainable = ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'abortSignal', 'insert'];
  for (const m of chainable) {
    builder[m] = jest.fn((...args: any[]) => {
      calls.push({ method: m, args });
      return builder;
    });
  }
  builder.single = jest.fn(() => Promise.resolve(resolver(table, calls)));
  // Supabase-js query builders are themselves PromiseLike (awaiting them
  // without .single() resolves the built query) — mirror that here.
  builder.then = (onFulfilled: any, onRejected?: any) =>
    Promise.resolve(resolver(table, calls)).then(onFulfilled, onRejected);
  builder.catch = (onRejected: any) => Promise.resolve(resolver(table, calls)).catch(onRejected);
  return builder;
}

function makeSupabaseClient(opts: {
  fromResolver?: (table: string, calls: ChainCall[]) => TableResult;
  rpcImpl?: (...args: any[]) => Promise<any>;
} = {}) {
  const fromResolver = opts.fromResolver ?? (() => ({ data: [], error: null }));
  const fromMock = jest.fn((table: string) => makeBuilder(fromResolver, table));
  const rpcMock = jest.fn(opts.rpcImpl ?? (() => Promise.resolve({ data: null, error: null })));
  return { from: fromMock, rpc: rpcMock };
}

let mockClient: any = null;
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn((...args: any[]) => mockClient),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

const mockMirrorEpisode = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/mem-tier2-writer', () => ({
  mirrorEpisode: (...args: any[]) => mockMirrorEpisode(...args),
  mirrorFact: jest.fn().mockResolvedValue(undefined),
}));

// global.fetch is used by fetchMemoryContextWithIdentity's raw REST call to
// memory_facts (VTID-03156 boundary keeps that off the supabase-js client).
// Default: not ok, so the code's non-fatal fallback kicks in.
const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
global.fetch = mockFetch as any;

import {
  isDevSandbox,
  isMemoryBridgeEnabled,
  resetMemoryBridgeCache,
  shouldStoreInMemory,
  writeDevMemoryItem,
  writeMemoryItemWithIdentity,
  fetchDevMemoryContext,
  fetchMemoryContextWithIdentity,
  fetchRecentOrbUserTurns,
  buildMemoryEnhancedInstruction,
  formatRecentTurnsBlock,
  DEV_IDENTITY,
  type OrbMemoryContext,
} from '../../src/services/orb-memory-bridge';

const ORIGINAL_ENV = { ...process.env };

function setDevSandboxEnv() {
  process.env.ENVIRONMENT = 'dev-sandbox';
  delete process.env.VITANA_ENV;
  delete process.env.ORB_MEMORY_BRIDGE_DISABLED;
  resetMemoryBridgeCache();
}

function setProdEnv() {
  process.env.ENVIRONMENT = 'production';
  delete process.env.VITANA_ENV;
  delete process.env.ORB_MEMORY_BRIDGE_DISABLED;
  resetMemoryBridgeCache();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClient = null;
  mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  process.env = { ...ORIGINAL_ENV };
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
  resetMemoryBridgeCache();
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

// =============================================================================
// Environment detection
// =============================================================================

describe('isDevSandbox', () => {
  it('is true for ENVIRONMENT=dev-sandbox / development / sandbox / anything containing "dev"', () => {
    for (const env of ['dev-sandbox', 'development', 'sandbox', 'dev', 'my-dev-box']) {
      process.env.ENVIRONMENT = env;
      expect(isDevSandbox()).toBe(true);
    }
  });

  it('is false for production', () => {
    process.env.ENVIRONMENT = 'production';
    delete process.env.VITANA_ENV;
    expect(isDevSandbox()).toBe(false);
  });

  it('falls back to VITANA_ENV when ENVIRONMENT is unset', () => {
    delete process.env.ENVIRONMENT;
    process.env.VITANA_ENV = 'dev';
    expect(isDevSandbox()).toBe(true);
  });
});

describe('isMemoryBridgeEnabled / resetMemoryBridgeCache', () => {
  it('is enabled in a dev-sandbox environment', () => {
    setDevSandboxEnv();
    expect(isMemoryBridgeEnabled()).toBe(true);
  });

  it('is disabled outside a dev environment', () => {
    setProdEnv();
    expect(isMemoryBridgeEnabled()).toBe(false);
  });

  it('is disabled even in dev-sandbox when ORB_MEMORY_BRIDGE_DISABLED=true', () => {
    process.env.ENVIRONMENT = 'dev-sandbox';
    process.env.ORB_MEMORY_BRIDGE_DISABLED = 'true';
    resetMemoryBridgeCache();
    expect(isMemoryBridgeEnabled()).toBe(false);
  });

  it('caches its result — changing env vars after the first call has no effect until reset', () => {
    setDevSandboxEnv();
    expect(isMemoryBridgeEnabled()).toBe(true);
    process.env.ENVIRONMENT = 'production';
    // Still true: cached.
    expect(isMemoryBridgeEnabled()).toBe(true);
    resetMemoryBridgeCache();
    // Now re-evaluates and picks up the new (production) env.
    expect(isMemoryBridgeEnabled()).toBe(false);
  });
});

// =============================================================================
// shouldStoreInMemory — memory-flooding filter
// =============================================================================

describe('shouldStoreInMemory', () => {
  it('always blocks assistant-direction messages, regardless of content', () => {
    expect(shouldStoreInMemory('my name is Bob and I live in Berlin, a long detailed message', 'assistant')).toBe(false);
  });

  it('blocks short user messages (<10 chars) with no important-info keyword', () => {
    expect(shouldStoreInMemory('yeah ok', 'user')).toBe(false);
  });

  it('allows a short user message (<10 chars) that contains an important-info keyword', () => {
    expect(shouldStoreInMemory('from Rome', 'user')).toBe(true);
  });

  it('blocks a trivial greeting/acknowledgement', () => {
    expect(shouldStoreInMemory('ok', 'user')).toBe(false);
    expect(shouldStoreInMemory('hello', 'user')).toBe(false);
    expect(shouldStoreInMemory('what?', 'user')).toBe(false);
  });

  it('blocks a short (<3 word), keyword-free user message', () => {
    expect(shouldStoreInMemory('sounds good', 'user')).toBe(false);
  });

  it('allows a message containing personal-info keywords ("my name is ...")', () => {
    expect(shouldStoreInMemory('my name is Bob', 'user')).toBe(true);
  });

  it('allows a message containing health keywords', () => {
    expect(shouldStoreInMemory('my sleep has been terrible lately', 'user')).toBe(true);
  });

  it('allows a message containing relationship keywords', () => {
    expect(shouldStoreInMemory('my fiancée is visiting this weekend', 'user')).toBe(true);
  });

  it('blocks a mid-length message (<10 words) with no matching keyword category', () => {
    expect(shouldStoreInMemory('can you help me with something', 'user')).toBe(false);
  });

  it('allows any message with 10+ words even without a matching keyword (long-message fallback)', () => {
    const longNeutral = 'This is a fairly long sentence with more than ten words in total here';
    expect(longNeutral.split(/\s+/).length).toBeGreaterThanOrEqual(10);
    expect(shouldStoreInMemory(longNeutral, 'user')).toBe(true);
  });
});

// =============================================================================
// Write path: writeDevMemoryItem (DEV_IDENTITY)
// =============================================================================

describe('writeDevMemoryItem', () => {
  it('returns an error without touching Supabase when the memory bridge is disabled', async () => {
    setProdEnv();
    const result = await writeDevMemoryItem({ source: 'orb_text', content: 'my name is Bob' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not enabled/i);
  });

  it('skips (ok:true, skipped:true) a trivial user message instead of writing it', async () => {
    setDevSandboxEnv();
    mockClient = makeSupabaseClient();
    const result = await writeDevMemoryItem({
      source: 'orb_voice',
      content: 'ok',
      content_json: { direction: 'user' },
    });
    expect(result).toEqual({ ok: true, skipped: true });
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('bypasses filtering when skipFiltering:true, even for trivial content', async () => {
    setDevSandboxEnv();
    mockClient = makeSupabaseClient({
      fromResolver: () => ({ data: { id: 'mem-1', category_key: 'conversation' }, error: null }),
    });
    const result = await writeDevMemoryItem({
      source: 'orb_voice',
      content: 'ok',
      content_json: { direction: 'user' },
      skipFiltering: true,
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(mockClient.from).toHaveBeenCalledWith('memory_items');
  });

  it('writes under DEV_IDENTITY tenant/user and boosts importance for the "personal" category', async () => {
    setDevSandboxEnv();
    let insertedRow: any = null;
    mockClient = makeSupabaseClient({
      fromResolver: (_table, calls) => {
        const insertCall = calls.find(c => c.method === 'insert');
        if (insertCall) insertedRow = insertCall.args[0];
        return { data: { id: 'mem-2', category_key: 'personal' }, error: null };
      },
    });
    const result = await writeDevMemoryItem({
      source: 'orb_text',
      content: 'my name is Bob and I live in Berlin, a longer sentence',
      importance: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.category_key).toBe('personal');
    expect(insertedRow.tenant_id).toBe(DEV_IDENTITY.TENANT_ID);
    expect(insertedRow.user_id).toBe(DEV_IDENTITY.USER_ID);
    expect(insertedRow.category_key).toBe('personal');
    // Personal category boosts importance to at least 50, overriding the
    // requested importance:10.
    expect(insertedRow.importance).toBeGreaterThanOrEqual(50);
  });

  it('returns a friendly error when the memory_items table does not exist', async () => {
    setDevSandboxEnv();
    mockClient = makeSupabaseClient({
      fromResolver: () => ({ data: null, error: { message: 'relation "memory_items" does not exist', code: '42P01' } }),
    });
    const result = await writeDevMemoryItem({ source: 'system', content: 'my name is Bob', skipFiltering: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Memory Core not available/);
  });

  it('returns ok:false with the raw error message on a generic insert failure', async () => {
    setDevSandboxEnv();
    mockClient = makeSupabaseClient({
      fromResolver: () => ({ data: null, error: { message: 'permission denied' } }),
    });
    const result = await writeDevMemoryItem({ source: 'system', content: 'my name is Bob', skipFiltering: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('permission denied');
  });

  it('reports "Supabase not configured" when SUPABASE_URL is missing', async () => {
    setDevSandboxEnv();
    delete process.env.SUPABASE_URL;
    const result = await writeDevMemoryItem({ source: 'system', content: 'my name is Bob', skipFiltering: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Supabase not configured');
  });
});

// =============================================================================
// Write path: writeMemoryItemWithIdentity (authenticated identity, tenant scoping)
// =============================================================================

describe('writeMemoryItemWithIdentity', () => {
  const IDENTITY = { user_id: 'user-123', tenant_id: 'tenant-456', active_role: 'community' };

  it('rejects when identity is missing tenant_id or user_id, without touching Supabase', async () => {
    mockClient = makeSupabaseClient();
    const result = await writeMemoryItemWithIdentity(
      { user_id: '', tenant_id: 'tenant-456' } as any,
      { source: 'orb_text', content: 'my name is Bob' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Identity incomplete/);
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('skips trivial user messages without writing', async () => {
    mockClient = makeSupabaseClient();
    const result = await writeMemoryItemWithIdentity(IDENTITY, {
      source: 'orb_voice',
      content: 'ok',
      content_json: { direction: 'user' },
    });
    expect(result).toEqual({ ok: true, skipped: true });
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('writes under the GIVEN identity\'s tenant_id/user_id — never DEV_IDENTITY\'s', async () => {
    let insertedRow: any = null;
    mockClient = makeSupabaseClient({
      fromResolver: (_table, calls) => {
        const insertCall = calls.find(c => c.method === 'insert');
        if (insertCall) insertedRow = insertCall.args[0];
        return { data: { id: 'mem-3', category_key: 'health' }, error: null };
      },
    });
    const result = await writeMemoryItemWithIdentity(IDENTITY, {
      source: 'orb_text',
      content: 'my blood pressure was high this morning after a stressful commute',
      content_json: { direction: 'user' },
    });
    expect(result.ok).toBe(true);
    expect(insertedRow.tenant_id).toBe('tenant-456');
    expect(insertedRow.user_id).toBe('user-123');
    expect(insertedRow.tenant_id).not.toBe(DEV_IDENTITY.TENANT_ID);
    expect(insertedRow.user_id).not.toBe(DEV_IDENTITY.USER_ID);
  });

  it('boosts importance for health/goals/preferences/relationships categories, plus an extra bump for user-direction', async () => {
    let insertedRow: any = null;
    mockClient = makeSupabaseClient({
      fromResolver: (_table, calls) => {
        const insertCall = calls.find(c => c.method === 'insert');
        if (insertCall) insertedRow = insertCall.args[0];
        return { data: { id: 'mem-4', category_key: 'health' }, error: null };
      },
    });
    await writeMemoryItemWithIdentity(IDENTITY, {
      source: 'orb_text',
      content: 'my blood pressure was high this morning after a stressful commute',
      content_json: { direction: 'user' },
      category_key: 'health',
      importance: 5,
    });
    // health boosts to >=50, and importance:5 must be overridden.
    expect(insertedRow.importance).toBeGreaterThanOrEqual(50);
  });

  it('fans out to mem-tier2-writer.mirrorEpisode with matching tenant/user scoping', async () => {
    mockClient = makeSupabaseClient({
      fromResolver: () => ({ data: { id: 'mem-5', category_key: 'conversation' }, error: null }),
    });
    await writeMemoryItemWithIdentity(IDENTITY, {
      source: 'orb_text',
      content: 'my favorite hobby is photography and I do it every weekend',
      content_json: { direction: 'user' },
    });
    expect(mockMirrorEpisode).toHaveBeenCalledTimes(1);
    const mirrorArg = mockMirrorEpisode.mock.calls[0][0];
    expect(mirrorArg.tenant_id).toBe('tenant-456');
    expect(mirrorArg.user_id).toBe('user-123');
    expect(mirrorArg.actor_id).toBe('user');
  });

  it('marks actor_id as "assistant" for assistant-direction writes (skipFiltering bypasses the assistant block)', async () => {
    mockClient = makeSupabaseClient({
      fromResolver: () => ({ data: { id: 'mem-6', category_key: 'conversation' }, error: null }),
    });
    await writeMemoryItemWithIdentity(IDENTITY, {
      source: 'system',
      content: 'System-generated note',
      content_json: { direction: 'assistant' },
      skipFiltering: true,
    });
    const mirrorArg = mockMirrorEpisode.mock.calls[0][0];
    expect(mirrorArg.actor_id).toBe('assistant');
  });

  it('returns ok:false when the memory_items table does not exist', async () => {
    mockClient = makeSupabaseClient({
      fromResolver: () => ({ data: null, error: { message: 'relation "memory_items" does not exist', code: '42P01' } }),
    });
    const result = await writeMemoryItemWithIdentity(IDENTITY, {
      source: 'system',
      content: 'my name is Bob',
      skipFiltering: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Memory Core not available/);
  });
});

// =============================================================================
// Read path: fetchDevMemoryContext
// =============================================================================

describe('fetchDevMemoryContext', () => {
  it('returns ok:false without querying Supabase when the memory bridge is disabled', async () => {
    setProdEnv();
    const result = await fetchDevMemoryContext();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not enabled/i);
    expect(result.items).toEqual([]);
  });

  it('returns ok:false when Supabase is not configured', async () => {
    setDevSandboxEnv();
    delete process.env.SUPABASE_URL;
    const result = await fetchDevMemoryContext();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Supabase not configured');
  });

  it('scopes every memory_items query to DEV_IDENTITY tenant/user', async () => {
    setDevSandboxEnv();
    mockClient = makeSupabaseClient({ fromResolver: () => ({ data: [], error: null }) });
    await fetchDevMemoryContext();

    const memoryItemsCalls = (mockClient.from as jest.Mock).mock.results
      .filter((_r: any, idx: number) => (mockClient.from as jest.Mock).mock.calls[idx][0] === 'memory_items');
    expect(memoryItemsCalls.length).toBeGreaterThan(0);
    for (const r of memoryItemsCalls) {
      const eqCalls = r.value.__calls.filter((c: ChainCall) => c.method === 'eq');
      expect(eqCalls).toEqual(
        expect.arrayContaining([
          { method: 'eq', args: ['tenant_id', DEV_IDENTITY.TENANT_ID] },
          { method: 'eq', args: ['user_id', DEV_IDENTITY.USER_ID] },
        ]),
      );
    }
  });

  it('returns items from the persistent-category query and builds a non-empty formatted context', async () => {
    setDevSandboxEnv();
    const now = new Date().toISOString();
    mockClient = makeSupabaseClient({
      fromResolver: (_table, calls) => {
        const inCall = calls.find(c => c.method === 'in');
        const categories: string[] = inCall?.args[1] ?? [];
        if (categories.includes('personal')) {
          return {
            data: [
              { id: 'p1', category_key: 'personal', source: 'orb_text', content: 'User name is Dragan', content_json: {}, importance: 90, occurred_at: now, created_at: now },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      },
    });
    const result = await fetchDevMemoryContext();
    expect(result.ok).toBe(true);
    expect(result.items.some(i => i.id === 'p1')).toBe(true);
    expect(result.formatted_context).toContain('Dragan');
    expect(result.summary).toContain('1 recent items');
  });

  it('returns a "Memory Core not deployed" error when the time-sensitive query 42P01s', async () => {
    setDevSandboxEnv();
    mockClient = makeSupabaseClient({
      fromResolver: (_table, calls) => {
        const inCall = calls.find(c => c.method === 'in');
        const categories: string[] = inCall?.args[1] ?? [];
        // persistent categories succeed; time-sensitive categories 42P01
        if (categories.includes('personal')) return { data: [], error: null };
        return { data: null, error: { message: 'relation "memory_items" does not exist', code: '42P01' } };
      },
    });
    const result = await fetchDevMemoryContext();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/VTID-01104/);
  });
});

// =============================================================================
// Read path: fetchMemoryContextWithIdentity (tenant scoping vs. DEV_IDENTITY fallback)
// =============================================================================

describe('fetchMemoryContextWithIdentity', () => {
  it('falls back to DEV_IDENTITY when no identity is given and the memory bridge is disabled', async () => {
    setProdEnv();
    const result = await fetchMemoryContextWithIdentity(null);
    expect(result.ok).toBe(false);
    expect(result.user_id).toBe(DEV_IDENTITY.USER_ID);
    expect(result.tenant_id).toBe(DEV_IDENTITY.TENANT_ID);
  });

  it('uses the GIVEN identity even when the memory bridge would otherwise be disabled (identity bypasses the dev-sandbox gate)', async () => {
    setProdEnv(); // not a dev environment
    mockClient = makeSupabaseClient({ fromResolver: () => ({ data: [], error: null }) });
    const result = await fetchMemoryContextWithIdentity({ user_id: 'user-999', tenant_id: 'tenant-999' });
    expect(result.user_id).toBe('user-999');
    expect(result.tenant_id).toBe('tenant-999');
    expect(result.user_id).not.toBe(DEV_IDENTITY.USER_ID);
  });

  it('scopes every memory_items query to the given identity\'s tenant_id/user_id, never another tenant\'s', async () => {
    mockClient = makeSupabaseClient({ fromResolver: () => ({ data: [], error: null }) });
    await fetchMemoryContextWithIdentity({ user_id: 'user-abc', tenant_id: 'tenant-xyz' });

    const memoryItemsCalls = (mockClient.from as jest.Mock).mock.results
      .filter((_r: any, idx: number) => (mockClient.from as jest.Mock).mock.calls[idx][0] === 'memory_items');
    expect(memoryItemsCalls.length).toBeGreaterThan(0);
    for (const r of memoryItemsCalls) {
      const eqCalls = r.value.__calls.filter((c: ChainCall) => c.method === 'eq');
      expect(eqCalls).toEqual(
        expect.arrayContaining([
          { method: 'eq', args: ['tenant_id', 'tenant-xyz'] },
          { method: 'eq', args: ['user_id', 'user-abc'] },
        ]),
      );
      // Never leaks another identity's scope onto this query.
      expect(eqCalls).not.toEqual(
        expect.arrayContaining([{ method: 'eq', args: ['tenant_id', DEV_IDENTITY.TENANT_ID] }]),
      );
    }
  });

  it('returns ok:true with an empty item set when every underlying query is empty (no crash on all-empty data)', async () => {
    mockClient = makeSupabaseClient({ fromResolver: () => ({ data: [], error: null }) });
    const result: OrbMemoryContext = await fetchMemoryContextWithIdentity({ user_id: 'user-abc', tenant_id: 'tenant-xyz' });
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.formatted_context).toBe('');
  });
});

// =============================================================================
// Read path: fetchRecentOrbUserTurns
// =============================================================================

describe('fetchRecentOrbUserTurns', () => {
  it('returns [] when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    const result = await fetchRecentOrbUserTurns({ user_id: 'u1', tenant_id: 't1' });
    expect(result).toEqual([]);
  });

  it('returns only user-direction rows, scoped to the given tenant/user, newest first as returned', async () => {
    const now = new Date().toISOString();
    mockClient = makeSupabaseClient({
      fromResolver: () => ({
        data: [
          { content: 'assistant reply, should be filtered out', content_json: { direction: 'assistant' }, occurred_at: now },
          { content: 'what did I ask last?', content_json: { direction: 'user' }, occurred_at: now },
          { content: 'an earlier user turn', content_json: { direction: 'user' }, occurred_at: now },
        ],
        error: null,
      }),
    });
    const result = await fetchRecentOrbUserTurns({ user_id: 'u1', tenant_id: 't1' }, 3);
    expect(result).toHaveLength(2);
    expect(result.every(t => t.content !== 'assistant reply, should be filtered out')).toBe(true);
    expect(result[0].content).toBe('what did I ask last?');

    const eqCalls = (mockClient.from as jest.Mock).mock.results[0].value.__calls.filter((c: ChainCall) => c.method === 'eq');
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['tenant_id', 't1'] },
        { method: 'eq', args: ['user_id', 'u1'] },
      ]),
    );
  });

  it('caps results at the requested limit', async () => {
    const now = new Date().toISOString();
    mockClient = makeSupabaseClient({
      fromResolver: () => ({
        data: Array.from({ length: 10 }, (_, i) => ({
          content: `user turn ${i}`,
          content_json: { direction: 'user' },
          occurred_at: now,
        })),
        error: null,
      }),
    });
    const result = await fetchRecentOrbUserTurns({ user_id: 'u1', tenant_id: 't1' }, 2);
    expect(result).toHaveLength(2);
  });

  it('returns [] (not a throw) when the query errors', async () => {
    mockClient = makeSupabaseClient({ fromResolver: () => ({ data: null, error: { message: 'boom' } }) });
    const result = await fetchRecentOrbUserTurns({ user_id: 'u1', tenant_id: 't1' });
    expect(result).toEqual([]);
  });
});

// =============================================================================
// buildMemoryEnhancedInstruction — pure prompt formatting
// =============================================================================

describe('buildMemoryEnhancedInstruction', () => {
  const emptyContext: OrbMemoryContext = {
    ok: false,
    user_id: 'u1',
    tenant_id: 't1',
    items: [],
    summary: '',
    formatted_context: '',
    fetched_at: new Date().toISOString(),
  };

  it('returns the base instruction unchanged when there is no memory and no activity summary', () => {
    expect(buildMemoryEnhancedInstruction('BASE', emptyContext)).toBe('BASE');
  });

  it('appends an activity-summary block even when there is no memory', () => {
    const result = buildMemoryEnhancedInstruction('BASE', emptyContext, 'logged 3 diary entries this week');
    expect(result).toContain('BASE');
    expect(result).toContain('USER CONTEXT PROFILE');
    expect(result).toContain('logged 3 diary entries this week');
  });

  it('injects a quick-reference block + the formatted memory context when memory is present', () => {
    const context: OrbMemoryContext = {
      ok: true,
      user_id: 'u1',
      tenant_id: 't1',
      items: [
        { id: 'p1', category_key: 'personal', source: 'orb_text', content: 'Name: Dragan', content_json: {}, importance: 90, occurred_at: new Date().toISOString(), created_at: new Date().toISOString() },
      ],
      summary: '1 recent items',
      formatted_context: '## User Context\n- Name: Dragan\n',
      fetched_at: new Date().toISOString(),
    };
    const result = buildMemoryEnhancedInstruction('BASE INSTRUCTION', context);
    expect(result).toContain('BASE INSTRUCTION');
    expect(result).toContain('QUICK REFERENCE');
    expect(result).toContain('Name: Dragan');
    expect(result).toContain('You KNOW this user');
    expect(result).toContain('## User Context');
  });
});

// =============================================================================
// formatRecentTurnsBlock — pure prompt formatting
// =============================================================================

describe('formatRecentTurnsBlock', () => {
  it('renders an explicit "no prior utterances" notice + no-tool-call rule when turns is empty (English)', () => {
    const block = formatRecentTurnsBlock([], 'en');
    expect(block).toContain('No prior user utterances stored');
    expect(block).toContain('Do NOT call any tools');
  });

  it('renders the German variant when lang starts with "de"', () => {
    const block = formatRecentTurnsBlock([], 'de');
    expect(block).toContain('Noch keine vorigen Nutzer-Äußerungen');
  });

  it('renders each turn verbatim, newest (first array element) first, with a relative-time label', () => {
    const now = Date.now();
    const turns = [
      { content: 'what did I just ask?', occurred_at: new Date(now - 2 * 60 * 1000).toISOString() },
      { content: 'an earlier message', occurred_at: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
    ];
    const block = formatRecentTurnsBlock(turns, 'en');
    expect(block).toContain('what did I just ask?');
    expect(block).toContain('an earlier message');
    // Order preserved as given (function does not re-sort).
    expect(block.indexOf('what did I just ask?')).toBeLessThan(block.indexOf('an earlier message'));
    expect(block).toMatch(/\[\d+ min ago\]/);
    expect(block).toMatch(/\[\d+ h ago\]/);
  });

  it('truncates very long turn content to ~300 chars with an ellipsis', () => {
    const longContent = 'x'.repeat(500);
    const block = formatRecentTurnsBlock([{ content: longContent, occurred_at: new Date().toISOString() }], 'en');
    expect(block).toContain('…');
    expect(block).not.toContain('x'.repeat(400));
  });
});
