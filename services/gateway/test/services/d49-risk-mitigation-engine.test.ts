// VTID-01143 — unit tests for the D49 Proactive Health & Lifestyle Risk
// Mitigation Layer (d49-risk-mitigation-engine.ts).
//
// Scope:
//   1. Pure determinism helpers — hashInput() (incl. the recursive
//      array-replacer bug fixed alongside this suite — see the BUGFIX
//      comment on hashInput in the source), generateDeterminismKey(),
//      findMatchingRule() (confidence gate incl. exact 75% boundary,
//      first-matching-rule semantics), generateMitigationFromRule()
//      (confidence rounding, expiry, evidence mapping, safe-language
//      disclaimer, static effort_level/dismissible/status).
//   2. Client/context resolution — UNAUTHENTICATED / SERVICE_UNAVAILABLE,
//      dev-sandbox bootstrap RPC (non-fatal on failure), dev-identity
//      fallback when user_context.user_id is empty.
//   3. generateMitigations() — confidence threshold skip, no-matching-rule
//      skip, cooldown skip (+ OASIS event), MAX_ACTIVE_MITIGATIONS cap,
//      successful generation + insert + OASIS event, insert-error
//      tolerance (still returns ok:true), determinism (same inputs ->
//      same hash across two separate calls), outer catch on a malformed
//      request.
//   4. dismissMitigation / getActiveMitigations / getMitigationHistory /
//      acknowledgeMitigation / expireOldMitigations — success/error paths.
//   5. Isolation note: unlike D48, D49's read/update queries do not add
//      explicit `.eq('user_id', ...)`/`.eq('tenant_id', ...)` filters in
//      TypeScript — isolation is delegated entirely to the Postgres RLS
//      policy `risk_mitigations_select_own` (`auth.uid() = user_id`,
//      confirmed in database/migrations/20260103_vtid_01143_d49_risk_mitigation.sql).
//      That only holds if the *user-scoped* Supabase client (Authorization
//      bearer token) is used for those calls; a test below locks in that
//      createUserClient (not the service-role client) is what's used
//      whenever an authToken is supplied.

const mockCreateClient = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import {
  generateMitigations,
  dismissMitigation,
  getActiveMitigations,
  getMitigationHistory,
  acknowledgeMitigation,
  expireOldMitigations,
  VTID,
  BUILTIN_MITIGATION_RULES,
  hashInput,
  generateDeterminismKey,
  findMatchingRule,
  generateMitigationFromRule,
} from '../../src/services/d49-risk-mitigation-engine';
import type { RiskWindowInput, UserContext } from '../../src/types/risk-mitigation';
import { MITIGATION_THRESHOLDS, SAFE_LANGUAGE_PATTERNS } from '../../src/types/risk-mitigation';

// ---------------------------------------------------------------------------
// Chainable Supabase mock (same shape as the D48 suite)
// ---------------------------------------------------------------------------

interface ChainState {
  table: string;
  calls: [string, any[]][];
}

function makeSupabase(responses: Record<string, any>, rpcResult: any = { data: null, error: null }) {
  const callIndex: Record<string, number> = {};
  const history: ChainState[] = [];
  const rpcCalls: any[] = [];

  function builder(table: string) {
    const state: ChainState = { table, calls: [] };
    const chain: any = {};
    const methods = ['select', 'insert', 'update', 'eq', 'gte', 'lt', 'in', 'order', 'limit', 'single'];
    for (const m of methods) {
      chain[m] = (...args: any[]) => {
        state.calls.push([m, args]);
        return chain;
      };
    }
    chain.then = (resolve: any, reject: any) => {
      history.push(state);
      const idx = callIndex[table] || 0;
      callIndex[table] = idx + 1;
      let entry = responses[table];
      let result: any;
      if (typeof entry === 'function') {
        result = entry(state, idx);
      } else if (Array.isArray(entry)) {
        result = entry[idx] ?? entry[entry.length - 1] ?? { data: null, error: null };
      } else {
        result = entry ?? { data: null, error: null };
      }
      return Promise.resolve(result).then(resolve, reject);
    };
    return chain;
  }

  return {
    from: jest.fn((t: string) => builder(t)),
    rpc: jest.fn((...args: any[]) => {
      rpcCalls.push(args);
      return Promise.resolve(rpcResult);
    }),
    _history: history,
    _rpcCalls: rpcCalls,
    _callsFor(table: string): ChainState[] {
      return history.filter((h) => h.table === table);
    },
  };
}

