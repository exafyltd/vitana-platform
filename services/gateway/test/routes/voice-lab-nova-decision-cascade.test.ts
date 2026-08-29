/**
 * VTID-03729 — `/api/v1/voice-lab/nova/decision` must be able to report
 * `cascaded_language_rescue`, not just `nova_forced_vertex_unavailable`.
 *
 * This route is documented as answering "would THIS caller's next ORB
 * session ride Nova?" with the exact selector the live session path uses
 * — the manual-canary/audio-testing verification tool. But it never passed
 * a `cascade` context field into `selectUpstreamProvider()`, unlike
 * `orb-live.ts`'s real `connectToLiveAPI()` (BOOTSTRAP-CASCADE-WIRING seam
 * 1). So for pl/pt/ru/ar/zh — every language Nova cannot speak natively —
 * the probe always reported a forced-Nova verdict, even when the cascade
 * was enabled and would have rescued the session in reality. Confirmed
 * live on staging immediately after VTID-03723 merged: `?lang=pl` reported
 * `nova_forced_vertex_unavailable` while `/api/v1/orb/nova-sonic/health`'s
 * own cascade block reported `pl` as `cascade:pl-PL`-eligible — a false
 * negative in the platform owner's own verification tool.
 */

import request from 'supertest';
import express from 'express';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => res.status(401).json({ ok: false, error: 'Unauthorized' })),
  optionalAuth: jest.fn((req, res, next) => next()),
}));

import voiceLabRouter from '../../src/routes/voice-lab';

describe('VTID-03729: GET /nova/decision wires cascade context like the real session path', () => {
  let app: express.Express;
  const savedEnv = { ...process.env };

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/voice-lab', voiceLabRouter);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('lang=pl with the cascade enabled reports cascaded_language_rescue, not a forced-Nova verdict', async () => {
    process.env.ORB_CASCADED_VOICE_ENABLED = 'true';
    const res = await request(app).get('/api/v1/voice-lab/nova/decision?lang=pl');
    expect(res.status).toBe(200);
    expect(res.body.decision.provider).toBe('cascaded');
    expect(res.body.decision.provider).not.toBe('vertex');
    expect(res.body.decision.reason).toBe('cascaded_language_rescue');
  });

  it('lang=pt with the cascade enabled also reports cascaded_language_rescue', async () => {
    process.env.ORB_CASCADED_VOICE_ENABLED = 'true';
    const res = await request(app).get('/api/v1/voice-lab/nova/decision?lang=pt');
    expect(res.status).toBe(200);
    expect(res.body.decision.provider).toBe('cascaded');
    expect(res.body.decision.reason).toBe('cascaded_language_rescue');
  });

  it('lang=sr (no Polly voice, even with the cascade on) is NOT reported as cascaded — falls to forced Nova, never vertex', async () => {
    process.env.ORB_CASCADED_VOICE_ENABLED = 'true';
    const res = await request(app).get('/api/v1/voice-lab/nova/decision?lang=sr');
    expect(res.status).toBe(200);
    expect(res.body.decision.provider).not.toBe('cascaded');
    expect(res.body.decision.provider).not.toBe('vertex');
    expect(res.body.decision.provider).toBe('nova_sonic');
  });

  it('lang=pl with the cascade OFF forces Nova rather than reporting cascaded (cascade flag is genuinely load-bearing)', async () => {
    delete process.env.ORB_CASCADED_VOICE_ENABLED;
    const res = await request(app).get('/api/v1/voice-lab/nova/decision?lang=pl');
    expect(res.status).toBe(200);
    expect(res.body.decision.provider).toBe('nova_sonic');
    expect(res.body.decision.provider).not.toBe('vertex');
    expect(res.body.decision.reason).toBe('nova_forced_vertex_unavailable');
  });

  it('lang=en (Nova-native) is unaffected by the cascade flag either way', async () => {
    process.env.ORB_CASCADED_VOICE_ENABLED = 'true';
    const res = await request(app).get('/api/v1/voice-lab/nova/decision?lang=en');
    expect(res.status).toBe(200);
    expect(res.body.decision.provider).not.toBe('cascaded');
    expect(res.body.decision.provider).not.toBe('vertex');
  });

  it('provider is never vertex regardless of lang or cascade flag (VTID-03723 invariant, re-asserted at this route)', async () => {
    for (const enabled of [true, false]) {
      if (enabled) process.env.ORB_CASCADED_VOICE_ENABLED = 'true';
      else delete process.env.ORB_CASCADED_VOICE_ENABLED;
      for (const lang of ['en', 'de', 'fr', 'es', 'pl', 'pt', 'ru', 'ar', 'zh', 'sr', 'tr']) {
        const res = await request(app).get(`/api/v1/voice-lab/nova/decision?lang=${lang}`);
        expect(res.body.decision.provider).not.toBe('vertex');
      }
    }
  });
});
