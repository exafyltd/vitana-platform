/**
 * VTID-03260 — Propose-then-approve shopping agent gateway slice tests.
 *
 * Coverage (per the Phase 1 handoff):
 *   (a) hard-filtered products NEVER appear in proposals — the agent selects
 *       only through the limitations-filtered search path, so an allergen/
 *       contraindication/medication-conflicting product cannot be proposed.
 *   (b) auth gate: 401 when unauthenticated; ANY authenticated caller is allowed
 *       (commerce is no longer role-gated — the community-role wall was removed).
 *   (c) metadata shape { origin:'agent', ... } + source_surface 'autopilot' on inserts.
 *   (d) NO checkout/charge side effect — never touches checkout/product_orders/wallet.
 *   (e) llm_unavailable → HTTP 502 (router mocked to fail).
 *   (f) empty-brain → advisory 'no_health_profile' and still degrades gracefully.
 *
 * The Supabase client + LLM router + condition-matcher are mocked, mirroring
 * the mock style in test/universal-cart.test.ts.
 */

import request from 'supertest';

// =============================================================================
// Chainable Supabase mock — mirrors test/universal-cart.test.ts
// =============================================================================

type SupaResponse = { data: any; error: any };

const createChainableMock = () => {
  let defaultData: SupaResponse = { data: null, error: null };
  const responseQueue: SupaResponse[] = [];
  const calls: { op: string; args: any[] }[] = [];

  const record = (op: string, args: any[]) => calls.push({ op, args });

  const chain: any = {
    from: jest.fn((...args: any[]) => { record('from', args); return chain; }),
    select: jest.fn((...args: any[]) => { record('select', args); return chain; }),
    insert: jest.fn((...args: any[]) => { record('insert', args); return chain; }),
    update: jest.fn((...args: any[]) => { record('update', args); return chain; }),
    delete: jest.fn((...args: any[]) => { record('delete', args); return chain; }),
    eq: jest.fn((...args: any[]) => { record('eq', args); return chain; }),
    neq: jest.fn(() => chain),
    gt: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    lt: jest.fn(() => chain),
    lte: jest.fn(() => chain),
    is: jest.fn(() => chain),
    in: jest.fn(() => chain),
    contains: jest.fn(() => chain),
    overlaps: jest.fn(() => chain),
    textSearch: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    rpc: jest.fn((...args: any[]) => { record('rpc', args); return chain; }),
    then: jest.fn((resolve: any) => {
      const data = responseQueue.length > 0 ? responseQueue.shift()! : defaultData;
      return Promise.resolve(data).then(resolve);
    }),
    __seed: (response: SupaResponse) => { responseQueue.push(response); return chain; },
    __setDefault: (response: SupaResponse) => { defaultData = response; return chain; },
    __clear: () => {
      responseQueue.length = 0;
      defaultData = { data: null, error: null };
      calls.length = 0;
    },
    __calls: () => calls,
    __insertsFor: (table: string) => {
      const inserts: any[] = [];
      let lastFrom: string | null = null;
      for (const c of calls) {
        if (c.op === 'from') lastFrom = c.args[0];
        if (c.op === 'insert' && lastFrom === table) inserts.push(c.args[0]);
      }
      return inserts;
    },
    __sawFrom: (table: string) => calls.some((c) => c.op === 'from' && c.args[0] === table),
  };
  return chain;
};

const mockSupabase = createChainableMock();

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(() => mockSupabase),
}));

// Mock the LLM router — agent-core's planning turn goes through callViaRouter.
const mockCallViaRouter = jest.fn();
jest.mock('../src/services/llm-router', () => ({
  callViaRouter: (...args: any[]) => mockCallViaRouter(...args),
}));

// Mock condition-matcher so no extra DB round-trips are needed in search.
jest.mock('../src/services/condition-matcher', () => ({
  getConditionMapping: jest.fn(async () => null),
}));

// Mock the health-context brain — the route resolves ctx via getUserHealthContext.
const mockGetUserHealthContext = jest.fn();
jest.mock('../src/services/user-health-context', () => {
  const actual = jest.requireActual('../src/services/user-health-context');
  return {
    ...actual,
    getUserHealthContext: (...args: any[]) => mockGetUserHealthContext(...args),
  };
});

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

