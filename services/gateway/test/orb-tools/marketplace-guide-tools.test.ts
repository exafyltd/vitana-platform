/**
 * Marketplace Voice Assistant — guide tools (Wave MVA-1, plan sections
 * A17–A19) — unit tests.
 *
 * Cross-module backings are mocked (universal-cart emitCartEvent,
 * memory-facts writeFact, shopping-agent runPropose, health context, spend
 * service); table reads/writes go through the same chainable fake
 * SupabaseClient the discovery-tools tests use (per-table FIFO queues).
 *
 * Covered: exports/declarations parity, unauthenticated gates, goal capture
 * + intent classification, preference save/read/reset supersession-clear
 * semantics, and the two-step confirm on complete_marketplace_selection
 * (read-back first, cart staged only with confirm:true, never any payment).
 */

jest.mock('../../src/routes/universal-cart', () => ({
  emitCartEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/memory-facts-service', () => ({
  writeFact: jest.fn().mockResolvedValue({ ok: true, fact_id: 'f-1' }),
}));
jest.mock('../../src/services/user-health-context', () => ({
  getUserHealthContext: jest.fn().mockResolvedValue({
    stale: true,
    active_goals: [],
    active_conditions: [],
    allergies: [],
    dietary_restrictions: [],
    current_medications: [],
    currency: 'EUR',
  }),
}));
jest.mock('../../src/services/budget/spend-service', () => ({
  getMonthlySpend: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../src/services/shopping-agent/agent-core', () => ({
  runPropose: jest.fn().mockResolvedValue({ ok: false, error: 'llm_unavailable' }),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitCartEvent } from '../../src/routes/universal-cart';
import { writeFact } from '../../src/services/memory-facts-service';
import {
  MARKETPLACE_GUIDE_TOOL_HANDLERS,
  MARKETPLACE_GUIDE_TOOL_DECLARATIONS,
  classifyIntent,
  tool_capture_shopping_goal,
  tool_classify_marketplace_intent,
  tool_save_marketplace_preferences,
  tool_get_marketplace_preferences,
  tool_reset_marketplace_preferences,
  tool_complete_marketplace_selection,
  tool_clarify_shopping_need,
} from '../../src/services/orb-tools/marketplace-guide-tools';

const IDENT = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const ANON = { user_id: '', tenant_id: null, role: null };

const PRODUCT_UUID = '11111111-2222-3333-4444-555555555555';

type QResult = { data: unknown; error: { message: string } | null };

function makeSb(queues: Record<string, QResult[]> = {}) {
  const log: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = jest.fn((table: string) => {
    const q = queues[table];
    const result: QResult = q && q.length > 0 ? q.shift()! : { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const m of [
      'select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'gte', 'lte', 'lt',
      'order', 'limit', 'contains', 'update', 'insert', 'upsert', 'delete', 'not', 'textSearch',
    ]) {
      builder[m] = jest.fn((...args: unknown[]) => {
        log.push({ table, method: m, args });
        return builder;
      });
    }
    builder.maybeSingle = jest.fn(async () => result);
    builder.single = jest.fn(async () => result);
    (builder as { then: unknown }).then = (
      resolve: (v: QResult) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });
  return { sb: { from } as unknown as SupabaseClient, from, log };
}

const guideStateRow = (state: Record<string, unknown>): QResult => ({
  data: [{ id: 'mi-1', content_json: { type: 'marketplace_guide_state', ...state } }],
  error: null,
});

const productRow = (over: Record<string, unknown> = {}): QResult => ({
  data: {
    id: PRODUCT_UUID,
    title: 'Sleep Tea',
    description: 'A calming evening tea.',
    brand: 'Maxina',
    category: 'supplements',
    subcategory: null,
    price_cents: 1999,
    currency: 'EUR',
    compare_at_price_cents: null,
    rating: 4.6,
    review_count: 12,
    availability: 'in_stock',
    dietary_tags: ['vegan'],
    health_goals: null,
    ingredients_primary: null,
    contains_allergens: null,
    ships_to_countries: null,
    dosage: 'one cup before bed',
    serving_size: null,
    servings_per_container: 20,
    safety_notes: 'Not for pregnancy.',
    ...over,
  },
  error: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  (writeFact as jest.Mock).mockResolvedValue({ ok: true, fact_id: 'f-1' });
});

describe('marketplace guide tools — exports', () => {
  const NAMES = [
    'start_marketplace_discover_assistant',
    'build_personalized_shopping_guide',
    'refine_marketplace_recommendations',
    'explain_marketplace_recommendation',
    'complete_marketplace_selection',
    'capture_shopping_goal',
    'clarify_shopping_need',
    'classify_marketplace_intent',
    'save_marketplace_preferences',
    'get_marketplace_preferences',
    'reset_marketplace_preferences',
    'get_marketplace_context',
    'dismiss_marketplace_recommendation',
  ];

  it('exposes all 13 tools with matching declarations', () => {
    expect(Object.keys(MARKETPLACE_GUIDE_TOOL_HANDLERS).sort()).toEqual([...NAMES].sort());
    const declNames = MARKETPLACE_GUIDE_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of NAMES) expect(declNames).toContain(n);
    expect(declNames).toHaveLength(NAMES.length);
  });

  it.each(Object.keys(MARKETPLACE_GUIDE_TOOL_HANDLERS))('%s denies unauthenticated callers', async (name) => {
    const r = await MARKETPLACE_GUIDE_TOOL_HANDLERS[name]({}, ANON, makeSb().sb);
    expect(r.ok).toBe(false);
  });
});

describe('classifyIntent', () => {
  it('routes diagnostic vocabulary to diagnostic_test', () => {
    expect(classifyIntent('I want a blood test for my energy').intent).toBe('diagnostic_test');
  });
  it('routes practitioner vocabulary to practitioner', () => {
    expect(classifyIntent('find me a sleep coach').intent).toBe('practitioner');
  });
  it('defaults to product', () => {
    expect(classifyIntent('something for better sleep').intent).toBe('product');
  });
  it('mixed diagnostic + practitioner → combination', () => {
    expect(classifyIntent('a blood test and a doctor to explain it').intent).toBe('combination');
  });
});

describe('capture_shopping_goal', () => {
  it('requires a goal', async () => {
    const r = await tool_capture_shopping_goal({}, IDENT, makeSb().sb);
    expect(r.ok).toBe(false);
  });

  it('records the goal with classified intent and clears stale picks', async () => {
    const { sb, log } = makeSb({
      // loadGuideState (existing state with old picks) → save: load again + update
      memory_items: [
        guideStateRow({ goal: 'old', picks: [{ kind: 'product', id: 'x', title: 'Old', price_cents: 1, currency: 'EUR', rationale: 'r' }] }),
        guideStateRow({ goal: 'old' }),
        { data: null, error: null },
      ],
    });
    const r = await tool_capture_shopping_goal({ goal: 'improve my sleep', budget_max_amount: 100 }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('improve my sleep');
    const update = log.find((l) => l.table === 'memory_items' && l.method === 'update');
    expect(update).toBeDefined();
    const payload = (update!.args[0] as { content_json: { picks: unknown[]; criteria: { budget_max_cents: number } } }).content_json;
    expect(payload.picks).toEqual([]);
    expect(payload.criteria.budget_max_cents).toBe(10000);
  });
});

describe('classify_marketplace_intent', () => {
  it('classifies an explicit need without touching state', async () => {
    const r = await tool_classify_marketplace_intent({ need: 'metabolomics panel' }, IDENT, makeSb().sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { intent: string } }).result.intent).toBe('diagnostic_test');
  });

  it('fails honestly when no need and no recorded goal', async () => {
    const r = await tool_classify_marketplace_intent({}, IDENT, makeSb().sb);
    expect(r.ok).toBe(false);
  });
});

describe('clarify_shopping_need', () => {
  it('asks for the goal first when none is recorded', async () => {
    const r = await tool_clarify_shopping_need({}, IDENT, makeSb().sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { has_goal: boolean } }).result.has_goal).toBe(false);
  });

  it('lists missing criteria for a recorded goal', async () => {
    const { sb } = makeSb({ memory_items: [guideStateRow({ goal: 'better sleep', criteria: {} })] });
    const r = await tool_clarify_shopping_need({}, IDENT, sb);
    expect(r.ok).toBe(true);
    const missing = (r as { result: { missing_criteria: string[] } }).result.missing_criteria;
    expect(missing).toContain('budget');
  });
});

