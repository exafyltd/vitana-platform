/**
 * VTID-05069: route-level tests for /api/v1/operator/runs (routes/operator-runs.ts):
 * auth, validation, happy paths and error mapping. The view builder is mocked here;
 * its behaviour is covered by test/operator-runs-view.test.ts.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => {
    const user = req.header('x-test-user');
    if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: user, exafy_admin: true };
    return next();
  },
}));

const svc = {
  buildRunView: jest.fn(),
  buildThreadRuns: jest.fn(),
  followRunView: jest.fn(),
};
jest.mock('../src/services/operator-runs/run-view', () => ({
  ...jest.requireActual('../src/services/operator-runs/run-view'),
  buildRunView: (...a: unknown[]) => svc.buildRunView(...a),
  buildThreadRuns: (...a: unknown[]) => svc.buildThreadRuns(...a),
  followRunView: (...a: unknown[]) => svc.followRunView(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/operator-runs').default;

const OWNER = 'd1111111-1111-4111-8111-111111111111';
const THREAD = 'a5069000-0000-4000-8000-000000000001';
const VTID = 'VTID-05069';

function app() {
  const a = express();
  a.use('/api/v1/operator/runs', router);
  return a;
}

beforeEach(() => Object.values(svc).forEach((f) => f.mockReset()));

describe('auth', () => {
  it.each([`/by-thread/${THREAD}`, `/${VTID}`, `/${VTID}/stream`])('GET %s without a caller answers 401 JSON', async (path) => {
    const res = await request(app()).get(`/api/v1/operator/runs${path}`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(svc.buildRunView).not.toHaveBeenCalled();
    expect(svc.buildThreadRuns).not.toHaveBeenCalled();
    expect(svc.followRunView).not.toHaveBeenCalled();
  });
});

describe('GET /by-thread/:threadId', () => {
  it('returns the thread runs for the caller', async () => {
    svc.buildThreadRuns.mockResolvedValue({ ok: true, vtids: [VTID], views: [{ vtid: VTID }] });
    const res = await request(app()).get(`/api/v1/operator/runs/by-thread/${THREAD}`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body.vtids).toEqual([VTID]);
    expect(svc.buildThreadRuns).toHaveBeenCalledWith(THREAD, OWNER);
  });
  it('maps errors: forbidden → 403, invalid_thread → 400, other → 503', async () => {
    for (const [error, code] of [['forbidden', 403], ['invalid_thread', 400], ['store_unavailable', 503]] as const) {
      svc.buildThreadRuns.mockResolvedValueOnce({ ok: false, error });
      const res = await request(app()).get(`/api/v1/operator/runs/by-thread/${THREAD}`).set('x-test-user', OWNER);
      expect(res.status).toBe(code);
      expect(res.body.error).toBe(error);
    }
  });
  it('a malformed thread id → 400 without a lookup', async () => {
    const res = await request(app()).get('/api/v1/operator/runs/by-thread/bad%20id!').set('x-test-user', OWNER);
    expect(res.status).toBe(400);
    expect(svc.buildThreadRuns).not.toHaveBeenCalled();
  });
});

describe('GET /:vtid', () => {
  it('returns the view, passing the optional thread id', async () => {
    svc.buildRunView.mockResolvedValue({ ok: true, view: { vtid: VTID, nodes: [] } });
    const res = await request(app()).get(`/api/v1/operator/runs/${VTID}?thread_id=${THREAD}`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, view: { vtid: VTID, nodes: [] } });
    expect(svc.buildRunView).toHaveBeenCalledWith(VTID, { threadId: THREAD });
  });
  it('a bad VTID or thread id → 400; a builder refusal → 400', async () => {
    expect((await request(app()).get('/api/v1/operator/runs/not-a-vtid').set('x-test-user', OWNER)).status).toBe(400);
    expect((await request(app()).get(`/api/v1/operator/runs/${VTID}?thread_id=bad%20id!`).set('x-test-user', OWNER)).status).toBe(400);
    expect(svc.buildRunView).not.toHaveBeenCalled();
    svc.buildRunView.mockResolvedValueOnce({ ok: false, error: 'invalid_vtid' });
    expect((await request(app()).get(`/api/v1/operator/runs/${VTID}`).set('x-test-user', OWNER)).status).toBe(400);
  });
});

describe('GET /:vtid/stream', () => {
  it('sends view frames and an end frame as SSE', async () => {
    svc.followRunView.mockImplementation(async (_v: string, _t: string | null, send: (v: any) => void) => {
      send({ vtid: VTID, terminal: false });
      send({ vtid: VTID, terminal: true });
      return 'terminal';
    });
    const res = await request(app()).get(`/api/v1/operator/runs/${VTID}/stream`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain(`event: view\ndata: {"vtid":"${VTID}","terminal":false}`);
    expect(res.text).toContain('event: end\ndata: {"reason":"terminal"}');
    expect(svc.followRunView).toHaveBeenCalledWith(VTID, null, expect.any(Function), expect.any(Function));
  });
  it('a builder error becomes an error frame; a bad VTID → 400 JSON', async () => {
    svc.followRunView.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app()).get(`/api/v1/operator/runs/${VTID}/stream`).set('x-test-user', OWNER);
    expect(res.text).toContain('event: error\ndata: {"ok":false,"error":"stream_failed","details":"boom"}');
    const bad = await request(app()).get('/api/v1/operator/runs/nope/stream').set('x-test-user', OWNER);
    expect(bad.status).toBe(400);
    expect(bad.headers['content-type']).toMatch(/application\/json/);
  });
});
