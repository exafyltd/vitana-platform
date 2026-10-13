/**
 * VTID-05148 — Autonomy Pulse fifth source `graduation_proposal` (L3 Learn):
 * open proposals (learn.graduation.proposed not yet withdrawn) from
 * oasis_events, read-only with one "Open" link, counted in /pulse and
 * /pulse/counts, and labelled in the Command Hub card.
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (_req: any, res: any) => res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' }),
}));

import { aggregatePulse } from '../src/routes/autonomy-pulse';

const proposal = (id: string, key: string, at: string, topic = 'learn.graduation.proposed') => ({
  id,
  topic,
  created_at: at,
  message: `Graduation proposed for ${key}`,
  metadata: {
    class_key: key,
    scanner_name: key.split('|')[0],
    risk_class: key.split('|')[1] === 'unknown' ? null : key.split('|')[1],
    executions: 22,
    successes: 22,
    success_rate: 1,
    window_days: 30,
    rule: 'autopilot_recommendations.auto_exec_eligible … never applied by code',
  },
});

describe('aggregatePulse — graduation_proposal', () => {
  it('normalizes an open proposal: info severity, one Open action, a link to Dev Autopilot', () => {
    const items = aggregatePulse([], [], [], [], [proposal('ev-1', 'missing-test-scanner|low', new Date().toISOString())]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'graduation_proposal:ev-1',
      source: 'graduation_proposal',
      title: 'Graduation proposal: missing-test-scanner (low risk)',
      severity: 'info',
      actions: ['investigate'],
      source_url: '/command-hub/dev-autopilot?scanner=missing-test-scanner',
      metadata: { class_key: 'missing-test-scanner|low', executions: 22, success_rate: 1, window_days: 30 },
    });
  });

  it('the four existing sources are unchanged when no proposals are passed', () => {
    expect(aggregatePulse([], [], [])).toEqual([]);
  });
});

describe('GET /api/v1/autonomy/pulse and /pulse/counts', () => {
  const events = [
    proposal('ev-1', 'a|low', '2026-10-12T12:00:00Z'),
    proposal('ev-2', 'b|low', '2026-10-05T12:00:00Z'),
    proposal('ev-3', 'b|low', '2026-10-12T12:00:00Z', 'learn.graduation.withdrawn'),
  ];
  const urls: Array<{ url: string; method: string }> = [];

  function app() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/autonomy-pulse').default;
    const a = express();
    a.use('/api/v1/autonomy', router);
    return a;
  }

  beforeEach(() => {
    urls.length = 0;
    process.env.SUPABASE_URL = 'https://supa.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc';
    process.env.GATEWAY_INTERNAL_TOKEN = 'internal';
    (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
      urls.push({ url: String(url), method: init.method || 'GET' });
      const body = String(url).includes('/oasis_events?') ? events : [];
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    });
  });

  it('unauthenticated → 401 JSON (the route stays gated)', async () => {
    const res = await request(app()).get('/api/v1/autonomy/pulse');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('filter=all carries the open proposal (a|low) and not the withdrawn one; read-only', async () => {
    const res = await request(app()).get('/api/v1/autonomy/pulse').set('X-Gateway-Internal', 'internal');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual(['graduation_proposal:ev-1']);
    expect(res.body.counts).toMatchObject({ graduations: 1, total: 1, info: 1 });
    const oasis = urls.find((u) => u.url.includes('/oasis_events?'))!;
    expect(oasis.url).toContain('topic=in.(learn.graduation.proposed,learn.graduation.withdrawn)');
    expect(urls.every((u) => u.method === 'GET')).toBe(true);
  });

  it('filter=graduations reads only the proposals', async () => {
    const res = await request(app()).get('/api/v1/autonomy/pulse?filter=graduations').set('X-Gateway-Internal', 'internal');
    expect(res.body.counts).toMatchObject({ findings: 0, heals: 0, executions: 0, contracts: 0, graduations: 1 });
    expect(urls.map((u) => u.url.split('?')[0])).toEqual(['https://supa.test/rest/v1/oasis_events']);
  });

  it('filter=findings does not read proposals', async () => {
    const res = await request(app()).get('/api/v1/autonomy/pulse?filter=findings').set('X-Gateway-Internal', 'internal');
    expect(res.body.counts.graduations).toBe(0);
    expect(urls.some((u) => u.url.includes('/oasis_events?'))).toBe(false);
  });

  it('/pulse/counts counts open proposals into the total', async () => {
    const res = await request(app()).get('/api/v1/autonomy/pulse/counts').set('X-Gateway-Internal', 'internal');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ findings: 0, heals: 0, executions: 0, contracts: 0, graduations: 1, total: 1 });
  });
});

describe('Command Hub card label', () => {
  const APP = fs.readFileSync(path.resolve(__dirname, '../src/frontend/command-hub/app.js'), 'utf8');
  it('labels and colours the new source; the old three are unchanged', () => {
    expect(APP).toContain("if (s === 'graduation_proposal') return 'GRADUATION';");
    expect(APP).toContain("if (s === 'graduation_proposal') return '#3b82f6';");
    expect(APP).toContain("return s === 'dev_autopilot_finding' ? 'DEV AUTOPILOT' : s === 'self_healing' ? 'SELF-HEAL' : 'EXECUTION';");
  });
  it('investigate (Open) on any item only navigates — no handler can act on a proposal', () => {
    expect(APP).toContain("if (action === 'view_plan' || action === 'view_trace' || action === 'investigate') {");
    expect(APP).not.toMatch(/item\.source === 'graduation_proposal'/);
  });
});
