/**
 * VTID-02919 (B0d.4-event-ingest) — POST /api/v1/voice/wake-timeline/event tests.
 *
 * Pure request handler tests via supertest against an Express app
 * mounting just the wake-timeline router. No DB; the default
 * recorder operates in DB-less mode so events land in its in-memory
 * map and we can assert from there.
 */

import express from 'express';
import request from 'supertest';

// Bypass auth middleware for the route tests — we just want to verify
// the handler logic. The route file imports `optionalAuth` lazily so
// we mock the module at top-level before the router is required.
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  requireAuthWithTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
}));

import { defaultWakeTimelineRecorder } from '../../src/services/wake-timeline/wake-timeline-recorder';

function buildApp() {
  // Require fresh after mocks are in place.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-wake-timeline').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('B0d.4-event-ingest — POST /api/v1/voice/wake-timeline/event', () => {
  beforeEach(() => {
    defaultWakeTimelineRecorder.reset();
  });

  it('records a known event for a valid request', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({
        sessionId: 'live-ingest-1',
        name: 'wake_clicked',
        metadata: { wakeOrigin: 'orb_tap' },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      recorded: true,
      vtid: 'VTID-02919',
    });
    const row = await defaultWakeTimelineRecorder.getTimeline('live-ingest-1');
    expect(row?.events).toHaveLength(1);
    expect(row?.events[0].name).toBe('wake_clicked');
    expect(row?.events[0].metadata).toEqual({ wakeOrigin: 'orb_tap' });
  });

  it('rejects missing sessionId', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ name: 'wake_clicked' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId is required/);
  });

  it('rejects whitespace-only sessionId', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: '   ', name: 'wake_clicked' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId is required/);
  });

  it('rejects unknown event name with a specific reason', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: 'live-1', name: 'made_up_event' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown wake-timeline event name: made_up_event/);
  });

  it('rejects missing event name', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: 'live-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown wake-timeline event name/);
  });

  it('accepts an explicit at timestamp', async () => {
    const app = buildApp();
    const atIso = '2026-05-11T16:00:00.000Z';
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({
        sessionId: 'live-ingest-at',
        name: 'first_audio_output',
        at: atIso,
      });
    expect(res.status).toBe(200);
    const row = await defaultWakeTimelineRecorder.getTimeline('live-ingest-at');
    expect(row?.events[0].at).toBe(atIso);
  });

  it('drops non-object metadata silently (does not record garbage)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({
        sessionId: 'live-bad-md',
        name: 'ws_opened',
        metadata: 'not-an-object',
      });
    expect(res.status).toBe(200);
    const row = await defaultWakeTimelineRecorder.getTimeline('live-bad-md');
    expect(row?.events[0].metadata).toBeUndefined();
  });

  it('drops array metadata (not a real key/value bag)', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({
        sessionId: 'live-array-md',
        name: 'ws_opened',
        metadata: ['a', 'b'],
      });
    const row = await defaultWakeTimelineRecorder.getTimeline('live-array-md');
    expect(row?.events[0].metadata).toBeUndefined();
  });

  it('accepts every locked event name (16 in total)', async () => {
    const app = buildApp();
    const names = [
      'wake_clicked',
      'client_context_received',
      'ws_opened',
      'session_start_received',
      'session_context_built',
      'continuation_decision_started',
      'continuation_decision_finished',
      'wake_brief_selected',
      'upstream_live_connect_started',
      'upstream_live_connected',
      'first_model_output',
      'first_audio_output',
      'disconnect',
      'reconnect_attempt',
      'reconnect_success',
      'manual_restart_required',
    ];
    for (const name of names) {
      const res = await request(app)
        .post('/api/v1/voice/wake-timeline/event')
        .send({ sessionId: `live-${name}`, name });
      expect(res.status).toBe(200);
      expect(res.body.recorded).toBe(true);
    }
  });

  it('returns 200 ok:true recorded:false when the recorder throws', async () => {
    // Patch the recorder to throw, restore after.
    const original = defaultWakeTimelineRecorder.recordEvent;
    defaultWakeTimelineRecorder.recordEvent = (() => {
      throw new Error('synthetic-failure');
    }) as any;
    try {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/voice/wake-timeline/event')
        .send({ sessionId: 'live-explode', name: 'wake_clicked' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        recorded: false,
        reason: 'synthetic-failure',
        vtid: 'VTID-02919',
      });
    } finally {
      defaultWakeTimelineRecorder.recordEvent = original;
    }
  });
});