const TENANT = '00000000-0000-0000-0000-0000000000t1';
const USER = '00000000-0000-0000-0000-0000000000u1';
const RISK_WINDOW_ID = '00000000-0000-0000-0000-0000000000r1';

function userContext(overrides: Partial<UserContext> = {}): UserContext {
  return { user_id: USER, tenant_id: TENANT, ...overrides };
}

function riskWindow(overrides: Partial<RiskWindowInput> = {}): RiskWindowInput {
  return {
    risk_window_id: RISK_WINDOW_ID,
    risk_type: 'fatigue',
    confidence: 80,
    severity: 'medium',
    start_time: '2026-07-28T00:00:00.000Z',
    domains_affected: ['sleep'],
    ...overrides,
  };
}

const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  mockEmitOasisEvent.mockResolvedValue({ ok: true, event_id: 'evt-1' });
  process.env = { ...OLD_ENV };
  delete process.env.ENVIRONMENT;
  delete process.env.VITANA_ENV;
  // Global setup-tests.ts sets SUPABASE_URL/SUPABASE_SERVICE_ROLE but not
  // the anon key — createUserClient() (used for every authToken-based call
  // below) requires it, or it silently returns null.
  process.env.SUPABASE_ANON_KEY = 'test-anon-key-mock';
});

afterAll(() => {
  process.env = OLD_ENV;
});

function eventTypes() {
  return mockEmitOasisEvent.mock.calls.map((c) => c[0].type);
}

// ---------------------------------------------------------------------------
// 1. Pure determinism helpers
// ---------------------------------------------------------------------------

