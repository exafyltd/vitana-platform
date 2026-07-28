/**
 * VTID-01975: Memory Garden write hooks for the Intent Engine (P2-B).
 *
 * Coverage:
 * - buildFacts() → fact_key/fact_value shape per IntentKind (via
 *   writeIntentFacts()'s fetch payloads, since buildFacts is not exported).
 * - Unwired intent kinds (learning_seek, mentor_seek) silently produce zero
 *   facts and never call fetch — documented behavior, not a bug (see the
 *   file's header comment / VTID-DANCE-D2 in intent-classifier.ts).
 * - write_fact RPC call shape: URL, headers (apikey/Authorization), and
 *   fixed provenance fields (entity='self', provenance_source=
 *   'assistant_inferred', provenance_confidence=0.85).
 * - Never throws: swallows both a non-ok HTTP response and a network
 *   rejection for any individual fact write.
 * - Short-circuits (no fetch at all) when SUPABASE_URL/SERVICE_ROLE are
 *   unconfigured at module load.
 *
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE are read once at module load time
 * (`process.env.X!`), so the "unconfigured" case reloads the module fresh.
 */

import type { IntentKind } from '../../src/services/intent-classifier';

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function fetchOk() {
  return Promise.resolve({ ok: true, status: 200, text: async () => '' } as any);
}
function fetchFail(status = 500, body = 'boom') {
  return Promise.resolve({ ok: false, status, text: async () => body } as any);
}

type HooksModule = typeof import('../../src/services/intent-memory-hooks');

function loadModule(): HooksModule {
  jest.resetModules();
  return require('../../src/services/intent-memory-hooks');
}

function baseIntent(overrides: Partial<{
  user_id: string;
  tenant_id: string;
  intent_kind: IntentKind;
  category: string | null;
  title: string;
  scope: string;
  kind_payload: Record<string, unknown>;
}> = {}) {
  return {
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    intent_kind: 'commercial_buy' as IntentKind,
    category: null,
    title: 'Looking for a plumber',
    scope: 'local',
    kind_payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockImplementation(() => fetchOk());
});

// =============================================================================
// Fact shape per intent_kind
// =============================================================================

describe('writeIntentFacts() — fact shape per intent_kind', () => {
  it('commercial_buy: writes willing_to_pay_for with budget suffix and recent_buying_intent when category is set', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({
        intent_kind: 'commercial_buy',
        category: 'home_repair',
        title: 'Need a plumber',
        kind_payload: { budget_max: 150 },
      })
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const bodies = mockFetch.mock.calls.map((c) => JSON.parse(c[1].body));
    const payFact = bodies.find((b) => b.p_fact_key === 'willing_to_pay_for');
    const intentFact = bodies.find((b) => b.p_fact_key === 'recent_buying_intent');

    expect(payFact.p_fact_value).toBe('home_repair: Need a plumber (~€150)');
    expect(intentFact.p_fact_value).toBe('home_repair');
  });

  it('commercial_buy: omits budget suffix and recent_buying_intent when budget/category are absent', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({ intent_kind: 'commercial_buy', category: null, title: 'Need a plumber', kind_payload: {} })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_fact_key).toBe('willing_to_pay_for');
    expect(body.p_fact_value).toBe('service: Need a plumber');
  });

  it('commercial_sell: writes services_offered always, professional_skills only when skill_keywords is non-empty', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({
        intent_kind: 'commercial_sell',
        title: 'Offering tutoring',
        kind_payload: { skill_keywords: ['math', 'physics'] },
      })
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const bodies = mockFetch.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies.find((b) => b.p_fact_key === 'services_offered').p_fact_value).toBe('Offering tutoring');
    expect(bodies.find((b) => b.p_fact_key === 'professional_skills').p_fact_value).toBe('math, physics');
  });

  it('commercial_sell: skips professional_skills when skill_keywords is empty/absent', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(baseIntent({ intent_kind: 'commercial_sell', title: 'Offering tutoring' }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).p_fact_key).toBe('services_offered');
  });

  it('activity_seek: combines activity and joined time_windows', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({
        intent_kind: 'activity_seek',
        kind_payload: { activity: 'tennis', time_windows: ['weekday evenings', 'weekends'] },
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_fact_key).toBe('activity_partner_preferences');
    expect(body.p_fact_value).toBe('tennis · weekday evenings, weekends');
  });

  it('activity_seek: falls back to category when activity is missing, omits separator when no time_windows', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({ intent_kind: 'activity_seek', category: 'sports', kind_payload: {} })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_fact_value).toBe('sports');
  });

  it('partner_seek: builds age range + radius, sensitive fact_key', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({
        intent_kind: 'partner_seek',
        kind_payload: { age_range: [30, 45], location_radius_km: 25 },
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_fact_key).toBe('partner_seek_active');
    expect(body.p_fact_value).toBe('age 30-45 · 25km');
  });

  it('partner_seek: falls back to "active" when no payload details are given', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(baseIntent({ intent_kind: 'partner_seek', kind_payload: {} }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_fact_value).toBe('active');
  });

  it('social_seek: uses topic, falling back to category', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({ intent_kind: 'social_seek', kind_payload: { topic: 'board games' } })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_fact_key).toBe('social_seek_topics');
    expect(body.p_fact_value).toBe('board games');
  });

  it('mutual_aid: combines direction and object_or_skill (falling back to title)', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({
        intent_kind: 'mutual_aid',
        title: 'Need a ladder',
        kind_payload: { direction: 'need', object_or_skill: 'ladder' },
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.p_fact_key).toBe('mutual_aid_inventory');
    expect(body.p_fact_value).toBe('need: ladder');
  });

  it('learning_seek and mentor_seek are unwired: zero facts, no fetch call', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(baseIntent({ intent_kind: 'learning_seek' as IntentKind }));
    await mod.writeIntentFacts(baseIntent({ intent_kind: 'mentor_seek' as IntentKind }));

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// write_fact RPC call shape
// =============================================================================

describe('writeIntentFacts() — RPC call shape', () => {
  it('POSTs to the write_fact RPC with apikey/Authorization headers and fixed provenance', async () => {
    const mod = loadModule();
    await mod.writeIntentFacts(
      baseIntent({ user_id: 'user-42', tenant_id: 'tenant-42', intent_kind: 'social_seek', kind_payload: { topic: 'chess' } })
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:54321/rest/v1/rpc/write_fact',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          apikey: 'test-service-role-key',
          Authorization: 'Bearer test-service-role-key',
        }),
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      p_tenant_id: 'tenant-42',
      p_user_id: 'user-42',
      p_entity: 'self',
      p_fact_value_type: 'text',
      p_provenance_source: 'assistant_inferred',
      p_provenance_confidence: 0.85,
    });
  });
});

