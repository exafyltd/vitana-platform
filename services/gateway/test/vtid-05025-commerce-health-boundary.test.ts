/**
 * VTID-05025 — Health Hub WP1 / D12: no device-derived health data in commerce.
 *
 * Owner decision (Health Hub plan, Gate 1 2026-10-10): device-derived health
 * data never ranks or personalises commerce. Before this change a member's
 * 7-day wearable rollup (sleep, HRV) was loaded for every commerce caller of
 * getUserHealthContext() (the `include_wearable` default was the opposite of
 * its own doc comment), turned into a condition label ('insomnia', 'low-hrv')
 * by inferPrimaryCondition() that ranked products, and rendered into the ORB
 * marketplace prompt.
 *
 * This suite pins the boundary:
 *   1. getUserHealthContext() loads wearable data only on an explicit opt-in.
 *   2. The cache never serves a context loaded with other include flags, and
 *      invalidation drops every variant.
 *   3. inferPrimaryCondition() never derives a condition from device data.
 *   4. A source scan of the commerce modules finds no wearable opt-in, no
 *      wearable field read and no health-data table. limitations-filter.ts is
 *      the single allowed health→commerce module (hide-only safety filter).
 *   5. applyUserLimitations() only ever hides: its output is an in-order
 *      subsequence of its input.
 *   6. (VTID-05089, Health Hub D6a) The marketplace voice tools
 *      find_perfect_product / find_perfect_practitioner never read the
 *      Vitana Index: a pillar filter applies only when the member names one.
 *      The scan in 4. also bans the Index tables and the wearable features
 *      bridge from every commerce module, because once the bridge is on the
 *      Index can contain device-derived data.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));
jest.mock('../src/services/user-health-context-repository');
jest.mock('../src/services/reward-events', () => ({
  emitLimitationViolation: jest.fn(() => Promise.resolve()),
}));

import * as repo from '../src/services/user-health-context-repository';
import {
  getUserHealthContext,
  invalidateUserHealthContext,
  inferPrimaryCondition,
  type UserHealthContext,
} from '../src/services/user-health-context';
import { applyUserLimitations, type FilterableProduct } from '../src/services/limitations-filter';
import { tool_find_perfect_product, tool_find_perfect_practitioner } from '../src/services/orb-tools-shared';

const mockedRepo = repo as jest.Mocked<typeof repo>;

const LOW_SLEEP_LOW_HRV_ROLLUP = {
  data: {
    days_with_data: 7,
    sleep_avg_minutes: 300,
    sleep_deep_pct: 10,
    hrv_avg_ms: 25,
    resting_hr: 70,
    activity_minutes: 10,
    workout_count: 0,
  },
  error: null,
};

function baseContext(overrides: Partial<UserHealthContext> = {}): UserHealthContext {
  return {
    user_id: 'u1',
    tenant_id: null,
    active_conditions: [],
    active_goals: [],
    dietary_restrictions: [],
    allergies: [],
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
    ...overrides,
  } as UserHealthContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockedRepo)) {
    if (jest.isMockFunction(fn)) fn.mockResolvedValue({ data: null, error: null } as never);
  }
  mockedRepo.fetchWearableRollup7d.mockResolvedValue(LOW_SLEEP_LOW_HRV_ROLLUP as never);
});

// ---------------------------------------------------------------------------
// 1. Opt-in wearable loading
// ---------------------------------------------------------------------------

describe('getUserHealthContext — wearable data is opt-in (VTID-05025)', () => {
  it('does not query the wearable rollup when include_wearable is omitted', async () => {
    invalidateUserHealthContext('u-default');
    const ctx = await getUserHealthContext('u-default');
    expect(mockedRepo.fetchWearableRollup7d).not.toHaveBeenCalled();
    expect(ctx.wearable_summary_7d).toBeNull();
    expect(ctx.sources_queried).not.toContain('wearable_rollup_7d');
  });

  it('does not query the wearable rollup when include_wearable is false', async () => {
    invalidateUserHealthContext('u-false');
    await getUserHealthContext('u-false', { include_wearable: false });
    expect(mockedRepo.fetchWearableRollup7d).not.toHaveBeenCalled();
  });

  it('queries and maps the rollup only when include_wearable === true', async () => {
    invalidateUserHealthContext('u-true');
    const ctx = await getUserHealthContext('u-true', { include_wearable: true });
    expect(mockedRepo.fetchWearableRollup7d).toHaveBeenCalledTimes(1);
    expect(ctx.wearable_summary_7d?.sleep_avg_minutes).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// 2. Option-aware cache
// ---------------------------------------------------------------------------

describe('getUserHealthContext — cache is keyed by include flags (VTID-05025)', () => {
  it('never serves a wearable-loaded context to a caller that did not opt in', async () => {
    invalidateUserHealthContext('u-cache');
    const withWearable = await getUserHealthContext('u-cache', { include_wearable: true });
    expect(withWearable.wearable_summary_7d).not.toBeNull();

    const commerce = await getUserHealthContext('u-cache');
    expect(commerce.wearable_summary_7d).toBeNull();
    expect(commerce).not.toBe(withWearable);
  });

  it('serves the same option variant from cache', async () => {
    invalidateUserHealthContext('u-hit');
    const first = await getUserHealthContext('u-hit');
    const callsAfterFirst = mockedRepo.fetchAppUserContextRow.mock.calls.length;
    const second = await getUserHealthContext('u-hit');
    expect(second).toBe(first);
    expect(mockedRepo.fetchAppUserContextRow.mock.calls.length).toBe(callsAfterFirst);
  });

  it('invalidateUserHealthContext() drops every option variant for the user', async () => {
    invalidateUserHealthContext('u-inv');
    await getUserHealthContext('u-inv');
    await getUserHealthContext('u-inv', { include_wearable: true });
    const loadsBefore = mockedRepo.fetchAppUserContextRow.mock.calls.length;
    const wearableLoadsBefore = mockedRepo.fetchWearableRollup7d.mock.calls.length;

    invalidateUserHealthContext('u-inv');
    await getUserHealthContext('u-inv');
    await getUserHealthContext('u-inv', { include_wearable: true });

    expect(mockedRepo.fetchAppUserContextRow.mock.calls.length).toBe(loadsBefore + 2);
    expect(mockedRepo.fetchWearableRollup7d.mock.calls.length).toBe(wearableLoadsBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// 3. inferPrimaryCondition never reads device data
// ---------------------------------------------------------------------------

describe('inferPrimaryCondition — no device-derived condition (VTID-05025)', () => {
  it('returns null for a context whose only signal is low sleep / low HRV wearable data', () => {
    const ctx = baseContext({
      wearable_summary_7d: {
        sleep_avg_minutes: 200,
        sleep_deep_pct: 5,
        hrv_avg_ms: 15,
        resting_hr: 80,
        activity_minutes: 0,
        workout_count: 0,
      },
    } as Partial<UserHealthContext>);
    expect(inferPrimaryCondition(ctx)).toBeNull();
  });

  it('keeps the member-stated condition precedence unchanged', () => {
    const ctx = baseContext({
      active_conditions: [
        { key: 'joint-pain', source: 'memory' },
        { key: 'stress', source: 'user_stated' },
      ],
    } as Partial<UserHealthContext>);
    expect(inferPrimaryCondition(ctx)).toBe('stress');
  });

  it('still maps upcoming travel to jet-lag', () => {
    const ctx = baseContext({
      upcoming_events: [
        { start: new Date().toISOString(), event_type: 'travel', shifts_recommendations: ['travel'], title: null },
      ],
    } as Partial<UserHealthContext>);
    expect(inferPrimaryCondition(ctx)).toBe('jet-lag');
  });
});

// ---------------------------------------------------------------------------
// 4. Source scan of the commerce modules
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, '..', 'src');

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function commerceModules(): string[] {
  const files = [
    ...fs
      .readdirSync(path.join(SRC, 'services', 'recommendation-engine', 'analyzers'))
      .filter((f) => /^marketplace-analyzer.*\.ts$/.test(f))
      .map((f) => path.join(SRC, 'services', 'recommendation-engine', 'analyzers', f)),
    path.join(SRC, 'services', 'feed-ranker.ts'),
    ...fs
      .readdirSync(path.join(SRC, 'routes'))
      .filter((f) => /^discover-.*\.ts$/.test(f))
      .map((f) => path.join(SRC, 'routes', f)),
    ...listTs(path.join(SRC, 'services', 'shopping-agent')),
    ...fs
      .readdirSync(path.join(SRC, 'services', 'orb-tools'))
      .filter((f) => /^marketplace-.*\.ts$/.test(f))
      .map((f) => path.join(SRC, 'services', 'orb-tools', f)),
    path.join(SRC, 'services', 'context-pack-builder.ts'),
  ];
  return files;
}

// Any wearable field token is a violation except the literal initialiser
// `wearable_summary_7d: null` (discover-feed builds a guest UserHealthContext,
// whose field is required and nullable).
const WEARABLE_FIELD_READ = /wearable_summary_7d(?!\s*:\s*null\b)/;
const WEARABLE_OPT_IN = /include_wearable\s*:\s*true/;
const HEALTH_TABLES = /['"`](wearable_daily_metrics|wearable_rollup_7d|wearable_samples|health_features_daily|biomarker_results|lab_reports|vitana_index_scores|vitana_pillar_agent_outputs)['"`]/;
const WEARABLE_ANALYZER_IMPORT = /from\s+['"][^'"]*wearable-analyzer['"]/;
// VTID-05089: the wearable -> health_features_daily bridge is health-domain only.
const WEARABLE_BRIDGE_IMPORT = /from\s+['"][^'"]*wearable-features-bridge(-repository)?['"]/;

describe('commerce/health purpose boundary — source scan (VTID-05025)', () => {
  const files = commerceModules();

  it('covers the expected commerce modules', () => {
    for (const f of files) expect(fs.existsSync(f)).toBe(true);
    const rel = files.map((f) => path.relative(SRC, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        'services/feed-ranker.ts',
        'routes/discover-search.ts',
        'routes/discover-feed.ts',
        'services/orb-tools/marketplace-discovery-tools.ts',
        'services/context-pack-builder.ts',
        'services/recommendation-engine/analyzers/marketplace-analyzer.ts',
      ])
    );
    expect(rel.some((r) => r.startsWith('services/shopping-agent/'))).toBe(true);
  });

  it.each(commerceModules().map((f) => [path.relative(SRC, f), f]))(
    '%s never opts into wearable data, reads the wearable field, or touches a health-data table',
    (_rel, file) => {
      const src = fs.readFileSync(file as string, 'utf8');
      expect(src).not.toMatch(WEARABLE_OPT_IN);
      expect(src).not.toMatch(WEARABLE_FIELD_READ);
      expect(src).not.toMatch(HEALTH_TABLES);
      expect(src).not.toMatch(WEARABLE_ANALYZER_IMPORT);
      expect(src).not.toMatch(WEARABLE_BRIDGE_IMPORT);
    }
  );

  it('the scan patterns catch real violations and allow only the null initialiser', () => {
    expect('wearable_summary_7d: hc.wearable_summary_7d,').toMatch(WEARABLE_FIELD_READ);
    expect('const w = m.wearable_summary_7d;').toMatch(WEARABLE_FIELD_READ);
    expect('ctx.wearable_summary_7d?.sleep_avg_minutes').toMatch(WEARABLE_FIELD_READ);
    expect('    wearable_summary_7d: null,').not.toMatch(WEARABLE_FIELD_READ);
    expect('getUserHealthContext(id, { include_wearable: true })').toMatch(WEARABLE_OPT_IN);
    expect(".from('wearable_rollup_7d')").toMatch(HEALTH_TABLES);
    expect("import { analyzeWearables } from './wearable-analyzer';").toMatch(WEARABLE_ANALYZER_IMPORT);
    expect(".from('vitana_index_scores')").toMatch(HEALTH_TABLES);
    expect(".from('vitana_pillar_agent_outputs')").toMatch(HEALTH_TABLES);
    expect("import { bridgeWearableDays } from '../services/wearable-features-bridge';").toMatch(WEARABLE_BRIDGE_IMPORT);
    expect("import * as r from './wearable-features-bridge-repository';").toMatch(WEARABLE_BRIDGE_IMPORT);
  });

  it('limitations-filter.ts is the single allowed health→commerce module and stays hide-only in shape', () => {
    const src = fs.readFileSync(path.join(SRC, 'services', 'limitations-filter.ts'), 'utf8');
    // It reads stated limitations, never device data.
    expect(src).not.toMatch(WEARABLE_FIELD_READ);
    expect(src).not.toMatch(HEALTH_TABLES);
  });

  it('wearable-analyzer recommendations stay in the health domain (never marketplace)', () => {
    const gen = fs.readFileSync(
      path.join(SRC, 'services', 'recommendation-engine', 'recommendation-generator.ts'),
      'utf8'
    );
    const start = gen.indexOf('function convertWearableSignal(');
    expect(start).toBeGreaterThan(-1);
    const body = gen.slice(start, gen.indexOf('\n}\n', start));
    expect(body).toContain("domain: 'health'");
    expect(body).toContain("source_type: 'wearable'");
    expect(body).not.toContain('marketplace');
  });
});

// ---------------------------------------------------------------------------
// 6. Marketplace voice tools never read the Vitana Index (VTID-05089)
// ---------------------------------------------------------------------------

function sliceFunction(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('find_perfect_product / find_perfect_practitioner — no Index read (VTID-05089)', () => {
  const shared = fs.readFileSync(path.join(SRC, 'services', 'orb-tools-shared.ts'), 'utf8');

  it.each([
    'export async function tool_find_perfect_product(',
    'export async function tool_find_perfect_practitioner(',
    'async function _getCompassGoal(',
  ])('%s… reads no vitana_index_scores and derives no weakest pillar', (signature) => {
    const body = sliceFunction(shared, signature);
    expect(body).not.toMatch(/vitana_index_scores/);
    expect(body).not.toMatch(/weakest/i);
    expect(body).not.toMatch(HEALTH_TABLES);
  });

  it('the removed Index helper is gone from orb-tools-shared.ts', () => {
    expect(shared).not.toContain('_getWeakestPillarAndGoal');
  });

  function recordingClient() {
    const calls: Array<{ table: string; steps: Array<{ method: string; args: unknown[] }> }> = [];
    const client: any = {
      from: jest.fn((table: string) => {
        const steps: Array<{ method: string; args: unknown[] }> = [];
        calls.push({ table, steps });
        const chain: any = {};
        for (const m of ['select', 'eq', 'limit', 'order', 'contains', 'lte', 'ilike', 'in']) {
          chain[m] = jest.fn((...args: unknown[]) => (steps.push({ method: m, args }), chain));
        }
        const resp = () =>
          table === 'life_compass'
            ? { data: { primary_goal: 'sleep better' }, error: null } // VTID-05156: real column
            : { data: [{ name: 'Magnesium', ingredients: [] }], error: null };
        chain.maybeSingle = jest.fn(() => Promise.resolve(resp()));
        chain.then = (res: any, rej: any) => Promise.resolve(resp()).then(res, rej);
        return chain;
      }),
      rpc: jest.fn(),
    };
    return { client, calls };
  }

  const ID = { user_id: 'u1', tenant_id: 't1', role: 'community', vitana_id: null } as never;

  it('find_perfect_product without a pillar issues no vitana_index_scores query and no pillar_tags filter', async () => {
    const { client, calls } = recordingClient();
    const r = await tool_find_perfect_product({ goal_text: 'better sleep' }, ID, client);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.table)).not.toContain('vitana_index_scores');
    expect(calls.map((c) => c.table)).not.toContain('vitana_pillar_agent_outputs');
    const catalog = calls.find((c) => c.table === 'products_catalog');
    expect(catalog).toBeDefined();
    expect(catalog!.steps.some((s) => s.method === 'contains' && s.args[0] === 'pillar_tags')).toBe(false);
    expect((r as any).result.pillar).toBeNull();
    expect((r as any).result.compass_goal).toBe('sleep better');
  });

  it('find_perfect_product filters by pillar_tags only when the member names a pillar', async () => {
    const { client, calls } = recordingClient();
    await tool_find_perfect_product({ pillar: 'Sleep' }, ID, client);
    const catalog = calls.find((c) => c.table === 'products_catalog')!;
    expect(catalog.steps).toContainEqual({ method: 'contains', args: ['pillar_tags', ['sleep']] });
    expect(calls.map((c) => c.table)).not.toContain('vitana_index_scores');
  });

  it('find_perfect_practitioner issues no vitana_index_scores query', async () => {
    const { client, calls } = recordingClient();
    const r = await tool_find_perfect_practitioner({ specialty: 'sleep' }, ID, client);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.table)).not.toContain('vitana_index_scores');
  });
});

// ---------------------------------------------------------------------------
// 5. applyUserLimitations is hide-only
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const VOCAB = ['a', 'b', 'c', 'd', 'e'];
function pick(r: () => number, n: number): string[] {
  return VOCAB.filter(() => r() < n);
}

function genProduct(r: () => number, i: number): FilterableProduct {
  return {
    id: `p${i}`,
    contains_allergens: pick(r, 0.15),
    contraindicated_with_conditions: pick(r, 0.15),
    contraindicated_with_medications: pick(r, 0.15),
    excluded_from_regions: r() < 0.1 ? ['EU'] : [],
    ships_to_countries: r() < 0.8 ? ['DE', 'AT'] : ['US'],
    ships_to_regions: r() < 0.5 ? ['EU'] : [],
    dietary_tags: pick(r, 0.5),
    ingredients_primary: pick(r, 0.2),
    price_cents: Math.floor(r() * 10000),
  };
}

function genContext(r: () => number): UserHealthContext {
  return baseContext({
    allergies: pick(r, 0.2),
    contraindications: pick(r, 0.2),
    current_medications: pick(r, 0.2),
    dietary_restrictions: pick(r, 0.15),
    religious_restrictions: pick(r, 0.1),
    ingredient_sensitivities: pick(r, 0.2),
    budget_max_per_product_cents: r() < 0.5 ? Math.floor(r() * 10000) : null,
    country_code: r() < 0.5 ? 'DE' : null,
    region_group: r() < 0.5 ? 'EU' : null,
  } as Partial<UserHealthContext>);
}

function isInOrderSubsequence<T>(sub: T[], full: T[]): boolean {
  let j = 0;
  for (const x of full) if (j < sub.length && sub[j] === x) j++;
  return j === sub.length;
}

describe('applyUserLimitations — hide-only (VTID-05025)', () => {
  it('for 500 generated product lists and contexts, never adds or reorders products', () => {
    const r = rng(5025);
    for (let run = 0; run < 500; run++) {
      const products = Array.from({ length: Math.floor(r() * 20) }, (_, i) => genProduct(r, i));
      const ctx = genContext(r);
      const opts = {
        bypass_budget: r() < 0.3,
        bypass_dietary: r() < 0.3,
        bypass_sensitivities: r() < 0.3,
      };
      const { allowed, hidden_breakdown } = applyUserLimitations(products, ctx, opts);

      expect(allowed.length).toBeLessThanOrEqual(products.length);
      expect(isInOrderSubsequence(allowed, products)).toBe(true);
      const hidden = Object.values(hidden_breakdown).reduce((a, b) => a + b, 0);
      expect(allowed.length + hidden).toBe(products.length);
    }
  });

  it('with no limitations at all, returns every product in its original order', () => {
    const r = rng(7);
    const products = Array.from({ length: 15 }, (_, i) => genProduct(r, i));
    const { allowed } = applyUserLimitations(products, baseContext());
    expect(allowed).toEqual(products);
  });
});