describe('hashInput', () => {
  it('returns a 16-char hex digest', () => {
    const h = hashInput({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic regardless of top-level key insertion order', () => {
    const h1 = hashInput({ a: 1, b: 2 });
    const h2 = hashInput({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('reflects the content of nested objects (regression for the array-replacer bug)', () => {
    // BUGFIX regression: previously, JSON.stringify(input, Object.keys(input).sort())
    // silently stripped every property of any nested object down to `{}`,
    // so two completely different risk windows hashed identically as long
    // as the top-level keys (rule_id/user_id) matched.
    const a = hashInput({
      risk_window: { risk_window_id: 'aaa', risk_type: 'fatigue', confidence: 80 },
      rule_id: 'sleep-fatigue-wind-down',
      user_id: 'u1',
    });
    const b = hashInput({
      risk_window: { risk_window_id: 'bbb', risk_type: 'sleep_deficit', confidence: 99 },
      rule_id: 'sleep-fatigue-wind-down',
      user_id: 'u1',
    });
    expect(a).not.toBe(b);
  });

  it('is deterministic regardless of nested-object key insertion order', () => {
    const a = hashInput({ outer: { x: 1, y: 2 } });
    const b = hashInput({ outer: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it('produces the same hash for two structurally identical inputs built independently', () => {
    const build = () => ({
      risk_window: riskWindow(),
      rule_id: 'sleep-fatigue-wind-down',
      user_id: USER,
    });
    expect(hashInput(build())).toBe(hashInput(build()));
  });
});

describe('generateDeterminismKey', () => {
  it('formats domain:riskType:suggestionHash', () => {
    expect(generateDeterminismKey('sleep', 'fatigue', 'abc123')).toBe('sleep:fatigue:abc123');
  });
});

describe('findMatchingRule', () => {
  it('returns null when confidence is below MIN_RISK_CONFIDENCE (75)', () => {
    const rule = findMatchingRule(riskWindow({ confidence: 74, risk_type: 'fatigue' }));
    expect(rule).toBeNull();
  });

  it('matches at exactly the 75% confidence boundary', () => {
    const rule = findMatchingRule(riskWindow({ confidence: 75, risk_type: 'fatigue' }));
    expect(rule).not.toBeNull();
    expect(rule!.id).toBe('sleep-fatigue-wind-down');
  });

  it('returns null when no rule triggers on the given risk_type', () => {
    const rule = findMatchingRule(riskWindow({ confidence: 90, risk_type: 'completely_unknown_risk' }));
    expect(rule).toBeNull();
  });

  it('returns the first rule (by BUILTIN_MITIGATION_RULES order) whose trigger_risk_types include the risk type', () => {
    const rule = findMatchingRule(riskWindow({ confidence: 90, risk_type: 'dehydration' }));
    expect(rule?.id).toBe('nutrition-hydration');
  });

  it('every BUILTIN_MITIGATION_RULES entry is independently reachable', () => {
    for (const rule of BUILTIN_MITIGATION_RULES) {
      const matched = findMatchingRule(
        riskWindow({ risk_type: rule.trigger_risk_types[0], confidence: 100 }),
      );
      expect(matched?.id).toBe(rule.id);
    }
  });
});

describe('generateMitigationFromRule', () => {
  it('rounds confidence to min(100, riskWindow.confidence * 0.9)', () => {
    const rule = BUILTIN_MITIGATION_RULES.find((r) => r.id === 'sleep-fatigue-wind-down')!;
    const m1 = generateMitigationFromRule(rule, riskWindow({ confidence: 100 }), userContext());
    expect(m1.confidence).toBe(90);
    const m2 = generateMitigationFromRule(rule, riskWindow({ confidence: 80 }), userContext());
    expect(m2.confidence).toBe(72);
  });

  it('sets expires_at to created_at + DEFAULT_EXPIRY_HOURS', () => {
    const rule = BUILTIN_MITIGATION_RULES.find((r) => r.id === 'sleep-fatigue-wind-down')!;
    const m = generateMitigationFromRule(rule, riskWindow(), userContext());
    const createdMs = new Date(m.created_at).getTime();
    const expiresMs = new Date(m.expires_at!).getTime();
    expect(expiresMs - createdMs).toBe(MITIGATION_THRESHOLDS.DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000);
  });

  it('maps evidence signal_ids into source_signals, dropping falsy entries', () => {
    const rule = BUILTIN_MITIGATION_RULES.find((r) => r.id === 'sleep-fatigue-wind-down')!;
    const m = generateMitigationFromRule(
      rule,
      riskWindow({
        evidence: [
          { signal_id: 'sig-1', description: 'evidence 1', weight: 0.5 },
          { description: 'no signal id', weight: 0.5 },
        ],
      }),
      userContext(),
    );
    expect(m.source_signals).toEqual(['sig-1']);
  });

  it('always sets effort_level=low, dismissible=true, status=active, and the first safe-language disclaimer', () => {
    const rule = BUILTIN_MITIGATION_RULES.find((r) => r.id === 'sleep-fatigue-wind-down')!;
    const m = generateMitigationFromRule(rule, riskWindow(), userContext());
    expect(m.effort_level).toBe('low');
    expect(m.dismissible).toBe(true);
    expect(m.status).toBe('active');
    expect(m.disclaimer).toBe(SAFE_LANGUAGE_PATTERNS.disclaimers[0]);
    expect(m.risk_window_id).toBe(riskWindow().risk_window_id);
    expect(m.domain).toBe('sleep');
    expect(m.suggested_adjustment).toBe(rule.suggestion_template);
    expect(m.why_this_helps).toBe(rule.explanation_template);
  });
});

// ---------------------------------------------------------------------------
// 2. Client/context resolution
// ---------------------------------------------------------------------------

describe('generateMitigations — client/context resolution', () => {
  it('returns UNAUTHENTICATED with no authToken and not dev-sandbox', async () => {
    const res = await generateMitigations({ risk_windows: [], user_context: userContext() });
    expect(res).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('returns SERVICE_UNAVAILABLE when an authToken is given but SUPABASE_URL is unset', async () => {
    delete process.env.SUPABASE_URL;
    const res = await generateMitigations(
      { risk_windows: [], user_context: userContext() },
      'a-jwt-token',
    );
    expect(res).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' });
  });

  it('bootstraps dev identity via RPC in dev-sandbox mode and still proceeds when the RPC call errors (non-fatal)', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase(
      { risk_mitigations: { data: [], error: null } },
      { data: null, error: { message: 'bootstrap failed' } },
    );
    mockCreateClient.mockReturnValue(supa);

    const res = await generateMitigations({ risk_windows: [], user_context: userContext() });
    expect(res.ok).toBe(true);
    expect(supa._rpcCalls[0][0]).toBe('dev_bootstrap_request_context');
  });

  it('falls back to the DEV_IDENTITY user only when user_context supplies an empty user_id (dev-sandbox); tenant_id is unaffected since it was truthy', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const rw = riskWindow({ confidence: 90 });
    const res = await generateMitigations({
      risk_windows: [rw],
      user_context: userContext({ user_id: '' as any }),
    });
    expect(res.ok).toBe(true);
    const insertCall = supa._callsFor('risk_mitigations').find((c) => c.calls.some(([m]) => m === 'insert'));
    const insertPayload = insertCall!.calls.find(([m]) => m === 'insert')![1][0];
    // `effectiveUserId = request.user_context.user_id || userId` — empty
    // string is falsy, so the DEV_IDENTITY fallback kicks in for the user.
    expect(insertPayload.user_id).toBe('00000000-0000-0000-0000-000000000099');
    // tenant_id was supplied truthy on user_context, so it is NOT replaced
    // by the DEV_IDENTITY tenant fallback.
    expect(insertPayload.tenant_id).toBe(TENANT);
  });

  it('falls back to the DEV_IDENTITY tenant too when user_context supplies an empty tenant_id, in dev-sandbox mode', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const rw = riskWindow({ confidence: 90 });
    const res = await generateMitigations({
      risk_windows: [rw],
      user_context: userContext({ tenant_id: '' as any }),
    });
    expect(res.ok).toBe(true);
    const insertCall = supa._callsFor('risk_mitigations').find((c) => c.calls.some(([m]) => m === 'insert'));
    const insertPayload = insertCall!.calls.find(([m]) => m === 'insert')![1][0];
    expect(insertPayload.tenant_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(insertPayload.user_id).toBe(USER);
  });
});

// ---------------------------------------------------------------------------
// 3. generateMitigations() core logic
// ---------------------------------------------------------------------------

describe('generateMitigations — core generation logic', () => {
  it('skips a risk window below MIN_RISK_CONFIDENCE with an explanatory reason', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const res = await generateMitigations(
      { risk_windows: [riskWindow({ confidence: 50 })], user_context: userContext() },
      'jwt',
    );
    expect(res.ok).toBe(true);
    expect(res.mitigations).toEqual([]);
    expect(res.skipped_count).toBe(1);
  });

  it('skips a risk window whose risk_type matches no rule', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const res = await generateMitigations(
      { risk_windows: [riskWindow({ risk_type: 'nonexistent_type', confidence: 90 })], user_context: userContext() },
      'jwt',
    );
    expect(res.ok).toBe(true);
    expect(res.mitigations).toEqual([]);
    expect(res.skipped_count).toBe(1);
  });

  it('skips (with an OASIS info event) a mitigation recently shown within its cooldown window', async () => {
    const supa = makeSupabase({
      risk_mitigations: { data: [{ id: 'existing', created_at: new Date().toISOString() }], error: null },
    });
    mockCreateClient.mockReturnValue(supa);

    const res = await generateMitigations(
      { risk_windows: [riskWindow({ confidence: 90 })], user_context: userContext() },
      'jwt',
    );
    expect(res.ok).toBe(true);
    expect(res.mitigations).toEqual([]);
    expect(res.skipped_count).toBe(1);
    expect(eventTypes()).toContain('risk_mitigation.skipped');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'risk_mitigation.skipped', status: 'info' }),
    );
  });

  it('caps generation at MAX_ACTIVE_MITIGATIONS per call, skipping the rest', async () => {
    const supa = makeSupabase({
      risk_mitigations: { data: [], error: null }, // never in cooldown
    });
    mockCreateClient.mockReturnValue(supa);

    // 6 distinct rules (>MAX_ACTIVE_MITIGATIONS=5), each independently eligible.
    const windows = BUILTIN_MITIGATION_RULES.slice(0, 6).map((rule, i) =>
      riskWindow({
        risk_window_id: `00000000-0000-0000-0000-00000000a0${i}`,
        risk_type: rule.trigger_risk_types[0],
        confidence: 95,
      }),
    );

    const res = await generateMitigations({ risk_windows: windows, user_context: userContext() }, 'jwt');
    expect(res.ok).toBe(true);
    expect(res.mitigations).toHaveLength(MITIGATION_THRESHOLDS.MAX_ACTIVE_MITIGATIONS);
    expect(res.skipped_count).toBe(1);
  });

  it('generates + inserts a mitigation and emits a success OASIS event', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const res = await generateMitigations(
      { risk_windows: [riskWindow({ confidence: 90 })], user_context: userContext() },
      'jwt',
    );
    expect(res.ok).toBe(true);
    expect(res.mitigations).toHaveLength(1);
    expect(res.mitigations![0].domain).toBe('sleep');

    const insertCall = supa._callsFor('risk_mitigations').find((c) => c.calls.some(([m]) => m === 'insert'));
    expect(insertCall).toBeDefined();
    const payload = insertCall!.calls.find(([m]) => m === 'insert')![1][0];
    expect(payload).toMatchObject({
      tenant_id: TENANT,
      user_id: USER,
      domain: 'sleep',
      status: 'active',
    });

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'risk_mitigation.generated', status: 'success' }),
    );
  });

  it('still returns ok:true with the generated mitigation even if the insert fails', async () => {
    const supa = makeSupabase({
      risk_mitigations: [{ data: [], error: null }, { error: { message: 'insert boom' } }],
    });
    mockCreateClient.mockReturnValue(supa);

    const res = await generateMitigations(
      { risk_windows: [riskWindow({ confidence: 90 })], user_context: userContext() },
      'jwt',
    );
    expect(res.ok).toBe(true);
    expect(res.mitigations).toHaveLength(1);
  });

  it('produces an identical input_hash across two calls with structurally identical risk-window input (determinism)', async () => {
    const supa1 = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValueOnce(supa1);
    const res1 = await generateMitigations(
      { risk_windows: [riskWindow({ confidence: 90 })], user_context: userContext() },
      'jwt',
    );

    const supa2 = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValueOnce(supa2);
    const res2 = await generateMitigations(
      { risk_windows: [riskWindow({ confidence: 90 })], user_context: userContext() },
      'jwt',
    );

    expect(res1.mitigations![0].input_hash).toBe(res2.mitigations![0].input_hash);
  });

  it('catches a thrown error (malformed request) and reports it without throwing, emitting an error OASIS event', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const res = await generateMitigations({ user_context: userContext() } as any, 'jwt');
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(eventTypes()).toContain('risk_mitigation.error');
  });
});