describe('save_marketplace_preferences', () => {
  it('requires at least one preference field', async () => {
    const r = await tool_save_marketplace_preferences({}, IDENT, makeSb().sb);
    expect(r.ok).toBe(false);
  });

  it('writes each stated preference as a marketplace_pref_* fact', async () => {
    const r = await tool_save_marketplace_preferences(
      { dietary: 'vegan, gluten-free', budget_monthly_amount: 150 },
      IDENT,
      makeSb().sb,
    );
    expect(r.ok).toBe(true);
    const keys = (writeFact as jest.Mock).mock.calls.map((c) => c[0].fact_key);
    expect(keys).toContain('marketplace_pref_dietary');
    expect(keys).toContain('marketplace_pref_budget_monthly_cents');
    const budgetCall = (writeFact as jest.Mock).mock.calls.find((c) => c[0].fact_key === 'marketplace_pref_budget_monthly_cents');
    expect(budgetCall[0].fact_value).toBe('15000');
    expect(budgetCall[0].provenance_source).toBe('user_stated');
  });
});

describe('get_marketplace_preferences', () => {
  it('reads current facts into a speakable summary', async () => {
    const { sb } = makeSb({
      memory_facts: [{ data: [{ fact_key: 'marketplace_pref_dietary', fact_value: 'vegan' }], error: null }],
    });
    const r = await tool_get_marketplace_preferences({}, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('vegan');
  });
});

describe('reset_marketplace_preferences', () => {
  const factsQueue = (): QResult[] => [
    { data: [{ fact_key: 'marketplace_pref_dietary', fact_value: 'vegan' }], error: null },
  ];

  it('is a no-op when nothing is saved', async () => {
    const r = await tool_reset_marketplace_preferences({}, IDENT, makeSb().sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { reset: boolean } }).result.reset).toBe(false);
    expect(writeFact).not.toHaveBeenCalled();
  });

  it('reads back what would be cleared before confirm', async () => {
    const { sb } = makeSb({ memory_facts: factsQueue() });
    const r = await tool_reset_marketplace_preferences({}, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { needs_confirmation: boolean } }).result.needs_confirmation).toBe(true);
    expect(writeFact).not.toHaveBeenCalled();
  });

  it('clears via empty-value supersession with confirm:true', async () => {
    const { sb } = makeSb({ memory_facts: factsQueue() });
    const r = await tool_reset_marketplace_preferences({ confirm: true }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { reset: boolean } }).result.reset).toBe(true);
    expect(writeFact).toHaveBeenCalledWith(expect.objectContaining({ fact_key: 'marketplace_pref_dietary', fact_value: '' }));
  });
});

