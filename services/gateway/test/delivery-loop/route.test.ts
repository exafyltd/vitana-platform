/**
 * Delivery loop status route (routes/delivery-loop.ts): read-only, behind the control-plane gate, honest when no loop runs, and wired
 * into the gateway the way the Project Manager's route is (a claimed atlas route, mounted once, started only behind its switch).
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { createDeliveryLoopRouter, setDeliveryLoopStatusSource } from '../../src/routes/delivery-loop';
import { domainsForRoute } from '../../src/orb/developer/domain-atlas';
import type { LoopStatus } from '../../src/services/delivery-loop/runtime';

const SERVICE_TOKEN = 'service-token-for-the-delivery-loop-route-test';
const ENV0 = { ...process.env };

const status: LoopStatus = {
  enabled: true, not_running_reason: null, autonomy: 'L1', projects: ['vitana/rehearsal'], gitlab_configured: true, reviewer_configured: true, executor: null, cycle_ms: 60_000,
  last_cycle: { at: '2026-11-19T10:00:00.000Z', ran: true, reason: null, stats: { facts: 2, skipped: {}, decisions: 1, intents: 1, dispatched: 0, retried: 0, notes: 0, reviews: 0, verified: 0, exhausted: 0, learned: 0, proposals: 0, polled: 0, errors: 0 }, stopped_early: false },
};

function app(source?: () => LoopStatus | null) {
  const a = express();
  a.use('/api/v1/delivery-loop', source ? createDeliveryLoopRouter(source) : createDeliveryLoopRouter());
  return a;
}

beforeEach(() => {
  process.env = { ...ENV0, GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN };
  setDeliveryLoopStatusSource(() => null);
});
afterAll(() => {
  process.env = ENV0;
});

describe('GET /status', () => {
  it('is refused without the service token or an admin: 401, and the status is not leaked', async () => {
    const res = await request(app(() => status)).get('/api/v1/delivery-loop/status');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('vitana/rehearsal');
    const wrong = await request(app(() => status)).get('/api/v1/delivery-loop/status').set('Authorization', 'Bearer not-the-token');
    expect(wrong.status).toBe(401);
  });

  it('with the service token it answers the loop\'s status', async () => {
    const res = await request(app(() => status)).get('/api/v1/delivery-loop/status').set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, enabled: true, autonomy: 'L1', projects: ['vitana/rehearsal'], gitlab_configured: true, executor: null, cycle_ms: 60_000 });
    expect(res.body.last_cycle).toMatchObject({ ran: true, stopped_early: false });
  });

  it('with no loop started it says so plainly, as a 200 and not an empty object', async () => {
    const res = await request(app()).get('/api/v1/delivery-loop/status').set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: false, not_running_reason: 'the delivery loop was not started in this process' });
  });

  it('reads the loop index.ts registered, so the route is the live one', async () => {
    setDeliveryLoopStatusSource(() => status);
    const res = await request(app()).get('/api/v1/delivery-loop/status').set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    expect(res.body.autonomy).toBe('L1');
  });

  it('is read-only: no write, act or enable endpoint exists', async () => {
    const a = app(() => status);
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      for (const p of ['/status', '/enable', '/start', '/act', '/level', '/autonomy', '/cycle']) {
        const r = await request(a)[method](`/api/v1/delivery-loop${p}`).set('Authorization', `Bearer ${SERVICE_TOKEN}`).send({});
        expect({ method, p, status: r.status }).toEqual({ method, p, status: 404 });
      }
    }
  });

  it('carries no secret: the token, an issue\'s text and a log line are not part of the status type', async () => {
    const res = await request(app(() => status)).get('/api/v1/delivery-loop/status').set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    const text = JSON.stringify(res.body).toLowerCase();
    for (const word of ['token', 'password', 'secret', 'glpat', 'description', 'trace', 'log']) expect(text).not.toContain(word);
  });
});

describe('how it is wired into the gateway', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');

  it('is mounted once, at /api/v1/delivery-loop, through the duplicate-route guard', () => {
    const mounts = src.match(/mountRouterSync\(app, '\/api\/v1\/delivery-loop'/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(src).toContain("mountRouterSync(app, '/api/v1/delivery-loop', deliveryLoopRouter, { owner: 'delivery-loop' })");
  });

  it('starts the loop only behind the exact switch, with a non-fatal catch, and never enables it by default', () => {
    const i = src.indexOf("process.env.DELIVERY_LOOP_ENABLED === 'true'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i - 200, i + 1400);
    expect(block).toContain('startDeliveryLoop');
    expect(block).toContain('Delivery loop initialization failed (non-fatal)');
    expect(src).not.toMatch(/DELIVERY_LOOP_ENABLED\s*=\s*['"]true['"]/);
    expect(src.match(/startDeliveryLoop/g)).toHaveLength(1);
  });

  it('the route file is claimed by a domain of the developer atlas (the drift guard)', () => {
    expect(domainsForRoute('delivery-loop').map((d) => d.key)).toEqual(['deploy']);
    // and it does not collide with its neighbour
    expect(domainsForRoute('delivery').map((d) => d.key)).toEqual(['deploy']);
  });
});