import express from 'express';
import shoppingAgentRouter from '../src/routes/shopping-agent';
import { applyUserLimitations } from '../src/services/limitations-filter';
import type { UserHealthContext } from '../src/services/user-health-context';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/shopping-agent', shoppingAgentRouter);
  return app;
}

const USER_A = '11111111-1111-4000-a000-000000000a01';
const TENANT_1 = '00000000-0000-4000-c000-000000000c01';
const CART_A = '33333333-3333-4000-d000-000000000d01';
const ITEM_1 = '55555555-5555-4000-e000-000000000e01';
const ITEM_2 = '55555555-5555-4000-e000-000000000e02';
const SAFE_PRODUCT = '66666666-6666-4000-f000-000000000f01';
const ALLERGEN_PRODUCT = '77777777-7777-4000-f000-000000000f02';

const BEARER_A = 'Bearer fake-jwt-user-a';

/**
 * Seed the me_context auth lookup (mirrors universal-cart.test.ts seedAuth).
 *
 * The shared commerce gate (`authorizeCommunityCaller`) is AUTH-ONLY now — it no
 * longer queries `user_tenants.active_role` — so we seed ONLY the me_context
 * response. `role` is accepted for call-site compatibility but ignored.
 */
function seedAuth(opts: { user_id?: string; tenant_id?: string | null; role?: string | null }) {
  mockSupabase.__seed({
    data: { user_id: opts.user_id ?? USER_A, tenant_id: opts.tenant_id === undefined ? TENANT_1 : opts.tenant_id },
    error: null,
  });
}

/** A populated brain with a peanut allergy (used to prove hard-filter). */
function makeCtx(overrides: Partial<UserHealthContext> = {}): UserHealthContext {
  return {
    user_id: USER_A,
    tenant_id: TENANT_1,
    active_conditions: [],
    active_goals: [{ key: 'better_sleep' }],
    dietary_restrictions: [],
    allergies: ['peanut'],
    contraindications: [],
    current_medications: [],
    pregnancy_status: null,
    age_bracket: null,
    religious_restrictions: [],
    ingredient_sensitivities: [],
    budget_max_per_product_cents: null,
    budget_monthly_cap_cents: null,
    budget_preferred_band: null,
    wearable_summary_7d: null,
    vitana_index_snapshot: null,
    upcoming_events: [],
    past_purchases: [],
    recent_recommendations_dismissed: [],
    topic_affinity: {},
    country_code: null,
    region_group: null,
    scope_preference: 'friendly',
    currency: 'EUR',
    lifecycle_stage: null,
    retrieved_at: new Date().toISOString(),
    sources_queried: ['user_limitations'],
    stale: false,
    ...overrides,
  };
}

/** An empty/stale brain (no health profile). */
function emptyCtx(): UserHealthContext {
  return makeCtx({
    active_goals: [],
    allergies: [],
    sources_queried: [],
    stale: true,
  });
}

const SAFE_ROW = {
  id: SAFE_PRODUCT,
  title: 'Magnesium Glycinate',
  brand: 'Acme',
  category: 'supplement',
  price_cents: 1999,
  currency: 'EUR',
  availability: 'in_stock',
  rating: 4.7,
  review_count: 120,
  origin_country: 'DE',
  origin_region: 'EU',
  ingredients_primary: ['magnesium'],
  health_goals: ['sleep'],
  dietary_tags: ['vegan'],
  safety_notes: null,
  contains_allergens: [],
  contraindicated_with_conditions: [],
  contraindicated_with_medications: [],
  ships_to_countries: ['DE'],
  ships_to_regions: ['EU'],
  excluded_from_regions: [],
};

const ALLERGEN_ROW = {
  ...SAFE_ROW,
  id: ALLERGEN_PRODUCT,
  title: 'Peanut Protein Blend',
  ingredients_primary: ['peanut'],
  contains_allergens: ['peanut'], // would conflict with ctx.allergies = ['peanut']
};

/** Make the router emit one intent for every test that reaches the planner. */
function seedPlannerOk() {
  mockCallViaRouter.mockResolvedValue({
    ok: true,
    toolCall: { name: 'emit_search_intents', arguments: { intents: [{ q: 'sleep support', serves_goal: 'better_sleep' }] } },
  });
}

