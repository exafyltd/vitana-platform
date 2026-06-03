/**
 * Unit tests for the community on-demand regeneration guards — VTID-03301.
 *
 * Verifies the guard chain that makes "regenerate the moment the queue empties"
 * safe instead of a runaway loop:
 *   enabled → consent → (empty queue) → cooldown → daily cap → generate.
 */

import { createClient } from '@supabase/supabase-js';
import { regenerateCommunityRecommendations } from '../../../src/services/recommendation-engine/community-regeneration';
import { generatePersonalRecommendations } from '../../../src/services/recommendation-engine/recommendation-generator';

jest.mock('@supabase/supabase-js');
jest.mock('../../../src/services/recommendation-engine/recommendation-generator', () => ({
  generatePersonalRecommendations: jest.fn(),
}));

const mockCreateClient = createClient as jest.Mock;
const mockGenerate = generatePersonalRecommendations as jest.Mock;

/**
 * Build a chainable supabase mock. `maybeSingle()` resolves per-table; the
 * count queries on autopilot_recommendations are awaited directly (the builder
 * is thenable) and consume `counts` in call order:
 *   requireEmptyQueue=true  → [activeQueue, cooldownWindow, today]
 *   requireEmptyQueue=false → [cooldownWindow, today]
 */
function makeSupabase(opts: {
  tenant?: { tenant_id: string } | null;
  settings?: { enabled?: boolean; max_recommendations_per_day?: number } | null;
  optOut?: { fact_value: string } | null;
  counts?: number[];
}) {
  let countIdx = 0;
  const builder: any = {};
  builder.from = jest.fn((t: string) => { builder._table = t; return builder; });
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.in = jest.fn(() => builder);
  builder.gte = jest.fn(() => builder);
  builder.order = jest.fn(() => builder);
  builder.limit = jest.fn(() => builder);
  builder.maybeSingle = jest.fn(async () => {
    if (builder._table === 'user_tenants') return { data: opts.tenant ?? null };
    if (builder._table === 'tenant_autopilot_settings') return { data: opts.settings ?? null };
    if (builder._table === 'memory_facts') return { data: opts.optOut ?? null };
    return { data: null };
  });
  // Thenable: resolves count queries against autopilot_recommendations.
  builder.then = (resolve: any) => {
    const c = opts.counts?.[countIdx++] ?? 0;
    return Promise.resolve({ count: c, data: [] }).then(resolve);
  };
  return builder;
}

const USER = 'a27552a3-0257-4305-8ed0-351a80fd3701';
const TENANT = { tenant_id: 'tenant-1' };

describe('regenerateCommunityRecommendations — guards', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE: 'svc' };
    mockGenerate.mockResolvedValue({ ok: true, generated: 4, run_id: 'run-1', errors: [] });
  });

  afterAll(() => { process.env = OLD_ENV; });

  it('skips when Autopilot is disabled for the tenant', async () => {
    mockCreateClient.mockReturnValue(makeSupabase({ tenant: TENANT, settings: { enabled: false } }));
    const res = await regenerateCommunityRecommendations(USER, { tenantId: TENANT.tenant_id });
    expect(res).toMatchObject({ ok: true, generated: 0, reason: 'disabled' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('skips when the user has opted out (consent)', async () => {
    mockCreateClient.mockReturnValue(
      makeSupabase({ tenant: TENANT, settings: { enabled: true }, optOut: { fact_value: 'true' } }),
    );
    const res = await regenerateCommunityRecommendations(USER, { tenantId: TENANT.tenant_id });
    expect(res).toMatchObject({ ok: true, generated: 0, reason: 'disabled' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('reports not_empty when the active queue is not empty (auto-trigger)', async () => {
    mockCreateClient.mockReturnValue(
      makeSupabase({ tenant: TENANT, settings: { enabled: true }, counts: [2] }),
    );
    const res = await regenerateCommunityRecommendations(USER, {
      tenantId: TENANT.tenant_id,
      requireEmptyQueue: true,
    });
    expect(res).toMatchObject({ ok: true, generated: 0, reason: 'not_empty' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('debounces via cooldown when a batch was created recently', async () => {
    mockCreateClient.mockReturnValue(
      makeSupabase({ tenant: TENANT, settings: { enabled: true }, counts: [3 /* cooldown window */] }),
    );
    const res = await regenerateCommunityRecommendations(USER, { tenantId: TENANT.tenant_id });
    expect(res).toMatchObject({ ok: true, generated: 0, reason: 'cooldown' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('honors the daily cap (all caught up for today)', async () => {
    mockCreateClient.mockReturnValue(
      makeSupabase({
        tenant: TENANT,
        settings: { enabled: true, max_recommendations_per_day: 5 },
        counts: [0 /* cooldown */, 5 /* today >= cap */],
      }),
    );
    const res = await regenerateCommunityRecommendations(USER, { tenantId: TENANT.tenant_id });
    expect(res).toMatchObject({ ok: true, generated: 0, reason: 'daily_cap' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('generates when all guards pass', async () => {
    mockCreateClient.mockReturnValue(
      makeSupabase({
        tenant: TENANT,
        settings: { enabled: true, max_recommendations_per_day: 20 },
        counts: [0 /* queue */, 0 /* cooldown */, 0 /* today */],
      }),
    );
    const res = await regenerateCommunityRecommendations(USER, {
      tenantId: TENANT.tenant_id,
      requireEmptyQueue: true,
    });
    expect(res).toMatchObject({ ok: true, generated: 4, run_id: 'run-1' });
    expect(mockGenerate).toHaveBeenCalledWith(USER, TENANT.tenant_id, { trigger_type: 'auto_replenish' });
  });

  it('reports no_signals when generation produced nothing fresh', async () => {
    mockGenerate.mockResolvedValue({ ok: true, generated: 0, run_id: 'run-2', errors: [] });
    mockCreateClient.mockReturnValue(
      makeSupabase({ tenant: TENANT, settings: { enabled: true }, counts: [0, 0] }),
    );
    const res = await regenerateCommunityRecommendations(USER, { tenantId: TENANT.tenant_id });
    expect(res).toMatchObject({ ok: true, generated: 0, reason: 'no_signals' });
  });

  it('skips when no primary tenant can be resolved', async () => {
    mockCreateClient.mockReturnValue(makeSupabase({ tenant: null }));
    const res = await regenerateCommunityRecommendations(USER);
    expect(res).toMatchObject({ ok: true, generated: 0, reason: 'disabled' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
