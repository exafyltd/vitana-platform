/**
 * VTID-04886 — POST /api/v1/ops/attention/ack and /snooze: requireAdminAuth,
 * Zod validation (reason required, expiry <= 24 h), P1 ackable but never
 * snoozable (400), the item must be open now in this env (404 otherwise),
 * one ops_attention_acks row + one OASIS event per action, and the next GET
 * shows the effect (cache invalidated). No network, no database: fake reads,
 * an in-memory ack store and a fake OASIS emitter.
 */

import express from 'express';
import request from 'supertest';
import type { AckRow, AttentionAckStore } from '../src/services/ops-attention';
import { fakeReads } from './fixtures/ops-attention-fakes';

describe('POST /ack, /snooze — real auth middleware', () => {
  it('401 JSON without an Authorization header; nothing is written or emitted', async () => {
    jest.resetModules();
    const svc = require('../src/services/ops-attention');
    const insert = jest.fn();
    const emit = jest.fn();
    svc.setOpsAttentionDepsForTests({ reads: () => fakeReads(), state: () => ({ load: async () => [], save: async () => {} }), acks: () => ({ active: async () => [], insert }), emit });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/ops/attention', require('../src/routes/ops-attention').default);
    for (const path of ['ack', 'snooze']) {
      const res = await request(app).post(`/api/v1/ops/attention/${path}`).send({ fingerprint: 'production:x:y', reason: 'abc', duration_minutes: 60 });
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
    expect(insert).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    svc.setOpsAttentionDepsForTests(null);
  });
});

describe('POST /ack, /snooze — admin (middleware mocked)', () => {
  const NOW = Date.now();
  const H = 3_600_000;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  let rows: AckRow[];
  let emitted: any[];
  let emitResult: { ok: boolean; error?: string };
  let svc: any;

  function build(isAdmin = true) {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      requireAdminAuth: (req: any, res: any, next: any) => {
        if (!isAdmin) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
        req.identity = { user_id: '11111111-1111-1111-1111-111111111111', email: 'admin@exafy.io', exafy_admin: true };
        return next();
      },
    }));
    svc = require('../src/services/ops-attention');
    rows = [];
    emitted = [];
    emitResult = { ok: true };
    const store: AttentionAckStore = {
      active: async (env, nowIso) => rows.filter((r) => r.env === env && r.expires_at > nowIso),
      insert: async (row) => {
        const full = { id: `ack-${rows.length + 1}`, ...row };
        rows.push(full);
        return full;
      },
    };
    svc.setOpsAttentionDepsForTests({
      // A P1 (golden-path health, held via state), a P2 (critical alert) and a P3 (warning alert).
      reads: () => fakeReads({
        healthSummary: async () => ({ checked_at: ago(0), items: [{ name: 'Gateway', url: '/alive', group: 'Core', golden_path: true, status: 'down', healthy: false, http_status: 503, latency_ms: 1 }] }),
        supervisorAlerts: async () => [
          { severity: 'critical', text: 'LLM providers are failing', tab: 'live' },
          { severity: 'warning', text: 'scanner slow', tab: 'scanners' },
        ],
      }),
      state: () => ({ load: async (_env: string, fps: string[]) => fps.map((f) => ({ fingerprint: f, first_seen: ago(10 * 60_000), last_seen: ago(10_000) })), save: async () => {} }),
      acks: () => store,
      emit: async (e: any) => { emitted.push(e); return emitResult; },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/ops/attention', require('../src/routes/ops-attention').default);
    return app;
  }

  afterEach(() => {
    svc?.setOpsAttentionDepsForTests(null);
    jest.dontMock('../src/middleware/auth-supabase-jwt');
  });

  async function fps(app: express.Express) {
    const res = await request(app).get('/api/v1/ops/attention').set('Authorization', 'Bearer a');
    const by = (sev: string) => res.body.data.items.find((i: any) => i.severity === sev).fingerprint as string;
    return { p1: by('P1'), p2: by('P2'), p3: by('P3'), data: res.body.data };
  }

  it('a non-admin is refused by the gate', async () => {
    const app = build(false);
    const res = await request(app).post('/api/v1/ops/attention/ack').send({});
    expect(res.status).toBe(403);
  });

  it('Zod: reason required, expiry <= 24 h, integer minutes, known keys only, vtid shape', async () => {
    const app = build();
    const { p2 } = await fps(app);
    const bad: Array<Record<string, unknown>> = [
      { fingerprint: p2, duration_minutes: 60 },
      { fingerprint: p2, reason: '  ', duration_minutes: 60 },
      { fingerprint: p2, reason: 'ok reason', duration_minutes: 24 * 60 + 1 },
      { fingerprint: p2, reason: 'ok reason', duration_minutes: 1.5 },
      { fingerprint: p2, reason: 'ok reason' },
      { fingerprint: p2, reason: 'ok reason', duration_minutes: 60, vtid: '1234' },
      { fingerprint: p2, reason: 'ok reason', duration_minutes: 60, severity: 'P3' },
      { reason: 'ok reason', duration_minutes: 60 },
    ];
    for (const body of bad) {
      for (const path of ['ack', 'snooze']) {
        const res = await request(app).post(`/api/v1/ops/attention/${path}`).set('Authorization', 'Bearer a').send(body);
        expect([res.status, res.body.error]).toEqual([400, 'invalid_body']);
      }
    }
    expect(rows).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('P1 is ackable but NEVER snoozable (400 p1_not_snoozable); the severity is the server\'s', async () => {
    const app = build();
    const { p1 } = await fps(app);
    const snooze = await request(app).post('/api/v1/ops/attention/snooze').set('Authorization', 'Bearer a')
      .send({ fingerprint: p1, reason: 'please hide', duration_minutes: 60 });
    expect([snooze.status, snooze.body.error]).toEqual([400, 'p1_not_snoozable']);
    expect(rows).toHaveLength(0);
    const ack = await request(app).post('/api/v1/ops/attention/ack').set('Authorization', 'Bearer a')
      .send({ fingerprint: p1, reason: 'on it, paging the owner', duration_minutes: 30, vtid: 'VTID-05001' });
    expect(ack.status).toBe(201);
    expect(ack.body.data).toMatchObject({ action: 'ack', fingerprint: p1, severity: 'P1', oasis_emitted: true });
    // The acked P1 is still shown (de-emphasised), and the verdict is still CRITICAL.
    const after = await fps(app);
    expect(after.data.items.find((i: any) => i.fingerprint === p1).ack).toMatchObject({ action: 'ack', reason: 'on it, paging the owner', actor_email: 'admin@exafy.io', vtid: 'VTID-05001' });
    expect(after.data.verdict).toBe('CRITICAL');
    expect(after.data.counts).toMatchObject({ p1: 1, acked: 1, hidden: 0 });
  });

  it('snooze a P2: one row (actor, reason, expiry <= 24 h), one OASIS event, and the next GET hides it and counts it', async () => {
    const app = build();
    const { p2 } = await fps(app);
    const before = Date.now();
    const res = await request(app).post('/api/v1/ops/attention/snooze').set('Authorization', 'Bearer a')
      .send({ fingerprint: p2, reason: 'provider outage known, tracked', duration_minutes: 24 * 60 });
    expect(res.status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      env: 'production', fingerprint: p2, action: 'snooze', reason: 'provider outage known, tracked', severity: 'P2',
      actor_user_id: '11111111-1111-1111-1111-111111111111', actor_email: 'admin@exafy.io', vtid: null,
    });
    const span = Date.parse(rows[0].expires_at) - Date.parse(rows[0].created_at);
    expect(span).toBe(24 * H);
    expect(Date.parse(rows[0].created_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'ops.attention.snoozed', vtid: 'VTID-04886', surface: 'command-hub', actor_email: 'admin@exafy.io',
      payload: expect.objectContaining({ fingerprint: p2, action: 'snooze', severity: 'P2', reason: 'provider outage known, tracked', ack_id: 'ack-1' }),
    });
    const g = await request(app).get('/api/v1/ops/attention').set('Authorization', 'Bearer a');
    const d = g.body.data;
    expect(d.items.some((i: any) => i.fingerprint === p2)).toBe(false);
    expect(d.hidden).toEqual([expect.objectContaining({ fingerprint: p2, severity: 'P2', reason: 'provider outage known, tracked', actor_email: 'admin@exafy.io' })]);
    expect(d.counts).toMatchObject({ p2: 0, hidden: 1 });
    expect(d.domains.find((x: any) => x.key === 'autonomy')).toMatchObject({ hidden: 1, open: 1 });
  });

  it('ack emits ops.attention.acked; an OASIS failure is reported, the action still stands', async () => {
    const app = build();
    const { p3 } = await fps(app);
    emitResult = { ok: false, error: 'insert failed' };
    const res = await request(app).post('/api/v1/ops/attention/ack').set('Authorization', 'Bearer a')
      .send({ fingerprint: p3, reason: 'looking', duration_minutes: 60 });
    expect(res.status).toBe(201);
    expect(res.body.data.oasis_emitted).toBe(false);
    expect(emitted[0].type).toBe('ops.attention.acked');
  });

  it('an item that is not open now is 404 not_open; another env\'s fingerprint is 400 wrong_env', async () => {
    const app = build();
    await fps(app);
    const gone = await request(app).post('/api/v1/ops/attention/ack').set('Authorization', 'Bearer a')
      .send({ fingerprint: 'production:release:nothing', reason: 'x y z', duration_minutes: 60 });
    expect([gone.status, gone.body.error]).toEqual([404, 'not_open']);
    const env = await request(app).post('/api/v1/ops/attention/ack').set('Authorization', 'Bearer a')
      .send({ fingerprint: 'staging:release:x', reason: 'x y z', duration_minutes: 60 });
    expect([env.status, env.body.error]).toEqual([400, 'wrong_env']);
    expect(rows).toHaveLength(0);
  });

  it('the write-side cap holds even without the route (recordOpsAttentionAction refuses > 24 h)', async () => {
    build();
    const out = await svc.recordOpsAttentionAction({
      action: 'ack', fingerprint: 'production:x:y', reason: 'abc', durationMinutes: 24 * 60 + 1, vtid: null, actor: { user_id: null, email: null },
    });
    expect(out).toEqual({ ok: false, status: 400, error: 'expiry_over_24h' });
  });

  it('index.ts: the ack/snooze routes ride the existing /api/v1/ops/attention mount after express.json()', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/index.ts'), 'utf8');
    expect(src.indexOf("mountRouterSync(app, '/api/v1/ops/attention', opsAttentionRouter")).toBeGreaterThan(src.indexOf("app.use(express.json({ limit: '2mb' }))"));
    const route = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/ops-attention.ts'), 'utf8');
    expect(route).toMatch(/router\.post\('\/ack', requireAdminAuth, [^{]*\{[^}]*handler\('ack'\)\(req, res\)/);
    expect(route).toMatch(/router\.post\('\/snooze', requireAdminAuth, [^{]*\{[^}]*handler\('snooze'\)\(req, res\)/);
  });

  it('the OASIS event types are in the CicdEventType union', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/types/cicd.ts'), 'utf8');
    expect(src).toContain("| 'ops.attention.acked'");
    expect(src).toContain("| 'ops.attention.snoozed'");
  });
});