// ---------------------------------------------------------------------------
// 4. dismissMitigation
// ---------------------------------------------------------------------------

describe('dismissMitigation', () => {
  it('returns UNAUTHENTICATED with no authToken and not dev-sandbox', async () => {
    const res = await dismissMitigation({ mitigation_id: 'mit-1' });
    expect(res).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('updates status=dismissed and emits an OASIS event on success', async () => {
    const supa = makeSupabase({
      risk_mitigations: { data: { id: 'mit-1', domain: 'sleep' }, error: null },
    });
    mockCreateClient.mockReturnValue(supa);

    const res = await dismissMitigation({ mitigation_id: 'mit-1', reason: 'not_relevant' }, 'jwt');
    expect(res.ok).toBe(true);
    expect(res.mitigation_id).toBe('mit-1');

    const call = supa._callsFor('risk_mitigations')[0];
    const updateArgs = call.calls.find(([m]) => m === 'update')![1][0];
    expect(updateArgs).toMatchObject({ status: 'dismissed', dismiss_reason: 'not_relevant' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'risk_mitigation.dismissed' }),
    );
  });

  it('returns NOT_FOUND when the update matches no row', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: null, error: null } });
    mockCreateClient.mockReturnValue(supa);
    const res = await dismissMitigation({ mitigation_id: 'missing' }, 'jwt');
    expect(res).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('propagates a supabase update error', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: null, error: { message: 'update boom' } } });
    mockCreateClient.mockReturnValue(supa);
    const res = await dismissMitigation({ mitigation_id: 'mit-1' }, 'jwt');
    expect(res).toEqual({ ok: false, error: 'update boom' });
  });
});

