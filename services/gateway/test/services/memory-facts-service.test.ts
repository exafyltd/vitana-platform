// VTID-01192 — unit tests for the write_fact()/get_current_facts() wrapper
// in memory-facts-service.ts.
//
// Scope (this file):
//   1. writeFact() — inference-confidence gate, the VTID-01952 Identity
//      Lock chokepoint, RPC success/failure, entity scoping (self vs
//      disclosed), provenance fields, and the Tier-2 mirror fire-and-forget.
//   2. getCurrentFacts() — RPC mapping + tenant/user scoping.
//   3. checkFactsForDerivedAnswer() — presence / user-stated / confidence
//      checks used before answering derived questions.
//   4. formatFactsForContext() / estimateFactsTokens() — pure formatting.
//   5. Tenant isolation across repeated writes/reads for different tenants.
//
// searchFactsSemantic()/listFactsByConfidence() (the CPB-3 REST fetchers)
// and generateFactEmbeddingAsync() already have dedicated suites
// (memory-facts-fetchers.test.ts, memory-facts-service-embeddings.test.ts)
// — not duplicated here.

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    rpc: (...args: any[]) => mockRpc(...args),
  })),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

// Fire-and-forget Tier 2 mirror — stub it out so tests don't depend on its
// (separately-tested) internals, but still assert on what it was called with.
const mockMirrorFact = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/mem-tier2-writer', () => ({
  mirrorFact: (...args: any[]) => mockMirrorFact(...args),
}));

// assertWriteFact (VTID-01952) is used from the real memory-audit +
// memory-identity-lock modules — NOT mocked — so the Identity Lock
// chokepoint itself is exercised, not a stand-in for it.

import {
  writeFact,
  getCurrentFacts,
  checkFactsForDerivedAnswer,
  formatFactsForContext,
  estimateFactsTokens,
  type MemoryFact,
} from '../../src/services/memory-facts-service';

const TENANT_A = 'tenant-aaa';
const USER_B = 'user-bbb';

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  mockRpc.mockReset();
  mockEmitOasisEvent.mockClear();
  mockMirrorFact.mockClear();
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
});

// ---------------------------------------------------------------------------
// writeFact()
// ---------------------------------------------------------------------------

describe('writeFact — inference confidence gate', () => {
  it('rejects an assistant_inferred fact below the 0.70 minimum confidence, without calling the RPC', async () => {
    const result = await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_favorite_food',
      fact_value: 'pasta',
      provenance_source: 'assistant_inferred',
      provenance_confidence: 0.5,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/below minimum/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('allows an assistant_inferred fact at or above 0.70 confidence', async () => {
    mockRpc.mockResolvedValue({ data: 'fact-id-1', error: null });

    const result = await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_favorite_food',
      fact_value: 'pasta',
      provenance_source: 'assistant_inferred',
      provenance_confidence: 0.7,
    });

    expect(result.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('write_fact', expect.objectContaining({
      p_provenance_confidence: 0.7,
    }));
  });
});

describe('writeFact — Identity Lock chokepoint (VTID-01952)', () => {
  it('blocks an identity-class fact written from an unauthorized provenance_source', async () => {
    const result = await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_first_name',
      fact_value: 'Kemal',
      provenance_source: 'assistant_inferred',
      provenance_confidence: 0.95,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('identity_locked: user_first_name cannot be written from this source');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockMirrorFact).not.toHaveBeenCalled();
  });

  it('allows an identity-class fact written from an authorized UI surface', async () => {
    mockRpc.mockResolvedValue({ data: 'fact-id-2', error: null });

    const result = await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_first_name',
      fact_value: 'Maria',
      provenance_source: 'user_stated_via_settings',
      provenance_confidence: 0.99,
    });

    expect(result.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('write_fact', expect.objectContaining({
      p_fact_key: 'user_first_name',
      p_provenance_source: 'user_stated_via_settings',
    }));
  });

  it('does not apply the Identity Lock to ordinary (non-identity-class) fact keys', async () => {
    mockRpc.mockResolvedValue({ data: 'fact-id-3', error: null });

    const result = await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_favorite_color',
      fact_value: 'teal',
      provenance_source: 'assistant_inferred',
      provenance_confidence: 0.95,
    });

    expect(result.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalled();
  });
});