describe('complete_marketplace_selection (two-step confirm)', () => {
  const stateWithPick = () =>
    guideStateRow({
      goal: 'better sleep',
      picks: [{ kind: 'product', id: PRODUCT_UUID, title: 'Sleep Tea', price_cents: 1999, currency: 'EUR', rationale: 'fits the sleep goal' }],
    });

  it('errors when there is nothing selected', async () => {
    const r = await tool_complete_marketplace_selection({}, IDENT, makeSb().sb);
    expect(r.ok).toBe(false);
  });

  it('reads back name + price and does NOT touch the cart without confirm', async () => {
    const { sb, log } = makeSb({
      memory_items: [stateWithPick(), stateWithPick(), { data: null, error: null }],
      products: [productRow()],
    });
    const r = await tool_complete_marketplace_selection({ position: 1 }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { needs_confirmation: boolean } }).result.needs_confirmation).toBe(true);
    expect((r as { text: string }).text).toContain('Sleep Tea');
    expect(log.filter((l) => l.table === 'universal_cart_items')).toHaveLength(0);
    expect(emitCartEvent).not.toHaveBeenCalled();
  });

  it('stages the cart (with audit event) only with confirm:true — never payment', async () => {
    const { sb, log } = makeSb({
      memory_items: [stateWithPick(), stateWithPick(), { data: null, error: null }],
      products: [productRow()],
      universal_carts: [
        { data: null, error: null },
        { data: { id: 'cart-1' }, error: null },
      ],
      universal_cart_items: [{ data: { id: 'item-1' }, error: null }],
    });
    const r = await tool_complete_marketplace_selection({ position: 1, confirm: true }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { added: boolean } }).result.added).toBe(true);
    const insert = log.find((l) => l.table === 'universal_cart_items' && l.method === 'insert');
    expect(insert).toBeDefined();
    const payload = insert!.args[0] as { source_surface: string; metadata: { origin: string } };
    expect(payload.source_surface).toBe('voice');
    expect(payload.metadata.origin).toBe('discover_assistant');
    expect(emitCartEvent).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'item.added' }));
    expect((r as { text: string }).text).toContain('nothing has been charged');
  });
});