beforeEach(() => {
  mockSupabase.__clear();
  mockCallViaRouter.mockReset();
  mockGetUserHealthContext.mockReset();
  mockGetUserHealthContext.mockResolvedValue(makeCtx());
  consoleErrorSpy.mockClear();
});

// =============================================================================
// (b) Role gate
// =============================================================================

describe(`${'VTID-03260'} (b) auth gating`, () => {
  test('GET /health is open', async () => {
    const res = await request(buildApp()).get('/api/v1/shopping-agent/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('POST /propose without Bearer → 401', async () => {
    const res = await request(buildApp()).post('/api/v1/shopping-agent/propose').send({ prompt: 'sleep help' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  test('POST /propose with role=admin is NOT role-blocked (commerce is open to any authed caller)', async () => {
    // The community-role wall was removed: an 'admin' caller must proceed through
    // the gate. Seed the standard success path (same as the (a) proposal test).
    seedAuth({ role: 'admin' });
    // getMonthlySpend product_orders read (runs before cart resolution)
    mockSupabase.__seed({ data: [], error: null });
    // cart resolution → existing active cart
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    seedPlannerOk();
    // products search → one safe row
    mockSupabase.__seed({ data: [SAFE_ROW], error: null });
    // insert of the safe pick
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    // item.added event insert (best-effort)
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'sleep help' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.error).not.toBe('cart_unavailable_for_role');
  });

  test('POST /propose with no active_role is NOT role-blocked (proceeds)', async () => {
    seedAuth({ role: null });
    // getMonthlySpend product_orders read (runs before cart resolution)
    mockSupabase.__seed({ data: [], error: null });
    // cart resolution → existing active cart
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    seedPlannerOk();
    mockSupabase.__seed({ data: [SAFE_ROW], error: null });
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'sleep help' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.error).not.toBe('cart_unavailable_for_role');
  });
});

// =============================================================================
// Request validation
// =============================================================================

describe(`${'VTID-03260'} request validation`, () => {
  test('400 on empty prompt', async () => {
    seedAuth({ role: 'community' });
    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  test('400 on prompt over 500 chars', async () => {
    seedAuth({ role: 'community' });
    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// (e) llm_unavailable → 502
// =============================================================================

describe(`${'VTID-03260'} (e) llm_unavailable`, () => {
  test('router failure → 502 llm_unavailable, no fabricated picks, no cart writes', async () => {
    seedAuth({ role: 'community' });
    // getMonthlySpend product_orders read (runs before cart resolution)
    mockSupabase.__seed({ data: [], error: null });
    // cart resolution: existing active cart
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    mockCallViaRouter.mockResolvedValue({ ok: false, error: 'Provider has no credentials configured' });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'help me sleep' });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'llm_unavailable' });
    // NEVER fabricated picks → zero item inserts.
    expect(mockSupabase.__insertsFor('universal_cart_items')).toHaveLength(0);
  });
});

// =============================================================================
// (a) Hard-filtered products NEVER appear + (c) metadata/source_surface
// =============================================================================

describe(`${'VTID-03260'} (a) safety invariant + (c) proposal shape`, () => {
  test('allergen-conflicting product is filtered out and never proposed; safe product is', async () => {
    seedAuth({ role: 'community' });
    // getMonthlySpend product_orders read (runs before cart resolution)
    mockSupabase.__seed({ data: [], error: null });
    // cart resolution → existing active cart
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    seedPlannerOk();
    // products search returns BOTH a safe row and an allergen-conflicting row.
    mockSupabase.__seed({ data: [SAFE_ROW, ALLERGEN_ROW], error: null });
    // insert of the (only) safe pick → returns its row id
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    // item.added event insert (best-effort)
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'help me sleep', max_items: 4 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.run_id).toBe('string');

    // The allergen product must NOT be in proposals.
    const proposedProductIds = res.body.proposed.map((p: any) => p.product_id);
    expect(proposedProductIds).toContain(SAFE_PRODUCT);
    expect(proposedProductIds).not.toContain(ALLERGEN_PRODUCT);

    // Exactly one item inserted (the safe one).
    const itemInserts = mockSupabase.__insertsFor('universal_cart_items');
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0].product_id).toBe(SAFE_PRODUCT);
    // (c) source_surface autopilot + agent metadata blob + price lock.
    expect(itemInserts[0].source_surface).toBe('autopilot');
    expect(itemInserts[0].metadata.origin).toBe('agent');
    expect(itemInserts[0].metadata.run_id).toBe(res.body.run_id);
    expect(Array.isArray(itemInserts[0].metadata.safety_flags)).toBe(true);
    expect(typeof itemInserts[0].metadata.confidence).toBe('number');
    expect(typeof itemInserts[0].metadata.proposed_at).toBe('string');
    expect(itemInserts[0].unit_price_cents_snapshot).toBe(1999);
    expect(itemInserts[0].currency_snapshot).toBe('EUR');
    expect(itemInserts[0].item_type).toBe('supplement');

    // The proposal echoes rationale + safety_flags + confidence.
    const safePick = res.body.proposed.find((p: any) => p.product_id === SAFE_PRODUCT);
    expect(safePick.item_id).toBe(ITEM_1);
    expect(typeof safePick.rationale).toBe('string');
    expect(Array.isArray(safePick.safety_flags)).toBe(true);
    expect(typeof safePick.confidence).toBe('number');
  });

  test('applyUserLimitations directly drops the allergen product (substrate guarantee)', () => {
    const ctx = makeCtx(); // allergies = ['peanut']
    const { allowed } = applyUserLimitations([SAFE_ROW as any, ALLERGEN_ROW as any], ctx, { surface: 'shopping_agent' });
    const ids = allowed.map((p) => p.id);
    expect(ids).toContain(SAFE_PRODUCT);
    expect(ids).not.toContain(ALLERGEN_PRODUCT);
  });
});

// =============================================================================
// (d) NO checkout / charge side effect
// =============================================================================

describe(`${'VTID-03260'} (d) no checkout/charge path`, () => {
  test('propose never touches checkout/charge tables (product_orders is READ-only for budget)', async () => {
    seedAuth({ role: 'community' });
    // getMonthlySpend product_orders read (runs before cart resolution)
    mockSupabase.__seed({ data: [], error: null });
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    seedPlannerOk();
    mockSupabase.__seed({ data: [SAFE_ROW], error: null });
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'help me sleep' });

    expect(res.status).toBe(200);
    // Charge/checkout tables must never be touched at all.
    expect(mockSupabase.__sawFrom('checkout_sessions')).toBe(false);
    expect(mockSupabase.__sawFrom('user_wallets')).toBe(false);
    expect(mockSupabase.__sawFrom('wallet_ledger_entries')).toBe(false);
    // Phase 2: product_orders may be READ for the standing-spend advisory, but
    // NEVER written (no insert/update) — proposing is not charging.
    expect(mockSupabase.__insertsFor('product_orders')).toHaveLength(0);
    // Only the proposal write surface (universal_cart_items) is written.
    expect(mockSupabase.__sawFrom('universal_cart_items')).toBe(true);
  });
});