describe('writeFact — RPC success path (provenance + entity scope + mirror)', () => {
  it('writes with default entity="self" and provenance_source="user_stated" when omitted', async () => {
    mockRpc.mockResolvedValue({ data: 'fact-id-4', error: null });

    const result = await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_favorite_color',
      fact_value: 'teal',
    });

    expect(result).toEqual({ ok: true, fact_id: 'fact-id-4' });
    expect(mockRpc).toHaveBeenCalledWith('write_fact', {
      p_tenant_id: TENANT_A,
      p_user_id: USER_B,
      p_fact_key: 'user_favorite_color',
      p_fact_value: 'teal',
      p_entity: 'self',
      p_fact_value_type: 'text',
      p_provenance_source: 'user_stated',
      p_provenance_utterance_id: null,
      p_provenance_confidence: 0.9,
      p_thread_id: null,
    });
  });

  it('passes entity="disclosed" straight through to the RPC and to the Tier-2 mirror', async () => {
    mockRpc.mockResolvedValue({ data: 'fact-id-5', error: null });

    await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'fiancee_name',
      fact_value: 'Alex',
      entity: 'disclosed',
      provenance_source: 'user_stated',
      provenance_confidence: 0.9,
    });

    expect(mockRpc).toHaveBeenCalledWith('write_fact', expect.objectContaining({ p_entity: 'disclosed' }));
    await flushMicrotasks();
    expect(mockMirrorFact).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_A,
        user_id: USER_B,
        entity: 'disclosed',
        fact_key: 'fiancee_name',
        fact_value: 'Alex',
      })
    );
  });

  it('emits memory.fact.written with the resolved provenance on success', async () => {
    mockRpc.mockResolvedValue({ data: 'fact-id-6', error: null });

    await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_favorite_color',
      fact_value: 'teal',
      provenance_source: 'user_stated',
      provenance_confidence: 0.88,
    });

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'memory.fact.written',
      status: 'success',
      payload: expect.objectContaining({
        tenant_id: TENANT_A,
        user_id: USER_B,
        fact_key: 'user_favorite_color',
        provenance_confidence: 0.88,
      }),
    }));
  });
});

describe('writeFact — RPC failure path', () => {
  it('returns ok:false with the RPC error message and never fires the Tier-2 mirror', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'constraint violation' } });

    const result = await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_favorite_color',
      fact_value: 'teal',
    });

    expect(result).toEqual({ ok: false, error: 'constraint violation' });
    await flushMicrotasks();
    expect(mockMirrorFact).not.toHaveBeenCalled();
  });

  it('emits memory.fact.write.failed on RPC error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'constraint violation' } });

    await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_favorite_color',
      fact_value: 'teal',
    });

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'memory.fact.write.failed',
      status: 'error',
    }));
  });

  it('returns ok:false when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;

    const result = await writeFact({
      tenant_id: TENANT_A,
      user_id: USER_B,
      fact_key: 'user_favorite_color',
      fact_value: 'teal',
    });

    expect(result).toEqual({ ok: false, error: 'Supabase not configured' });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getCurrentFacts()
// ---------------------------------------------------------------------------

describe('getCurrentFacts', () => {
  it('maps RPC rows into MemoryFact, parsing provenance_confidence as a float', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          id: 'fact-7',
          entity: 'self',
          fact_key: 'user_favorite_color',
          fact_value: 'teal',
          fact_value_type: 'text',
          provenance_source: 'user_stated',
          provenance_confidence: '0.900', // Postgres numeric comes back as a string
          extracted_at: '2026-07-01T00:00:00Z',
        },
      ],
      error: null,
    });

    const result = await getCurrentFacts({ tenant_id: TENANT_A, user_id: USER_B });

    expect(result.ok).toBe(true);
    expect(result.facts).toEqual<MemoryFact[]>([
      {
        id: 'fact-7',
        entity: 'self',
        fact_key: 'user_favorite_color',
        fact_value: 'teal',
        fact_value_type: 'text',
        provenance_source: 'user_stated',
        provenance_confidence: 0.9,
        extracted_at: '2026-07-01T00:00:00Z',
      },
    ]);
  });

  it('scopes the RPC call to the caller tenant_id + user_id, never swapped', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await getCurrentFacts({ tenant_id: 'tenant-XYZ', user_id: 'user-QRS', entity: 'disclosed' });

    expect(mockRpc).toHaveBeenCalledWith('get_current_facts', {
      p_tenant_id: 'tenant-XYZ',
      p_user_id: 'user-QRS',
      p_entity: 'disclosed',
      p_fact_keys: null,
    });
  });

  it('returns ok:false with empty facts on RPC error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db down' } });

    const result = await getCurrentFacts({ tenant_id: TENANT_A, user_id: USER_B });

    expect(result).toEqual({ ok: false, facts: [], error: 'db down' });
  });

  it('returns ok:false when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;

    const result = await getCurrentFacts({ tenant_id: TENANT_A, user_id: USER_B });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Supabase not configured');
  });
});

