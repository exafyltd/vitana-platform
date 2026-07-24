/**
 * Marketplace Voice Assistant — journey tools (Wave MVA-1, plan sections
 * A20–A29) — unit tests.
 *
 * Same mock discipline as marketplace-guide-tools.test.ts: cross-module
 * backings mocked, table access through the chainable FIFO SupabaseClient
 * fake. Covered: exports/declarations parity, unauthenticated gates,
 * need-driven search with saved-preference exclusions, propose-only picks
 * (runPropose degraded → deterministic fallback, nothing staged), path
 * recommendation, shortlist CRUD on shop_saved_products, suitability
 * honesty (conflicts vs could-not-verify), budget review, and the two-step
 * confirm on add_selected_option_to_cart.
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
  getMonthlySpend: jest.fn().mockResolvedValue(5000),
}));
jest.mock('../../src/services/shopping-agent/agent-core', () => ({
  runPropose: jest.fn().mockResolvedValue({ ok: false, error: 'llm_unavailable' }),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitCartEvent } from '../../src/routes/universal-cart';
import { runPropose } from '../../src/services/shopping-agent/agent-core';
import {
  MARKETPLACE_JOURNEY_TOOL_HANDLERS,
  MARKETPLACE_JOURNEY_TOOL_DECLARATIONS,
  tool_discover_marketplace_options,
  tool_search_products_by_need,
  tool_search_marketplace_by_values,
  tool_generate_top_marketplace_picks,
  tool_recommend_marketplace_path,
  tool_shortlist_marketplace_options,
  tool_view_marketplace_shortlist,
  tool_remove_from_marketplace_shortlist,
  tool_check_product_suitability,
  tool_review_shopping_budget,
  tool_add_selected_option_to_cart,
  tool_explain_why_recommended,
} from '../../src/services/orb-tools/marketplace-journey-tools';

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

const product = (over: Record<string, unknown> = {}) => ({
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
});

const guideStateRow = (state: Record<string, unknown>): QResult => ({
  data: [{ id: 'mi-1', content_json: { type: 'marketplace_guide_state', ...state } }],
  error: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  (runPropose as jest.Mock).mockResolvedValue({ ok: false, error: 'llm_unavailable' });
});

describe('marketplace journey tools — exports', () => {
  const NAMES = [
    'discover_marketplace_options',
    'search_products_by_need',
    'search_services_by_need',
    'search_marketplace_by_values',
    'search_marketplace_alternatives',
    'generate_top_marketplace_picks',
    'recommend_marketplace_path',
    'recommend_lower_cost_option',
    'explain_why_recommended',
    'summarize_product_for_user',
    'get_key_product_facts',
    'compare_marketplace_options',
    'shortlist_marketplace_options',
    'view_marketplace_shortlist',
    'remove_from_marketplace_shortlist',
    'check_product_suitability',
    'check_cart_duplication',
    'review_shopping_budget',
    'confirm_marketplace_selection',
    'add_selected_option_to_cart',
    'review_cart_suitability',
    'explain_cart_item',
  ];

  it('exposes all 22 tools with matching declarations', () => {
    expect(Object.keys(MARKETPLACE_JOURNEY_TOOL_HANDLERS).sort()).toEqual([...NAMES].sort());
    const declNames = MARKETPLACE_JOURNEY_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of NAMES) expect(declNames).toContain(n);
    expect(declNames).toHaveLength(NAMES.length);
  });

  it.each(Object.keys(MARKETPLACE_JOURNEY_TOOL_HANDLERS))('%s denies unauthenticated callers', async (name) => {
    const r = await MARKETPLACE_JOURNEY_TOOL_HANDLERS[name]({}, ANON, makeSb().sb);
    expect(r.ok).toBe(false);
  });
});

describe('discover_marketplace_options', () => {
  it('requires a need', async () => {
    const r = await tool_discover_marketplace_options({}, IDENT, makeSb().sb);
    expect(r.ok).toBe(false);
  });

  it('merges products and services into one option list', async () => {
    const { sb } = makeSb({
      products: [{ data: [product()], error: null }],
      services_catalog: [
        { data: [{ id: 's-1', name: 'Sleep Coaching', service_type: 'coach', provider_name: 'Dr. A', topic_keys: null, metadata: null }], error: null },
      ],
    });
    const r = await tool_discover_marketplace_options({ need: 'better sleep' }, IDENT, sb);
    expect(r.ok).toBe(true);
    const options = (r as { result: { options: Array<{ kind: string }> } }).result.options;
    expect(options.some((o) => o.kind === 'product')).toBe(true);
    expect(options.some((o) => o.kind === 'service')).toBe(true);
  });

  it('is honest when nothing matches', async () => {
    const { sb } = makeSb({ products: [{ data: [], error: null }, { data: [], error: null }] });
    const r = await tool_discover_marketplace_options({ need: 'xyzzy' }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('honestly');
  });
});

describe('search_products_by_need — saved exclusions apply', () => {
  it('filters excluded brands and reports the drop', async () => {
    const { sb } = makeSb({
      memory_facts: [
        { data: [{ fact_key: 'marketplace_pref_excluded_brands', fact_value: 'Maxina' }], error: null },
      ],
      products: [{ data: [product()], error: null }, { data: [product()], error: null }],
    });
    const r = await tool_search_products_by_need({ need: 'sleep tea' }, IDENT, sb);
    expect(r.ok).toBe(true);
    const res = r as { result: { items: unknown[]; dropped: Array<{ reason: string }> } };
    expect(res.result.items).toHaveLength(0);
    expect(res.result.dropped[0].reason).toContain('Maxina');
  });
});

describe('search_marketplace_by_values', () => {
  it('requires a dietary tag or certification', async () => {
    const r = await tool_search_marketplace_by_values({ need: 'sleep' }, IDENT, makeSb().sb);
    expect(r.ok).toBe(false);
  });

  it('returns declared matches only', async () => {
    const { sb } = makeSb({ products: [{ data: [product()], error: null }] });
    const r = await tool_search_marketplace_by_values({ dietary_tags: 'vegan' }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('Sleep Tea');
  });
});

describe('generate_top_marketplace_picks (propose-only)', () => {
  it('falls back to deterministic search when the agent LLM is unavailable and stages nothing', async () => {
    const { sb, log } = makeSb({
      products: [{ data: [product()], error: null }],
      memory_items: [{ data: [], error: null }, { data: [], error: null }],
    });
    const r = await tool_generate_top_marketplace_picks({ prompt: 'better sleep' }, IDENT, sb);
    expect(r.ok).toBe(true);
    const picks = (r as { result: { picks: Array<{ title: string }> } }).result.picks;
    expect(picks[0].title).toBe('Sleep Tea');
    expect((r as { text: string }).text).toContain('nothing added to the cart');
    expect(log.filter((l) => l.table === 'universal_cart_items')).toHaveLength(0);
    expect(emitCartEvent).not.toHaveBeenCalled();
  });

  it('uses collect-only picks from runPropose when the agent is available', async () => {
    (runPropose as jest.Mock).mockImplementation(async ({ insertPick }) => {
      await insertPick(
        {
          product_id: PRODUCT_UUID,
          title: 'Agent Pick',
          rationale: 'matches the stated goal',
          safety_flags: [],
          confidence: 0.8,
          item_type: 'supplement',
          unit_price_cents_snapshot: 999,
          currency_snapshot: 'EUR',
        },
        'run-1',
        new Date().toISOString(),
      );
      return { ok: true, run_id: 'run-1', proposed: [], advisory: [] };
    });
    const { sb, log } = makeSb({ memory_items: [{ data: [], error: null }, { data: [], error: null }] });
    const r = await tool_generate_top_marketplace_picks({ prompt: 'better sleep' }, IDENT, sb);
    expect(r.ok).toBe(true);
    const picks = (r as { result: { picks: Array<{ title: string; rationale: string }> } }).result.picks;
    expect(picks[0].title).toBe('Agent Pick');
    expect(picks[0].rationale).toBe('matches the stated goal');
    expect(log.filter((l) => l.table === 'universal_cart_items')).toHaveLength(0);
  });
});

describe('recommend_marketplace_path', () => {
  it('recommends assessment-first for understanding-type goals with the health boundary', async () => {
    const r = await tool_recommend_marketplace_path({ goal: 'I want to understand why I am always tired' }, IDENT, makeSb().sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { path: string } }).result.path).toBe('assessment_first');
    expect((r as { text: string }).text).toContain('does not diagnose');
  });

  it('recommends product-first for plain product goals', async () => {
    const r = await tool_recommend_marketplace_path({ goal: 'a good vitamin d supplement' }, IDENT, makeSb().sb);
    expect((r as { result: { path: string } }).result.path).toBe('product_first');
  });
});

describe('shortlist (shop_saved_products)', () => {
  it('saves a resolved product once', async () => {
    const { sb, log } = makeSb({
      memory_items: [{ data: [], error: null }],
      products: [{ data: product(), error: null }],
      shop_saved_products: [
        { data: null, error: null },
        { data: { id: 'sp-1' }, error: null },
      ],
    });
    const r = await tool_shortlist_marketplace_options({ product_id: PRODUCT_UUID }, IDENT, sb);
    expect(r.ok).toBe(true);
    const insert = log.find((l) => l.table === 'shop_saved_products' && l.method === 'insert');
    expect(insert!.args[0]).toEqual({ user_id: 'u-1', product_id: PRODUCT_UUID });
  });

  it('reads the shortlist with product titles', async () => {
    const { sb } = makeSb({
      shop_saved_products: [{ data: [{ product_id: PRODUCT_UUID }], error: null }],
      products: [{ data: [product()], error: null }],
    });
    const r = await tool_view_marketplace_shortlist({}, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('Sleep Tea');
  });

  it('reports honestly when removing something that was not shortlisted', async () => {
    const { sb } = makeSb({
      memory_items: [{ data: [], error: null }],
      products: [{ data: product(), error: null }],
      shop_saved_products: [{ data: [], error: null }],
    });
    const r = await tool_remove_from_marketplace_shortlist({ product_id: PRODUCT_UUID }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { removed: boolean } }).result.removed).toBe(false);
  });
});

describe('check_product_suitability — declared data only', () => {
  it('reports conflicts against saved exclusions', async () => {
    const { sb } = makeSb({
      memory_items: [{ data: [], error: null }],
      products: [{ data: product(), error: null }],
      memory_facts: [
        { data: [{ fact_key: 'marketplace_pref_excluded_brands', fact_value: 'Maxina' }], error: null },
      ],
    });
    const r = await tool_check_product_suitability({ product_id: PRODUCT_UUID }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { verdict: string } }).result.verdict).toBe('conflicts_found');
  });

  it('says what could NOT be verified instead of guessing', async () => {
    const { sb } = makeSb({
      memory_items: [{ data: [], error: null }],
      products: [{ data: product({ dietary_tags: null }), error: null }],
      memory_facts: [{ data: [{ fact_key: 'marketplace_pref_dietary', fact_value: 'vegan' }], error: null }],
    });
    const r = await tool_check_product_suitability({ product_id: PRODUCT_UUID }, IDENT, sb);
    expect(r.ok).toBe(true);
    const res = r as { result: { unchecked: string[] }; text: string };
    expect(res.result.unchecked.length).toBeGreaterThan(0);
    expect(res.text).toContain('Could NOT verify');
  });
});

describe('review_shopping_budget', () => {
  it('reports cap, spend, remaining and cart total', async () => {
    const { sb } = makeSb({
      user_limitations: [{ data: { budget_monthly_cap_cents: 20000 }, error: null }],
      universal_carts: [{ data: { id: 'cart-1' }, error: null }],
      universal_cart_items: [
        { data: [{ id: 'i1', product_id: PRODUCT_UUID, item_type: 'supplement', quantity: 2, status: 'active', unit_price_cents_snapshot: 1999, currency_snapshot: 'EUR', metadata: {} }], error: null },
      ],
    });
    const r = await tool_review_shopping_budget({}, IDENT, sb);
    expect(r.ok).toBe(true);
    const res = (r as { result: { remaining_cents: number; cart_total_cents: number } }).result;
    expect(res.remaining_cents).toBe(15000);
    expect(res.cart_total_cents).toBe(3998);
  });
});

describe('add_selected_option_to_cart (two-step confirm)', () => {
  it('reads back and does not stage without confirm', async () => {
    const { sb, log } = makeSb({
      memory_items: [{ data: [], error: null }],
      products: [{ data: product(), error: null }],
    });
    const r = await tool_add_selected_option_to_cart({ product_id: PRODUCT_UUID }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { needs_confirmation: boolean } }).result.needs_confirmation).toBe(true);
    expect(log.filter((l) => l.table === 'universal_cart_items')).toHaveLength(0);
  });

  it('stages with confirm:true and hands payment off to the screen', async () => {
    const { sb } = makeSb({
      memory_items: [{ data: [], error: null }],
      products: [{ data: product(), error: null }],
      universal_carts: [
        { data: null, error: null },
        { data: { id: 'cart-1' }, error: null },
      ],
      universal_cart_items: [{ data: { id: 'item-1' }, error: null }],
    });
    const r = await tool_add_selected_option_to_cart({ product_id: PRODUCT_UUID, confirm: true }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { added: boolean } }).result.added).toBe(true);
    expect(emitCartEvent).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'item.added' }));
    expect((r as { text: string }).text).toContain('nothing has been charged');
  });
});

describe('explain_why_recommended — recorded rationale only', () => {
  it('cites the recorded pick rationale', async () => {
    const { sb } = makeSb({
      memory_items: [
        guideStateRow({
          goal: 'sleep',
          picks: [{ kind: 'product', id: PRODUCT_UUID, title: 'Sleep Tea', price_cents: 1999, currency: 'EUR', rationale: 'you asked for a non-pill option' }],
        }),
      ],
      products: [{ data: product(), error: null }],
    });
    const r = await tool_explain_why_recommended({ position: 1 }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('you asked for a non-pill option');
  });

  it('refuses to invent a rationale for items it never recommended', async () => {
    const { sb } = makeSb({
      memory_items: [{ data: [], error: null }],
      products: [{ data: product(), error: null }],
      universal_carts: [{ data: null, error: null }],
    });
    const r = await tool_explain_why_recommended({ product_id: PRODUCT_UUID }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { has_recorded_rationale: boolean } }).result.has_recorded_rationale).toBe(false);
    expect((r as { text: string }).text).toContain('do not invent');
  });
});