// ---------------------------------------------------------------------------
// 5. getActiveMitigations
// ---------------------------------------------------------------------------

describe('getActiveMitigations', () => {
  it('returns UNAUTHENTICATED with no authToken and not dev-sandbox', async () => {
    const res = await getActiveMitigations({ limit: 10 });
    expect(res).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('queries status=active + expires_at>=now, applies the limit, and maps rows', async () => {
    const row = {
      id: 'mit-1',
      risk_window_id: RISK_WINDOW_ID,
      domain: 'sleep',
      confidence: 72,
      suggested_adjustment: 'Consider winding down',
      why_this_helps: 'Rest helps',
      source_signals: [],
      precedent_type: 'general_safety',
      disclaimer: SAFE_LANGUAGE_PATTERNS.disclaimers[0],
      status: 'active',
      created_at: '2026-07-28T00:00:00.000Z',
      expires_at: '2026-07-29T00:00:00.000Z',
      dismissed_at: null,
      generated_by_version: '1.0.0',
      input_hash: 'abc',
    };
    const supa = makeSupabase({ risk_mitigations: { data: [row], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const res = await getActiveMitigations({ limit: 7 }, 'jwt');
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.mitigations![0]).toMatchObject({
      mitigation_id: 'mit-1',
      domain: 'sleep',
      effort_level: 'low',
      dismissible: true,
    });

    const call = supa._callsFor('risk_mitigations')[0];
    const eqArgs = call.calls.filter(([m]) => m === 'eq').map(([, a]) => a);
    expect(eqArgs).toEqual(expect.arrayContaining([['status', 'active']]));
    expect(call.calls.some(([m]) => m === 'gte')).toBe(true);
    expect(call.calls.find(([m]) => m === 'limit')![1]).toEqual([7]);
  });

  it('applies the domains filter only when domains is provided', async () => {
    const supa1 = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValueOnce(supa1);
    await getActiveMitigations({ limit: 10 }, 'jwt');
    expect(supa1._callsFor('risk_mitigations')[0].calls.some(([m]) => m === 'in')).toBe(false);

    const supa2 = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValueOnce(supa2);
    await getActiveMitigations({ limit: 10, domains: ['sleep', 'mental'] }, 'jwt');
    const inCall = supa2._callsFor('risk_mitigations')[0].calls.find(([m]) => m === 'in');
    expect(inCall![1]).toEqual(['domain', ['sleep', 'mental']]);
  });

  it('uses the user-scoped (JWT) Supabase client, not the service-role client, when an authToken is supplied', async () => {
    // Isolation for D49 reads is delegated to Postgres RLS
    // (risk_mitigations_select_own: auth.uid() = user_id), which only
    // takes effect through the user-scoped client (Authorization header
    // carrying the caller's JWT). This locks in that createClient is
    // invoked with the anon key + bearer header path, not the
    // service-role path, whenever authToken is supplied.
    mockCreateClient.mockReturnValue(makeSupabase({ risk_mitigations: { data: [], error: null } }));
    await getActiveMitigations({ limit: 10 }, 'a-real-jwt');

    expect(mockCreateClient).toHaveBeenCalledWith(
      expect.any(String),
      process.env.SUPABASE_ANON_KEY,
      expect.objectContaining({
        global: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer a-real-jwt' }),
        }),
      }),
    );
    // Never the service-role key path for an authenticated caller.
    expect(mockCreateClient).not.toHaveBeenCalledWith(
      expect.any(String),
      process.env.SUPABASE_SERVICE_ROLE,
      expect.anything(),
    );
  });

  it('propagates a supabase select error', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: null, error: { message: 'select boom' } } });
    mockCreateClient.mockReturnValue(supa);
    const res = await getActiveMitigations({ limit: 10 }, 'jwt');
    expect(res).toEqual({ ok: false, error: 'select boom' });
  });
});