// =============================================================================
// (f) Empty brain → advisory no_health_profile, graceful degrade
// =============================================================================

describe(`${'VTID-03260'} (f) empty brain`, () => {
  test('empty/stale brain → advisory no_health_profile, still proposes', async () => {
    seedAuth({ role: 'community' });
    mockGetUserHealthContext.mockResolvedValue(emptyCtx());
    // getMonthlySpend product_orders read (runs before cart resolution)
    mockSupabase.__seed({ data: [], error: null });
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    seedPlannerOk();
    mockSupabase.__seed({ data: [SAFE_ROW], error: null });
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'help me sleep' });

    expect(res.status).toBe(200);
    expect(res.body.advisory).toContain('no_health_profile');
    // Degrades gracefully — still returns a proposal for the safe product.
    expect(res.body.proposed.map((p: any) => p.product_id)).toContain(SAFE_PRODUCT);
  });

  test('LLM ok but zero candidates pass filters → 200 proposed:[] with explanatory advisory', async () => {
    seedAuth({ role: 'community' });
    // getMonthlySpend product_orders read (runs before cart resolution)
    mockSupabase.__seed({ data: [], error: null });
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    seedPlannerOk();
    // search returns only the allergen product → filtered to empty.
    mockSupabase.__seed({ data: [ALLERGEN_ROW], error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'peanut protein' });

    expect(res.status).toBe(200);
    expect(res.body.proposed).toEqual([]);
    expect(res.body.advisory).toContain('no_candidates_passed_filters');
    expect(mockSupabase.__insertsFor('universal_cart_items')).toHaveLength(0);
  });
});

