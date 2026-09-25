/**
 * VTID-04542 — POST /api/v1/orb/live/client-latency (the widget's latency
 * beacon). Runs the real handler on a real express app via supertest; only
 * the OASIS writer is mocked. Also pins that the route is mounted on the
 * orb-live router next to /live/session/start with optionalAuth.
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { emitOasisEvent } from '../../../src/services/oasis-event-service';

jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
const mockEmit = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;

import { handleClientLatencyBeacon } from '../../../src/orb/live/client-latency-beacon';

function makeApp(identity?: { user_id: string }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post(
    '/api/v1/orb/live/client-latency',
    express.text({ type: 'text/plain', limit: '16kb' }),
    (req: any, _res, next) => { if (identity) req.identity = identity; next(); },
    (req: any, res) => handleClientLatencyBeacon(req, res),
  );
  return app;
}

const VALID = {
  session_id: 'live-123',
  entry: 'mobile',
  transport: 'sse',
  marks: { tap: 0, overlay_shown: 40, session_start_ok: 900, first_audio: 2400 },
  prewarm_socket_ready: false,
};

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmit.mockResolvedValue({ ok: true } as any);
});

describe('VTID-04542 client latency beacon', () => {
  it('valid body → 204 and one voice.latency.client event with body + user_id + env', async () => {
    const res = await request(makeApp({ user_id: 'user-1' }))
      .post('/api/v1/orb/live/client-latency')
      .send(VALID);
    expect(res.status).toBe(204);
    await flush();
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const ev = mockEmit.mock.calls[0][0];
    expect(ev.type).toBe('voice.latency.client');
    expect(ev.actor_id).toBe('user-1');
    expect(ev.payload).toEqual(expect.objectContaining({
      session_id: 'live-123',
      entry: 'mobile',
      transport: 'sse',
      marks: VALID.marks,
      prewarm_socket_ready: false,
      user_id: 'user-1',
    }));
    expect(['production', 'staging']).toContain((ev.payload as any).env);
  });

  it('anonymous caller → 204, user_id null', async () => {
    const res = await request(makeApp()).post('/api/v1/orb/live/client-latency').send(VALID);
    expect(res.status).toBe(204);
    await flush();
    expect((mockEmit.mock.calls[0][0].payload as any).user_id).toBeNull();
  });

  it('text/plain body (navigator.sendBeacon) is accepted', async () => {
    const res = await request(makeApp())
      .post('/api/v1/orb/live/client-latency')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(VALID));
    expect(res.status).toBe(204);
    await flush();
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing session_id', { ...VALID, session_id: undefined }],
    ['bad entry', { ...VALID, entry: 'tablet' }],
    ['bad transport', { ...VALID, transport: 'webrtc' }],
    ['negative mark', { ...VALID, marks: { tap: -1 } }],
    ['mark above 600000', { ...VALID, marks: { tap: 600001 } }],
    ['non-numeric mark', { ...VALID, marks: { tap: '12' } }],
    ['mark name over 64 chars', { ...VALID, marks: { ['m'.repeat(65)]: 1 } }],
    ['session_id over 64 chars', { ...VALID, session_id: 's'.repeat(65) }],
    ['21 marks', { ...VALID, marks: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m${i}`, i])) }],
    ['non-boolean prewarm_socket_ready', { ...VALID, prewarm_socket_ready: 'yes' }],
  ])('invalid body (%s) → 400, nothing emitted', async (_label, body) => {
    const res = await request(makeApp()).post('/api/v1/orb/live/client-latency').send(body as any);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    await flush();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('exactly 20 marks is accepted', async () => {
    const marks = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, i]));
    const res = await request(makeApp()).post('/api/v1/orb/live/client-latency').send({ ...VALID, marks });
    expect(res.status).toBe(204);
  });

  it('text/plain that is not JSON → 400', async () => {
    const res = await request(makeApp())
      .post('/api/v1/orb/live/client-latency')
      .set('Content-Type', 'text/plain')
      .send('not json');
    expect(res.status).toBe(400);
  });

  it('body over 4 KB → 413, nothing emitted', async () => {
    const res = await request(makeApp())
      .post('/api/v1/orb/live/client-latency')
      .send({ ...VALID, padding: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    await flush();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('OASIS write rejects → still 204', async () => {
    mockEmit.mockRejectedValue(new Error('supabase down'));
    const res = await request(makeApp()).post('/api/v1/orb/live/client-latency').send(VALID);
    expect(res.status).toBe(204);
    await flush();
  });

  it('OASIS writer throws synchronously → still 204', async () => {
    mockEmit.mockImplementation(() => { throw new Error('sync boom'); });
    const res = await request(makeApp()).post('/api/v1/orb/live/client-latency').send(VALID);
    expect(res.status).toBe(204);
  });

  it('is mounted on the orb-live router with optionalAuth, next to /live/session/start', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');
    const start = src.indexOf("router.post('/live/session/start', optionalAuth");
    const beacon = src.indexOf("'/live/client-latency'");
    expect(start).toBeGreaterThan(-1);
    expect(beacon).toBeGreaterThan(start);
    const block = src.slice(beacon, beacon + 400);
    expect(block).toMatch(/optionalAuth/);
    expect(block).toMatch(/handleClientLatencyBeacon\(/);
  });
});
