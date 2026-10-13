/**
 * VTID-05163 (Health Hub Phase 1 / B3) — GET /api/v1/admin/health/index-dual-compute/report
 * (plan Change 12): 401 without a token, 403 for a non-admin, input
 * validation, 503 while the Aurora-only table is absent, and an
 * aggregates-only body for exafy_admin (no member id, no health value).
 * Also the derived-mode /recompute/daily step 1 (deriveFeaturesForRecompute).
 */
import express from 'express';
import request from 'supertest';

let mockIdentity: { user_id: string; exafy_admin: boolean } | null = null;
jest.mock('../../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    requireAuth: (req: { identity?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!mockIdentity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = mockIdentity;
      next();
    },
  };
});
const mockRows: Array<Record<string, unknown>> = [];
let mockFail: string | null = null;
const mockSb = {
  from: jest.fn(() => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gte', 'lte', 'order']) q[m] = () => q;
    q.limit = async () => (mockFail ? { data: null, error: { code: mockFail, message: 'relation "vitana_index_dual_compute" does not exist' } } : { data: mockRows, error: null });
    return q;
  }),
};
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSb) }));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import router from '../../src/routes/admin-health-dual-compute';
import { deriveFeaturesForRecompute } from '../../src/services/health-features/recompute-features-step';
import type { DerivationDeps } from '../../src/services/health-features/derive-daily-features';

const app = express();
app.use('/api/v1/admin/health/index-dual-compute', router);
const URL = '/api/v1/admin/health/index-dual-compute/report';

beforeEach(() => {
  mockIdentity = null;
  mockFail = null;
  mockRows.length = 0;
});

describe('GET /report', () => {
  it('401 without a token, 403 for a non-admin — JSON', async () => {
    let r = await request(app).get(URL);
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toMatch(/json/);
    mockIdentity = { user_id: 'u', exafy_admin: false };
    r = await request(app).get(URL);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  it('validates from / to / scope', async () => {
    mockIdentity = { user_id: 'admin', exafy_admin: true };
    expect((await request(app).get(`${URL}?from=2026-10-10&to=2026-10-01`)).body.error).toBe('INVALID_RANGE');
    expect((await request(app).get(`${URL}?from=bad`)).body.error).toBe('INVALID_RANGE');
    expect((await request(app).get(`${URL}?from=2024-01-01&to=2026-10-01`)).body.error).toBe('RANGE_TOO_LONG');
    expect((await request(app).get(`${URL}?scope=members`)).body.error).toBe('INVALID_SCOPE');
  });

  it('503 while the Aurora-only table is absent', async () => {
    mockIdentity = { user_id: 'admin', exafy_admin: true };
    mockFail = '42P01';
    const r = await request(app).get(URL);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: 'DUAL_COMPUTE_STORE_PENDING' });
  });

  it('aggregates only for exafy_admin: no member id, no value', async () => {
    mockIdentity = { user_id: 'admin', exafy_admin: true };
    mockRows.push(
      { user_id: 'secret-member-1', date: '2026-10-10', scope: 'device', live_total: 300, legacy_total: 300, v2_total: 312, device_rows_missing: 1, device_rows_extra: 0, self_rows_missing: 0, self_rows_extra: 0, diff_class: ['derivation_gap'], formula_ok: true, failure_code: null },
      { user_id: 'secret-member-2', date: '2026-10-11', scope: 'device', live_total: 410, legacy_total: 410, v2_total: 410, device_rows_missing: 0, device_rows_extra: 0, self_rows_missing: 0, self_rows_extra: 0, diff_class: [], formula_ok: true, failure_code: null },
    );
    const r = await request(app).get(`${URL}?from=2026-10-01&to=2026-10-13&scope=device`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.report).toMatchObject({ member_days: 2, compared: 2, delta_total_zero_pct: 50, abs_delta_total: { max: 12 } });
    expect(Object.keys(r.body).sort()).toEqual(['dual_write_failure_counters', 'ok', 'report', 'stage']);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('secret-member');
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('410'); // no Index value leaves
  });
});

describe('deriveFeaturesForRecompute (derived-mode /recompute/daily step 1)', () => {
  const userClient = (id: string | null) => ({ auth: { getUser: async () => ({ data: { user: id ? { id } : null }, error: null }) } }) as never;
  const admin = (tenant: string | null) => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: tenant ? { tenant_id: tenant } : null, error: null });
      return q;
    },
  }) as never;
  const derivation = (env: NodeJS.ProcessEnv) => (): DerivationDeps => ({
    read: async () => ({ ok: true, rows: [] }),
    repo: {} as never,
    now: () => new Date('2026-10-13T00:00:00Z'),
    env,
    emit: async () => ({ ok: true }),
    log: () => undefined,
  });

  it('answers in W-sql\'s shape; a missing user / tenant / switch is a FEATURES_DERIVATION_FAILED result', async () => {
    expect(await deriveFeaturesForRecompute(userClient(null), '2026-10-12', { admin: () => admin('t'), derivation: derivation({}) }))
      .toEqual({ data: { ok: false, error: 'FEATURES_DERIVATION_FAILED', message: 'UNAUTHENTICATED' }, error: null });
    expect(await deriveFeaturesForRecompute(userClient('u'), '2026-10-12', { admin: () => admin(null), derivation: derivation({}) }))
      .toEqual({ data: { ok: false, error: 'FEATURES_DERIVATION_FAILED', message: 'NO_TENANT' }, error: null });
    expect(await deriveFeaturesForRecompute(userClient('u'), '2026-10-12', { admin: () => admin('t'), derivation: derivation({}) }))
      .toEqual({ data: { ok: false, error: 'FEATURES_DERIVATION_FAILED', message: 'CUTOVER_OFF' }, error: null });
    expect(await deriveFeaturesForRecompute(userClient('u'), '2026-10-12', { admin: () => null, derivation: derivation({}) }))
      .toMatchObject({ data: { ok: false, message: 'DB_UNAVAILABLE' } });
  });
});