// =============================================================================
// Phase 2 — over_monthly_cap advisory (spend + subtotal > cap)
// =============================================================================

describe(`${'VTID-03260'} Phase 2 over_monthly_cap advisory`, () => {
  test('standing spend + proposed subtotal over cap → advisory over_monthly_cap', async () => {
    // cap = 5000; one SAFE pick at 1999; standing month-to-date spend = 4000.
    // projected = 4000 + 1999 = 5999 > 5000 → over_monthly_cap.
    seedAuth({ role: 'community' });
    mockGetUserHealthContext.mockResolvedValue(makeCtx({ budget_monthly_cap_cents: 5000 }));
    // getMonthlySpend product_orders read (runs BEFORE cart resolution) → 4000 converted
    mockSupabase.__seed({ data: [{ amount_cents: 4000 }], error: null });
    // cart resolution → existing active cart
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    seedPlannerOk();
    mockSupabase.__seed({ data: [SAFE_ROW], error: null });
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'help me sleep' });

    expect(res.status).toBe(200);
    expect(res.body.advisory).toContain('over_monthly_cap');
    expect(res.body.advisory).not.toContain('near_monthly_cap');
  });

  test('low standing spend + small subtotal under cap → no cap advisory', async () => {
    seedAuth({ role: 'community' });
    mockGetUserHealthContext.mockResolvedValue(makeCtx({ budget_monthly_cap_cents: 100000 }));
    mockSupabase.__seed({ data: [{ amount_cents: 1000 }], error: null }); // tiny standing spend (read first)
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    seedPlannerOk();
    mockSupabase.__seed({ data: [SAFE_ROW], error: null });
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/propose')
      .set('Authorization', BEARER_A)
      .send({ prompt: 'help me sleep' });

    expect(res.status).toBe(200);
    expect(res.body.advisory).not.toContain('over_monthly_cap');
    expect(res.body.advisory).not.toContain('near_monthly_cap');
  });
});

// =============================================================================
// Phase 2 — POST /reorder
// =============================================================================

const REORDER_PRODUCT_1 = '88888888-8888-4000-f000-000000000f08';
const REORDER_PRODUCT_2 = '99999999-9999-4000-f000-000000000f09';

/** An in-stock active product row (reorder hydrate shape). */
const IN_STOCK_ROW = {
  id: REORDER_PRODUCT_1,
  title: 'Vitamin D3',
  category: 'supplement',
  price_cents: 1299,
  currency: 'EUR',
  safety_notes: null,
  is_active: true,
  availability: 'in_stock',
};

/** An out-of-stock product row — must be dropped. */
const OUT_OF_STOCK_ROW = {
  id: REORDER_PRODUCT_2,
  title: 'Discontinued Blend',
  category: 'partner_product',
  price_cents: 999,
  currency: 'EUR',
  safety_notes: null,
  is_active: true,
  availability: 'out_of_stock',
};

function ctxWithPastPurchases(productIds: string[]): UserHealthContext {
  return makeCtx({
    past_purchases: productIds.map((pid, i) => ({
      product_id: pid,
      purchased_at: `2026-0${i + 1}-15T00:00:00.000Z`,
      reordered: false,
    })),
  });
}

