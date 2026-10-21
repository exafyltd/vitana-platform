/**
 * VTID-05065: route-level tests for /api/v1/operator/kiro/runs (routes/operator-kiro-runs.ts):
 * auth, owner checks, validation, happy paths and error mapping. The run service is
 * mocked here; its behaviour end to end is covered by the "Kiro runs (VTID-05065)"
 * scenarios in test/vtid-04465-operator-pipeline-regression.test.ts.
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
  startKiroRun: jest.fn(),
  getKiroRun: jest.fn(),
  listKiroRuns: jest.fn(),
  cancelKiroRun: jest.fn(),
  followKiroRun: jest.fn(),
  kiroThreadOwnership: jest.fn(),
};
jest.mock('../src/services/kiro/kiro-runs', () => svc);
jest.mock('../src/services/operator-threads', () => ({ ensureOperatorThread: jest.fn(async () => true), isOperatorThreadsEnabled: () => true }));
jest.mock('../src/services/operator-service', () => ({ ingestChatMessageEvent: jest.fn(async () => ({ ok: true })) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/operator-kiro-runs').default;

const OWNER = 'd1111111-1111-4111-8111-111111111111';
const OTHER = 'e2222222-2222-4222-8222-222222222222';
const THREAD = 'a5065000-0000-4000-8000-000000000001';
const RUN = 'b5065000-0000-4000-8000-000000000002';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/operator/kiro/runs', router);
  return a;
}

beforeEach(() => {
  Object.values(svc).forEach((f) => f.mockReset());
  svc.kiroThreadOwnership.mockResolvedValue({ owner: OWNER, engine: 'kiro', otherRunOwners: [] });
  svc.getKiroRun.mockResolvedValue({ id: RUN, user_id: OWNER, thread_id: THREAD, status: 'running' });
});

describe('auth', () => {
  it.each([
    ['post', '/'], ['get', `/?thread_id=${THREAD}`], ['get', `/${RUN}`], ['get', `/${RUN}/stream`], ['post', `/${RUN}/cancel`],
  ])('%s %s without a caller answers 401 JSON', async (method, path) => {
    const res = await (request(app()) as any)[method](`/api/v1/operator/kiro/runs${path}`).send({});
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('POST / (start or queue)', () => {
  it('starts a run for the owner: 202 with run id and status', async () => {
    svc.startKiroRun.mockResolvedValue({ ok: true, run_id: RUN, status: 'running' });
    const res = await request(app()).post('/api/v1/operator/kiro/runs').set('x-test-user', OWNER).send({ thread_id: THREAD, message: 'hi' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, run_id: RUN, status: 'running' });
    expect(svc.startKiroRun).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD, userId: OWNER, message: 'hi', requirePersisted: true }));
  });
  it('another user\'s thread → 403, nothing started', async () => {
    const res = await request(app()).post('/api/v1/operator/kiro/runs').set('x-test-user', OTHER).send({ thread_id: THREAD, message: 'hi' });
    expect(res.status).toBe(403);
    expect(svc.startKiroRun).not.toHaveBeenCalled();
  });
  it('an LLM thread → 409 thread_not_kiro', async () => {
    svc.kiroThreadOwnership.mockResolvedValue({ owner: OWNER, engine: 'llm', otherRunOwners: [] });
    const res = await request(app()).post('/api/v1/operator/kiro/runs').set('x-test-user', OWNER).send({ thread_id: THREAD, message: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('thread_not_kiro');
  });
  it('invalid body → 400; queue full → 409; store down → 503', async () => {
    const bad = await request(app()).post('/api/v1/operator/kiro/runs').set('x-test-user', OWNER).send({ thread_id: 'nope', message: '' });
    expect(bad.status).toBe(400);
    svc.startKiroRun.mockResolvedValueOnce({ ok: false, error: 'queue_full' });
    const full = await request(app()).post('/api/v1/operator/kiro/runs').set('x-test-user', OWNER).send({ thread_id: THREAD, message: 'hi' });
    expect(full.status).toBe(409);
    svc.startKiroRun.mockResolvedValueOnce({ ok: false, error: 'store_unavailable' });
    const down = await request(app()).post('/api/v1/operator/kiro/runs').set('x-test-user', OWNER).send({ thread_id: THREAD, message: 'hi' });
    expect(down.status).toBe(503);
  });
});

describe('GET / and GET /:id', () => {
  it('lists the caller\'s runs of a thread', async () => {
    svc.listKiroRuns.mockResolvedValue([{ id: RUN }]);
    const res = await request(app()).get(`/api/v1/operator/kiro/runs?thread_id=${THREAD}`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([{ id: RUN }]);
    expect(svc.listKiroRuns).toHaveBeenCalledWith(THREAD, OWNER);
  });
  it('invalid thread id → 400; store down → 503', async () => {
    expect((await request(app()).get('/api/v1/operator/kiro/runs?thread_id=x').set('x-test-user', OWNER)).status).toBe(400);
    svc.listKiroRuns.mockResolvedValue(null);
    expect((await request(app()).get(`/api/v1/operator/kiro/runs?thread_id=${THREAD}`).set('x-test-user', OWNER)).status).toBe(503);
  });
  it('the owner reads the run; another user gets 403; unknown → 404; bad id → 400', async () => {
    expect((await request(app()).get(`/api/v1/operator/kiro/runs/${RUN}`).set('x-test-user', OWNER)).body.run.id).toBe(RUN);
    expect((await request(app()).get(`/api/v1/operator/kiro/runs/${RUN}`).set('x-test-user', OTHER)).status).toBe(403);
    svc.getKiroRun.mockResolvedValueOnce(null);
    expect((await request(app()).get(`/api/v1/operator/kiro/runs/${RUN}`).set('x-test-user', OWNER)).status).toBe(404);
    expect((await request(app()).get('/api/v1/operator/kiro/runs/x').set('x-test-user', OWNER)).status).toBe(400);
  });
});

describe('GET /:id/stream', () => {
  it('replays from after_seq as SSE frames with ids', async () => {
    svc.followKiroRun.mockImplementation(async (_id: string, after: number, write: (e: any) => void) => {
      expect(after).toBe(3);
      write({ seq: 4, type: 'kiro.message_chunk', payload: { text: 'hi' } });
      write({ seq: 5, type: 'kiro.run_status', payload: { status: 'completed' } });
    });
    const res = await request(app()).get(`/api/v1/operator/kiro/runs/${RUN}/stream?after_seq=3`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('id: 4\nevent: kiro.message_chunk\ndata: {"seq":4,"text":"hi"}');
    expect(res.text).toContain('id: 5\nevent: kiro.run_status');
  });
  it('Last-Event-ID works like after_seq; a bad seq → 400; another user → 403', async () => {
    svc.followKiroRun.mockResolvedValue(undefined);
    await request(app()).get(`/api/v1/operator/kiro/runs/${RUN}/stream`).set('x-test-user', OWNER).set('Last-Event-ID', '7');
    expect(svc.followKiroRun).toHaveBeenCalledWith(RUN, 7, expect.any(Function), expect.any(Function));
    expect((await request(app()).get(`/api/v1/operator/kiro/runs/${RUN}/stream?after_seq=-1`).set('x-test-user', OWNER)).status).toBe(400);
    expect((await request(app()).get(`/api/v1/operator/kiro/runs/${RUN}/stream`).set('x-test-user', OTHER)).status).toBe(403);
  });
});

describe('POST /:id/cancel', () => {
  it('maps the service result to status codes', async () => {
    svc.cancelKiroRun.mockResolvedValueOnce({ ok: true, status: 'cancelled' });
    const ok = await request(app()).post(`/api/v1/operator/kiro/runs/${RUN}/cancel`).set('x-test-user', OWNER);
    expect(ok.body).toEqual({ ok: true, status: 'cancelled' });
    expect(svc.cancelKiroRun).toHaveBeenCalledWith(RUN, OWNER);
    for (const [error, code] of [['forbidden', 403], ['not_found', 404], ['already_finished', 409]] as const) {
      svc.cancelKiroRun.mockResolvedValueOnce({ ok: false, error });
      expect((await request(app()).post(`/api/v1/operator/kiro/runs/${RUN}/cancel`).set('x-test-user', OWNER)).status).toBe(code);
    }
    expect((await request(app()).post('/api/v1/operator/kiro/runs/x/cancel').set('x-test-user', OWNER)).status).toBe(400);
  });
});
