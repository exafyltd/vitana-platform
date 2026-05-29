/**
 * VTID-02930 (B1) — GET /api/v1/voice/greeting-policy/preview tests.
 *
 * The route is a pure simulator. Verify query parsing + response shape +
 * admin gating.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-greeting-policy').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('B1 — GET /api/v1/voice/greeting-policy/preview', () => {
  it('returns decision with reason + evidence for the default (bucket=first, no signals)', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/greeting-policy/preview');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vtid).toBe('VTID-02930');
    expect(res.body.decision.policy).toBe('fresh_intro');
    expect(res.body.decision.reason).toBe('bucket_with_decay_layer');
    expect(res.body.decision.fellBackToBucket).toBe(true);
  });

  it('parses isReconnect=true → skip', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/greeting-policy/preview?bucket=today&isReconnect=true',
    );
    expect(res.body.decision.policy).toBe('skip');
    expect(res.body.decision.reason).toBe('isReconnect_forces_skip');
  });

  it('parses numeric cadence signals correctly', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/greeting-policy/preview?bucket=today&seconds_since_last_turn_anywhere=60',
    );
    expect(res.body.decision.policy).toBe('skip');
    expect(res.body.decision.reason).toBe('recent_turn_continues_thread');
  });

  it('parses greeting_style_last_used and applies decay', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/greeting-policy/preview?bucket=today&greeting_style_last_used=warm_return',
    );
    expect(res.body.decision.policy).toBe('brief_resume');
  });

  it('rejects unknown bucket by falling back to first', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/greeting-policy/preview?bucket=made_up_bucket',
    );
    expect(res.status).toBe(200);
    // Unknown buckets get rewritten to 'first', which yields fresh_intro.
    expect(res.body.input.bucket).toBe('first');
    expect(res.body.decision.policy).toBe('fresh_intro');
  });

  it('rejects unknown greeting_style_last_used silently (treats as absent)', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/greeting-policy/preview?bucket=today&greeting_style_last_used=invented',
    );
    expect(res.body.input.greeting_style_last_used).toBeUndefined();
    expect(res.body.decision.policy).toBe('warm_return');
  });

  it('rejects unknown wake_origin silently (treats as absent)', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/greeting-policy/preview?bucket=long&wake_origin=made_up',
    );
    expect(res.body.input.wake_origin).toBeUndefined();
    expect(res.body.decision.policy).toBe('fresh_intro');
  });

  it('returns input echo so the panel can show what was simulated', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/greeting-policy/preview?bucket=today&sessions_today_count=5',
    );
    expect(res.body.input).toEqual({ bucket: 'today', sessions_today_count: 5 });
  });

  it('returns signalsPresent / signalsMissing for source-health', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/greeting-policy/preview?bucket=today&sessions_today_count=2',
    );
    expect(res.body.decision.signalsPresent).toEqual(['sessions_today_count']);
    expect(res.body.decision.signalsMissing.length).toBe(6);
  });
});
