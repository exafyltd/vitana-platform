/**
 * VTID-05153 — GET /api/v1/autonomy/loops returns metrics_latest.L9 (the latest
 * supplier-catalog-check run's findings.metrics from routine_runs), and the
 * Loops screen shows the L9 numbers on the L9 card only.
 */
import express from 'express';
import request from 'supertest';
import { FakeEl, fakeDocument } from './command-hub/fixtures/fake-dom';

let identity: any;
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = identity;
    return next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) =>
    req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
}));

let supabase: any = null;
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => supabase }));

import { buildCatalogResponse, METRICS_ROUTINES, resetCatalogCache } from '../src/services/loop-catalog';

const L9_METRICS = {
  category: 'supplements',
  rows_checked: 20,
  rows_auto_normalized: 11,
  validation_failure_rate: 0.25,
  ready_for_approval_share: 0.625,
  ready_for_approval_target: 0.8,
  by_state: { ready_for_review: 25, needs_fix: 10, needs_review: 3, returned_to_supplier: 2 },
  by_error_code: { image_missing: 3, price_not_positive: 2 },
  time_to_listing: { state: 'not_measured', reason: 'x' },
  human_edits_per_listing: { state: 'not_measured', reason: 'y' },
};

/** routine_runs fake: answers per routine_name. */
function fakeSb(byRoutine: Record<string, unknown[]>, calls: string[] = []) {
  return {
    from(table: string) {
      let routine = '';
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: string) => { if (k === 'routine_name') routine = v; return chain; },
        gte: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => {
          calls.push(`${table}:${routine}`);
          return Promise.resolve({ data: table === 'routine_runs' ? byRoutine[routine] ?? [] : [], error: null });
        },
      };
      return chain;
    },
  } as any;
}

describe('METRICS_ROUTINES', () => {
  it('L9 reads supplier-catalog-check', () => {
    expect(METRICS_ROUTINES.L9).toBe('supplier-catalog-check');
  });
});

describe('GET /api/v1/autonomy/loops — metrics_latest.L9', () => {
  function app() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/autonomy-loops').default;
    const a = express();
    a.use('/api/v1/autonomy', router);
    return a;
  }
  beforeEach(() => { identity = null; supabase = null; resetCatalogCache(); });

  it('unauthenticated → 401 JSON', async () => {
    const res = await request(app()).get('/api/v1/autonomy/loops');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('exafy_admin gets the latest supplier-catalog-check run as metrics_latest.L9; no run yet stays explicit', async () => {
    identity = { user_id: 'u1', exafy_admin: true };
    const calls: string[] = [];
    supabase = fakeSb({ 'supplier-catalog-check': [{ started_at: '2026-10-14T13:00:04Z', status: 'success', findings: { metrics: L9_METRICS, run: {} } }] }, calls);
    const res = await request(app()).get('/api/v1/autonomy/loops');
    expect(res.status).toBe(200);
    expect(res.body.data.metrics_latest.L9).toEqual({
      state: 'ok', routine: 'supplier-catalog-check', run_at: '2026-10-14T13:00:04Z', status: 'success', metrics: L9_METRICS,
    });
    expect(res.body.data.metrics_latest.L3).toEqual({ state: 'no_run_yet', routine: 'learn-outcomes' });
    expect(calls).toContain('routine_runs:supplier-catalog-check');
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LC = require('../src/frontend/command-hub/loops-catalog.js').LoopsCatalog;
const flush = () => new Promise((r) => setImmediate(r));

describe('Loops screen — the L9 numbers on the L9 card', () => {
  async function mount(metrics_latest: unknown): Promise<FakeEl> {
    resetCatalogCache();
    const data = JSON.parse(JSON.stringify(await buildCatalogResponse(null)));
    data.metrics_latest = metrics_latest;
    LC.reset();
    const fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data }) });
    LC.render({ doc: fakeDocument, fetch, headers: (x: Record<string, string>) => x });
    await flush();
    await flush();
    return LC._internals.state.el as FakeEl;
  }
  const card = (el: FakeEl, id: string) => el.all('loops-card').find((c) => c.getAttribute('data-loop') === id)!;

  it('shows ready share against the target, failure rate, auto-normalized and returned rows on L9 only', async () => {
    const el = await mount({ L9: { state: 'ok', routine: 'supplier-catalog-check', run_at: 'x', status: 'success', metrics: L9_METRICS } });
    expect(card(el, 'L9').one('loops-card-metrics').textContent).toBe(
      'Ready for approval 62.5% (target 80%) · Failure rate 25% of 20 checked · Auto-normalized 11 · Returned to supplier 2',
    );
    expect(card(el, 'L3').all('loops-card-metrics')).toEqual([]);
  });

  it('no run yet, unavailable, and an empty run', () => {
    const t = LC._internals.metricsText;
    const l9 = { id: 'L9' };
    expect(t(l9, { L9: { state: 'no_run_yet', routine: 'supplier-catalog-check' } })).toBe('Metrics: no supplier-catalog-check run yet');
    expect(t(l9, { L9: { state: 'unavailable', routine: 'supplier-catalog-check' } })).toBe('Metrics unavailable');
    expect(t(l9, { L9: { state: 'ok', metrics: { ready_for_approval_share: null, ready_for_approval_target: 0.8, validation_failure_rate: null, rows_checked: 0 } } }))
      .toBe('Ready for approval n/a (target 80%) · Failure rate n/a of 0 checked · Auto-normalized 0 · Returned to supplier 0');
  });
});
