/**
 * VTID-02031d: ops "Action Required" panel must not keep surfacing
 * self-healing escalations whose endpoint has already recovered.
 *
 * Bug: fetchSelfHealEscalations only filtered on outcome + a 24h lookback —
 * it never re-checked whether the endpoint is healthy *now*. A row
 * tombstoned 'escalated' minutes before the endpoint self-recovered (or
 * recovered via an unrelated deploy) sat in the panel demanding manual
 * investigation for up to 24h with nothing left to investigate.
 */

import express from 'express';
import request from 'supertest';

const ORIGINAL_FETCH = global.fetch;

function freshRouter(): any {
  jest.resetModules();
  return require('../src/routes/ops-action-required').default;
}

function buildApp(router: any) {
  const app = express();
  app.use('/api/v1/ops/action-required', router);
  return app;
}

const SELF_HEAL_ROW = {
  vtid: 'SH-FALLBACK-1',
  endpoint: '/api/v1/vtid/health',
  failure_class: 'dependency_timeout',
  outcome: 'escalated',
  created_at: new Date().toISOString(),
  diagnosis: {},
};

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE;
});

describe('GET /api/v1/ops/action-required — self-heal live re-probe', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
  });

  it('drops a self-heal escalation whose endpoint now probes healthy', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/rest/v1/voice_healing_quarantine')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/rest/v1/voice_architecture_reports')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/rest/v1/self_healing_log')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([SELF_HEAL_ROW]) });
      }
      // Live re-probe of the endpoint itself — healthy JSON response.
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === 'content-type' ? 'application/json' : null) },
      });
    }) as unknown as typeof fetch;

    const app = buildApp(freshRouter());
    const res = await request(app).get('/api/v1/ops/action-required');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.count_total).toBe(0);
  });

  it('keeps a self-heal escalation whose endpoint is still down', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/rest/v1/voice_healing_quarantine')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/rest/v1/voice_architecture_reports')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/rest/v1/self_healing_log')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([SELF_HEAL_ROW]) });
      }
      // Live re-probe — still failing.
      return Promise.resolve({
        ok: false,
        status: 503,
        headers: { get: () => 'application/json' },
      });
    }) as unknown as typeof fetch;

    const app = buildApp(freshRouter());
    const res = await request(app).get('/api/v1/ops/action-required');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].source_id).toBe('SH-FALLBACK-1');
  });
});
