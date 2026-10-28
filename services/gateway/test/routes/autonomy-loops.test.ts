/**
 * VTID-05084 — GET /api/v1/autonomy/loops (routes/autonomy-loops.ts).
 * exafy_admin only, through the shared middleware; GET only; the catalog is
 * served even when the run ledger cannot be read.
 */
import express from 'express';
import request from 'supertest';

let identity: any;
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = identity;
    return next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) =>
    req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
}));

let supabase: any = null;
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => supabase }));

import { resetCatalogCache } from '../../src/services/loop-catalog';

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/autonomy-loops').default;
  const app = express();
  app.use('/api/v1/autonomy', router);
  return app;
}

beforeEach(() => {
  identity = null;
  supabase = null;
  resetCatalogCache();
});

describe('GET /api/v1/autonomy/loops', () => {
  it('401 without a token', async () => {
    const res = await request(buildApp()).get('/api/v1/autonomy/loops');
    expect(res.status).toBe(401);
  });

  it('403 for a signed-in non-admin', async () => {
    identity = { user_id: 'u1', exafy_admin: false };
    const res = await request(buildApp()).get('/api/v1/autonomy/loops');
    expect(res.status).toBe(403);
  });

  it('200 for an exafy_admin: catalog, coverage, signals and totals', async () => {
    identity = { user_id: 'u1', exafy_admin: true };
    const res = await request(buildApp()).get('/api/v1/autonomy/loops');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const d = res.body.data;
    expect(d.catalog.loops).toHaveLength(14);
    expect(d.catalog.components.map((c: any) => c.id)).toEqual(
      ['intake', 'executor', 'run_ledger', 'human_inbox', 'claim_verifier', 'red_flag_rules'],
    );
    expect(d.totals).toMatchObject({ loops: 14, cases: 100 });
    expect(d.coverage.live.health_groups.orphans).toEqual([]);
    expect(d.coverage.live.test_contracts.orphans).toEqual([]);
    // No database client here: every plane signal degrades, the catalog still serves.
    expect(d.signals.self_healing).toEqual({ state: 'unavailable' });
  });

  it('reads the run ledger and the latest learn-outcomes run only (select), never writes', async () => {
    identity = { user_id: 'u1', exafy_admin: true };
    const tables: string[] = [];
    const ops: string[] = [];
    supabase = {
      from(table: string) {
        tables.push(table);
        const chain: any = {
          select: () => { ops.push('select'); return chain; },
          eq: () => chain,
          gte: () => chain,
          in: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: [{ status: 'succeeded', created_at: '2026-10-12T00:00:00Z' }], error: null }),
        };
        for (const w of ['insert', 'update', 'upsert', 'delete']) chain[w] = () => { ops.push(w); return chain; };
        return chain;
      },
    };
    const res = await request(buildApp()).get('/api/v1/autonomy/loops');
    expect(res.status).toBe(200);
    // VTID-05148: routine_runs is read for the L3 card's metrics_latest.
    expect(new Set(tables)).toEqual(new Set(['agent_runs_unified', 'routine_runs']));
    expect(ops.every((o) => o === 'select')).toBe(true);
    expect(res.body.data.signals.self_healing).toMatchObject({ state: 'ok', total: 1 });
  });

  it('registers GET only', async () => {
    identity = { user_id: 'u1', exafy_admin: true };
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await (request(buildApp()) as any)[m]('/api/v1/autonomy/loops');
      expect(res.status).toBe(404);
    }
  });
});