// ---------------------------------------------------------------------------
// 6. getMitigationHistory
// ---------------------------------------------------------------------------

describe('getMitigationHistory', () => {
  it('returns UNAUTHENTICATED with no authToken and not dev-sandbox', async () => {
    const res = await getMitigationHistory({ limit: 20 });
    expect(res).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('applies domains/statuses/since filters only when provided', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);

    await getMitigationHistory(
      { limit: 20, domains: ['sleep'], statuses: ['dismissed'], since: '2026-07-01T00:00:00.000Z' },
      'jwt',
    );
    const call = supa._callsFor('risk_mitigations')[0];
    const inCalls = call.calls.filter(([m]) => m === 'in').map(([, a]) => a);
    expect(inCalls).toEqual(
      expect.arrayContaining([
        ['domain', ['sleep']],
        ['status', ['dismissed']],
      ]),
    );
    expect(call.calls.some(([m]) => m === 'gte')).toBe(true);
  });

  it('omits in()/gte() filters entirely when none are provided', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);
    await getMitigationHistory({ limit: 20 }, 'jwt');
    const call = supa._callsFor('risk_mitigations')[0];
    expect(call.calls.some(([m]) => m === 'in')).toBe(false);
    expect(call.calls.some(([m]) => m === 'gte')).toBe(false);
  });

  it('propagates a supabase select error', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: null, error: { message: 'history boom' } } });
    mockCreateClient.mockReturnValue(supa);
    const res = await getMitigationHistory({ limit: 20 }, 'jwt');
    expect(res).toEqual({ ok: false, error: 'history boom' });
  });
});

