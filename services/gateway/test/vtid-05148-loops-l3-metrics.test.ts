/**
 * VTID-05148 — GET /api/v1/autonomy/loops returns metrics_latest for L3 (the
 * latest learn-outcomes run's findings.metrics from routine_runs), and the
 * Loops screen shows the three numbers on the L3 card only.
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

import { buildCatalogResponse, latestLoopMetrics, METRICS_ROUTINES, resetCatalogCache } from '../src/services/loop-catalog';

const METRICS = {
  window_days: 30,
  repeat_failure: { fixes: 40, repeated: 6, rate: 0.15, follow_up_days: 7, by_class: [], truncated: false },
  pattern_reuse: { state: 'not_measured', reason: 'no fix records a repair_patterns reference' },
  escaped_bugs_to_tests: { with_tests: 3, without_tests: 9, unknown: 28, share: 0.25 },
};

function fakeSb(result: { data?: unknown[]; error?: { message: string } }, calls: Array<Record<string, unknown>> = []) {
  return {
    from(table: string) {
      const call: Record<string, unknown> = { table };
      calls.push(call);
      const chain: any = {
        select: (cols: string) => { call.select = cols; return chain; },
        eq: (k: string, v: unknown) => { call[`eq:${k}`] = v; return chain; },
        gte: () => chain,
        in: (k: string, v: unknown) => { call[`in:${k}`] = v; return chain; },
        order: (k: string, o: unknown) => { call.order = [k, o]; return chain; },
        limit: (n: number) => { call.limit = n; return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }); },
      };
      return chain;
    },
  } as any;
}

describe('latestLoopMetrics (routine_runs, read-only)', () => {
  it('L3 has a metrics routine: learn-outcomes (L9 joined in VTID-05153)', () => {
    expect(METRICS_ROUTINES).toEqual({ L3: 'learn-outcomes', L9: 'supplier-catalog-check' });
  });

  it('reads the latest success/partial learn-outcomes run and returns its findings.metrics', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sb = fakeSb({ data: [{ started_at: '2026-10-13T12:00:05Z', status: 'success', findings: { metrics: METRICS, tests_added_step: {} } }] }, calls);
    expect(await latestLoopMetrics(sb, 'learn-outcomes')).toEqual({
      state: 'ok', routine: 'learn-outcomes', run_at: '2026-10-13T12:00:05Z', status: 'success', metrics: METRICS,
    });
    expect(calls[0]).toMatchObject({
      table: 'routine_runs',
      select: 'started_at, status, findings',
      'eq:routine_name': 'learn-outcomes',
      'in:status': ['success', 'partial'],
      order: ['started_at', { ascending: false }],
      limit: 1,
    });
  });

  it('no run yet, a read error and no client never fail the catalog', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await latestLoopMetrics(fakeSb({ data: [] }), 'learn-outcomes')).toEqual({ state: 'no_run_yet', routine: 'learn-outcomes' });
    expect(await latestLoopMetrics(fakeSb({ error: { message: 'boom' } }), 'learn-outcomes')).toEqual({ state: 'unavailable', routine: 'learn-outcomes' });
    expect(await latestLoopMetrics(null, 'learn-outcomes')).toEqual({ state: 'unavailable', routine: 'learn-outcomes' });
    warn.mockRestore();
  });
});

describe('GET /api/v1/autonomy/loops — metrics_latest', () => {
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
    expect(res.body.ok).toBe(false);
  });

  it('exafy_admin gets metrics_latest.L3 from the latest learn-outcomes run', async () => {
    identity = { user_id: 'u1', exafy_admin: true };
    supabase = fakeSb({ data: [{ started_at: '2026-10-13T12:00:05Z', status: 'partial', findings: { metrics: METRICS } }] });
    const res = await request(app()).get('/api/v1/autonomy/loops');
    expect(res.status).toBe(200);
    // VTID-05153: L9 is read the same way (its own test covers it).
    expect(res.body.data.metrics_latest.L3).toEqual(
      { state: 'ok', routine: 'learn-outcomes', run_at: '2026-10-13T12:00:05Z', status: 'partial', metrics: METRICS },
    );
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LC = require('../src/frontend/command-hub/loops-catalog.js').LoopsCatalog;
const flush = () => new Promise((r) => setImmediate(r));

describe('Loops screen — the three numbers on the L3 card', () => {
  async function mount(metrics_latest: unknown): Promise<FakeEl> {
    resetCatalogCache();
    const data = JSON.parse(JSON.stringify(await buildCatalogResponse(null)));
    data.metrics_latest = metrics_latest;
    LC.reset();
    const fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data }) });
    const el: FakeEl = LC.render({ doc: fakeDocument, fetch, headers: (x: Record<string, string>) => x });
    await flush();
    await flush();
    return LC._internals.state.el as FakeEl;
  }
  const card = (el: FakeEl, id: string) => el.all('loops-card').find((c) => c.getAttribute('data-loop') === id)!;

  it('shows repeat-failure, pattern reuse and escaped bugs → tests on L3, nothing on other cards', async () => {
    const el = await mount({ L3: { state: 'ok', routine: 'learn-outcomes', run_at: 'x', status: 'success', metrics: METRICS } });
    expect(card(el, 'L3').one('loops-card-metrics').textContent).toBe(
      'Repeat-failure 15% (6/40 fixes) · Pattern reuse not measured · Escaped bugs → tests 25% (3/12, 28 unknown)',
    );
    expect(card(el, 'L1').all('loops-card-metrics')).toEqual([]);
  });

  it('a measured pattern share, no run yet, and unavailable', () => {
    const t = LC._internals.metricsText;
    const l3 = { id: 'L3' };
    const measured = { ...METRICS, pattern_reuse: { state: 'measured', fixes: 40, reused: 4, share: 0.1 } };
    expect(t(l3, { L3: { state: 'ok', metrics: measured } })).toContain('Pattern reuse 10% (4/40)');
    expect(t(l3, { L3: { state: 'no_run_yet', routine: 'learn-outcomes' } })).toBe('Metrics: no learn-outcomes run yet');
    expect(t(l3, { L3: { state: 'unavailable', routine: 'learn-outcomes' } })).toBe('Metrics unavailable');
    expect(t({ id: 'L1' }, { L3: { state: 'ok', metrics: METRICS } })).toBeNull();
    expect(t(l3, undefined)).toBeNull();
  });
});