describe(`${'VTID-03260'} Phase 2 reorder auth gating`, () => {
  test('POST /reorder without Bearer → 401', async () => {
    const res = await request(buildApp()).post('/api/v1/shopping-agent/reorder').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  test('POST /reorder with role=admin is NOT role-blocked (proceeds)', async () => {
    // No community-role wall anymore. An 'admin' caller with no reorderable
    // history simply proceeds and gets the standard empty-history advisory.
    seedAuth({ role: 'admin' });
    mockGetUserHealthContext.mockResolvedValue(makeCtx({ past_purchases: [] }));
    // cart resolution → existing active cart
    mockSupabase.__seed({ data: { id: CART_A }, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/reorder')
      .set('Authorization', BEARER_A)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.error).not.toBe('cart_unavailable_for_role');
    expect(res.body.advisory).toContain('no_reorderable_items');
  });
});

describe(`${'VTID-03260'} Phase 2 reorder behavior`, () => {
  test('empty past purchases → proposed:[] + advisory no_reorderable_items, no inserts', async () => {
    seedAuth({ role: 'community' });
    mockGetUserHealthContext.mockResolvedValue(makeCtx({ past_purchases: [] }));
    // cart resolution → existing active cart
    mockSupabase.__seed({ data: { id: CART_A }, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/reorder')
      .set('Authorization', BEARER_A)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.proposed).toEqual([]);
    expect(res.body.advisory).toContain('no_reorderable_items');
    expect(mockSupabase.__insertsFor('universal_cart_items')).toHaveLength(0);
  });

  test('drops out-of-stock/inactive products, writes origin=reorder with re-snapshotted price', async () => {
    seedAuth({ role: 'community' });
    mockGetUserHealthContext.mockResolvedValue(
      ctxWithPastPurchases([REORDER_PRODUCT_1, REORDER_PRODUCT_2])
    );
    // cart resolution → existing active cart
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    // products hydrate (.in) → one in-stock, one out-of-stock
    mockSupabase.__seed({ data: [IN_STOCK_ROW, OUT_OF_STOCK_ROW], error: null });
    // insert of the single in-stock pick
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    // item.added event insert (best-effort)
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/reorder')
      .set('Authorization', BEARER_A)
      .send({ max_items: 6 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.run_id).toBe('string');

    // Only the in-stock product is reordered; the out-of-stock SKU is dropped.
    const proposedIds = res.body.proposed.map((p: any) => p.product_id);
    expect(proposedIds).toEqual([REORDER_PRODUCT_1]);

    const itemInserts = mockSupabase.__insertsFor('universal_cart_items');
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0].product_id).toBe(REORDER_PRODUCT_1);
    expect(itemInserts[0].source_surface).toBe('autopilot');
    expect(itemInserts[0].metadata.origin).toBe('reorder');
    expect(itemInserts[0].metadata.run_id).toBe(res.body.run_id);
    expect(typeof itemInserts[0].metadata.proposed_at).toBe('string');
    expect(itemInserts[0].metadata.previously_purchased_at).toBe('2026-01-15T00:00:00.000Z');
    // Re-snapshotted CURRENT price + currency.
    expect(itemInserts[0].unit_price_cents_snapshot).toBe(1299);
    expect(itemInserts[0].currency_snapshot).toBe('EUR');
  });

  test('all past purchases out-of-stock → proposed:[] + no_reorderable_items', async () => {
    seedAuth({ role: 'community' });
    mockGetUserHealthContext.mockResolvedValue(ctxWithPastPurchases([REORDER_PRODUCT_2]));
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    mockSupabase.__seed({ data: [OUT_OF_STOCK_ROW], error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/reorder')
      .set('Authorization', BEARER_A)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.proposed).toEqual([]);
    expect(res.body.advisory).toContain('no_reorderable_items');
    expect(mockSupabase.__insertsFor('universal_cart_items')).toHaveLength(0);
  });

  test('reorder never touches checkout/charge tables', async () => {
    seedAuth({ role: 'community' });
    mockGetUserHealthContext.mockResolvedValue(ctxWithPastPurchases([REORDER_PRODUCT_1]));
    mockSupabase.__seed({ data: { id: CART_A }, error: null });
    mockSupabase.__seed({ data: [IN_STOCK_ROW], error: null });
    mockSupabase.__seed({ data: { id: ITEM_1 }, error: null });
    mockSupabase.__seed({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/shopping-agent/reorder')
      .set('Authorization', BEARER_A)
      .send({});

    expect(res.status).toBe(200);
    expect(mockSupabase.__sawFrom('product_orders')).toBe(false);
    expect(mockSupabase.__sawFrom('checkout_sessions')).toBe(false);
    expect(mockSupabase.__sawFrom('user_wallets')).toBe(false);
    expect(mockSupabase.__sawFrom('wallet_ledger_entries')).toBe(false);
    // Only the proposal write surface is used.
    expect(mockSupabase.__sawFrom('universal_cart_items')).toBe(true);
  });
});