// ---------------------------------------------------------------------------
// 7. acknowledgeMitigation
// ---------------------------------------------------------------------------

describe('acknowledgeMitigation', () => {
  it('returns UNAUTHENTICATED with no authToken and not dev-sandbox', async () => {
    const res = await acknowledgeMitigation('mit-1');
    expect(res).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('only updates rows currently status=active, setting status=acknowledged, and emits an OASIS event', async () => {
    const supa = makeSupabase({ risk_mitigations: { error: null } });
    mockCreateClient.mockReturnValue(supa);

    const res = await acknowledgeMitigation('mit-1', 'jwt');
    expect(res.ok).toBe(true);

    const call = supa._callsFor('risk_mitigations')[0];
    const updateArgs = call.calls.find(([m]) => m === 'update')![1][0];
    expect(updateArgs.status).toBe('acknowledged');
    const eqArgs = call.calls.filter(([m]) => m === 'eq').map(([, a]) => a);
    expect(eqArgs).toEqual(expect.arrayContaining([['id', 'mit-1'], ['status', 'active']]));
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'risk_mitigation.acknowledged' }),
    );
  });

  it('propagates a supabase update error', async () => {
    const supa = makeSupabase({ risk_mitigations: { error: { message: 'ack boom' } } });
    mockCreateClient.mockReturnValue(supa);
    const res = await acknowledgeMitigation('mit-1', 'jwt');
    expect(res).toEqual({ ok: false, error: 'ack boom' });
  });
});

// ---------------------------------------------------------------------------
// 8. expireOldMitigations
// ---------------------------------------------------------------------------

describe('expireOldMitigations', () => {
  it('returns UNAUTHENTICATED with no authToken and not dev-sandbox', async () => {
    const res = await expireOldMitigations();
    expect(res).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('sets status=expired for rows past expiry, returns the count, and emits an event only when count>0', async () => {
    const supa = makeSupabase({
      risk_mitigations: { data: [{ id: 'mit-1' }, { id: 'mit-2' }], error: null },
    });
    mockCreateClient.mockReturnValue(supa);

    const res = await expireOldMitigations('jwt');
    expect(res).toEqual({ ok: true, expired_count: 2 });

    const call = supa._callsFor('risk_mitigations')[0];
    const updateArgs = call.calls.find(([m]) => m === 'update')![1][0];
    expect(updateArgs.status).toBe('expired');
    expect(call.calls.some(([m]) => m === 'lt')).toBe(true);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'risk_mitigation.expired' }),
    );
  });

  it('does not emit an event when nothing expired', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);
    const res = await expireOldMitigations('jwt');
    expect(res).toEqual({ ok: true, expired_count: 0 });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('propagates a supabase update error', async () => {
    const supa = makeSupabase({ risk_mitigations: { data: null, error: { message: 'expire boom' } } });
    mockCreateClient.mockReturnValue(supa);
    const res = await expireOldMitigations('jwt');
    expect(res).toEqual({ ok: false, error: 'expire boom' });
  });
});

// ---------------------------------------------------------------------------
// 9. Module-level constants sanity
// ---------------------------------------------------------------------------

describe('module constants', () => {
  it('exports the documented VTID', () => {
    expect(VTID).toBe('VTID-01143');
  });

  it('every builtin rule enforces the 75% minimum confidence spec floor', () => {
    for (const rule of BUILTIN_MITIGATION_RULES) {
      expect(rule.min_confidence).toBeGreaterThanOrEqual(MITIGATION_THRESHOLDS.MIN_RISK_CONFIDENCE);
    }
  });
});