// =============================================================================
// Failure isolation — never throws
// =============================================================================

describe('writeIntentFacts() — never throws', () => {
  it('resolves even when the RPC responds non-ok', async () => {
    mockFetch.mockImplementation(() => fetchFail(500, 'rpc failure'));
    const mod = loadModule();

    await expect(
      mod.writeIntentFacts(baseIntent({ intent_kind: 'social_seek', kind_payload: { topic: 'chess' } }))
    ).resolves.toBeUndefined();
  });

  it('resolves even when fetch rejects with a network error', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    const mod = loadModule();

    await expect(
      mod.writeIntentFacts(baseIntent({ intent_kind: 'social_seek', kind_payload: { topic: 'chess' } }))
    ).resolves.toBeUndefined();
  });

  it('writes every fact independently: one failing fact does not block the others', async () => {
    const mod = loadModule();
    let call = 0;
    mockFetch.mockImplementation(() => {
      call += 1;
      return call === 1 ? fetchFail(500, 'first fails') : fetchOk();
    });

    await mod.writeIntentFacts(
      baseIntent({
        intent_kind: 'commercial_buy',
        category: 'home_repair',
        kind_payload: { budget_max: 100 },
      })
    );

    // Both facts (willing_to_pay_for, recent_buying_intent) were attempted
    // even though the first call failed.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Unconfigured Supabase — short-circuits before any fetch
// =============================================================================

describe('writeIntentFacts() — unconfigured Supabase', () => {
  it('never calls fetch when SUPABASE_URL is empty', async () => {
    const savedUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = '';
    const mod = loadModule();

    await mod.writeIntentFacts(baseIntent({ intent_kind: 'social_seek', kind_payload: { topic: 'chess' } }));

    expect(mockFetch).not.toHaveBeenCalled();
    process.env.SUPABASE_URL = savedUrl;
  });

  it('never calls fetch when SUPABASE_SERVICE_ROLE is empty', async () => {
    const savedKey = process.env.SUPABASE_SERVICE_ROLE;
    process.env.SUPABASE_SERVICE_ROLE = '';
    const mod = loadModule();

    await mod.writeIntentFacts(baseIntent({ intent_kind: 'social_seek', kind_payload: { topic: 'chess' } }));

    expect(mockFetch).not.toHaveBeenCalled();
    process.env.SUPABASE_SERVICE_ROLE = savedKey;
  });
});