// ---------------------------------------------------------------------------
// checkFactsForDerivedAnswer()
// ---------------------------------------------------------------------------

describe('checkFactsForDerivedAnswer', () => {
  function factRow(overrides: Partial<any> = {}) {
    return {
      id: 'f-1',
      entity: 'self',
      fact_key: 'user_goal',
      fact_value: 'run a marathon',
      fact_value_type: 'text',
      provenance_source: 'user_stated',
      provenance_confidence: '0.95',
      extracted_at: '2026-07-01T00:00:00Z',
      ...overrides,
    };
  }

  it('is all-true when every required fact is present, user-stated, and high-confidence', async () => {
    mockRpc.mockResolvedValue({ data: [factRow()], error: null });

    const result = await checkFactsForDerivedAnswer({
      tenant_id: TENANT_A,
      user_id: USER_B,
      required_facts: ['user_goal'],
    });

    expect(result.ok).toBe(true);
    expect(result.all_present).toBe(true);
    expect(result.all_user_stated).toBe(true);
    expect(result.all_high_confidence).toBe(true);
    expect(result.missing_facts).toEqual([]);
    expect(result.low_confidence_facts).toEqual([]);
  });

  it('reports missing_facts for required keys the store has no row for', async () => {
    mockRpc.mockResolvedValue({ data: [factRow()], error: null });

    const result = await checkFactsForDerivedAnswer({
      tenant_id: TENANT_A,
      user_id: USER_B,
      required_facts: ['user_goal', 'user_deadline'],
    });

    expect(result.all_present).toBe(false);
    expect(result.missing_facts).toEqual(['user_deadline']);
  });

  it('flags facts below 0.90 confidence in low_confidence_facts', async () => {
    mockRpc.mockResolvedValue({
      data: [factRow({ fact_key: 'user_weak_fact', provenance_confidence: '0.6' })],
      error: null,
    });

    const result = await checkFactsForDerivedAnswer({
      tenant_id: TENANT_A,
      user_id: USER_B,
      required_facts: ['user_weak_fact'],
    });

    expect(result.all_high_confidence).toBe(false);
    expect(result.low_confidence_facts).toEqual(['user_weak_fact']);
  });

  it('sets all_user_stated=false when a fact came from assistant_inferred', async () => {
    mockRpc.mockResolvedValue({
      data: [factRow({ provenance_source: 'assistant_inferred' })],
      error: null,
    });

    const result = await checkFactsForDerivedAnswer({
      tenant_id: TENANT_A,
      user_id: USER_B,
      required_facts: ['user_goal'],
    });

    expect(result.all_user_stated).toBe(false);
  });

  it('fails closed (ok:false, everything missing) when the underlying read fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db down' } });

    const result = await checkFactsForDerivedAnswer({
      tenant_id: TENANT_A,
      user_id: USER_B,
      required_facts: ['user_goal', 'user_deadline'],
    });

    expect(result.ok).toBe(false);
    expect(result.all_present).toBe(false);
    expect(result.missing_facts).toEqual(['user_goal', 'user_deadline']);
    expect(result.facts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatFactsForContext() / estimateFactsTokens() — pure formatting
// ---------------------------------------------------------------------------

describe('formatFactsForContext', () => {
  const baseFact: MemoryFact = {
    id: 'f-1',
    entity: 'self',
    fact_key: 'user_favorite_color',
    fact_value: 'teal',
    fact_value_type: 'text',
    provenance_source: 'user_stated',
    provenance_confidence: 0.9,
    extracted_at: '2026-07-01T00:00:00Z',
  };

  it('returns an empty string for an empty fact list', () => {
    expect(formatFactsForContext([])).toBe('');
  });

  it('title-cases snake_case fact keys under a "Known facts" header for self facts', () => {
    const text = formatFactsForContext([baseFact]);
    expect(text).toContain('Known facts about the user:');
    expect(text).toContain('- User Favorite Color: teal');
  });

  it('lists disclosed facts under their own "disclosed by the user" section', () => {
    const disclosed: MemoryFact = { ...baseFact, id: 'f-2', entity: 'disclosed', fact_key: 'fiancee_name', fact_value: 'Alex' };
    const text = formatFactsForContext([baseFact, disclosed]);

    expect(text).toContain('Facts disclosed by the user about others:');
    expect(text).toContain('- Fiancee Name: Alex');
    // self section appears before the disclosed section
    expect(text.indexOf('Favorite Color')).toBeLessThan(text.indexOf('Facts disclosed'));
  });

  it('omits the disclosed section entirely when there are no disclosed facts', () => {
    const text = formatFactsForContext([baseFact]);
    expect(text).not.toContain('disclosed');
  });
});

describe('estimateFactsTokens', () => {
  it('returns 0 for an empty fact list', () => {
    expect(estimateFactsTokens([])).toBe(0);
  });

  it('approximates ceil(formatted_length / 4) for a non-empty list', () => {
    const fact: MemoryFact = {
      id: 'f-1',
      entity: 'self',
      fact_key: 'user_favorite_color',
      fact_value: 'teal',
      fact_value_type: 'text',
      provenance_source: 'user_stated',
      provenance_confidence: 0.9,
      extracted_at: '2026-07-01T00:00:00Z',
    };
    const formatted = formatFactsForContext([fact]);
    expect(estimateFactsTokens([fact])).toBe(Math.ceil(formatted.length / 4));
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation across repeated calls
// ---------------------------------------------------------------------------

describe('memory-facts-service tenant isolation', () => {
  it('writeFact for two different tenants never cross-contaminates the RPC payload', async () => {
    mockRpc.mockResolvedValue({ data: 'fact-id', error: null });

    await writeFact({ tenant_id: 'tenant-1', user_id: USER_B, fact_key: 'user_favorite_color', fact_value: 'red' });
    await writeFact({ tenant_id: 'tenant-2', user_id: USER_B, fact_key: 'user_favorite_color', fact_value: 'blue' });

    const tenantIds = mockRpc.mock.calls.map((c) => c[1].p_tenant_id);
    const values = mockRpc.mock.calls.map((c) => c[1].p_fact_value);
    expect(tenantIds).toEqual(['tenant-1', 'tenant-2']);
    expect(values).toEqual(['red', 'blue']);
  });

  it('getCurrentFacts for two different tenants issues independently-scoped RPC calls', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await getCurrentFacts({ tenant_id: 'tenant-1', user_id: USER_B });
    await getCurrentFacts({ tenant_id: 'tenant-2', user_id: USER_B });

    const tenantIds = mockRpc.mock.calls.map((c) => c[1].p_tenant_id);
    expect(tenantIds).toEqual(['tenant-1', 'tenant-2']);
  });
});
