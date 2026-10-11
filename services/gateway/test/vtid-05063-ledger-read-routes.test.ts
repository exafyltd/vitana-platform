/**
 * VTID-05063 — supertest integration for the ledger READ gate on the real
 * routers (oasis-tasks, oasis-vtid-ledger, vtid, tasks, board-adapter,
 * approvals), mounted the way index.ts mounts them.
 *
 * In `enforce` every Tier 1 GET answers 401 to an anonymous caller without
 * touching Supabase, and passes the gate with the service token; health,
 * the approvals PR feed and OPTIONS preflights stay open; the board route's
 * CORS headers survive a 401; and in the `log` default the request passes
 * with one would-reject line carrying the route template.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../src/services/github-service', () => ({
  listOpenPrsWithStatus: jest.fn(async () => []),
}));

import { oasisTasksRouter } from '../src/routes/oasis-tasks';
import { oasisVtidLedgerRouter } from '../src/routes/oasis-vtid-ledger';
import { vtidRouter } from '../src/routes/vtid';
import { router as tasksRouter } from '../src/routes/tasks';
import boardAdapter from '../src/routes/board-adapter';
import approvalsRouter from '../src/routes/approvals';
import { __resetLedgerReadAuthLogState } from '../src/middleware/ledger-read-auth';

/** Production mount order (index.ts): vtid router before the tasks router at `/`. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/vtid', vtidRouter);
  app.use('/api/v1/approvals', approvalsRouter);
  app.use('/api/v1/commandhub/board', boardAdapter);
  app.use('/api/v1/board', boardAdapter);
  app.use('/', tasksRouter);
  app.use('/', oasisTasksRouter);
  app.use('/', oasisVtidLedgerRouter);
  return app;
}
const app = buildApp();

const TIER1_GETS = [
  '/api/v1/oasis/tasks?limit=1',
  '/api/v1/oasis/tasks/discover',
  '/api/v1/oasis/tasks/VTID-00000',
  '/api/v1/oasis/vtid-ledger?limit=1',
  '/api/v1/vtid/list?limit=1',
  '/api/v1/vtid/projection?limit=1',
  '/api/v1/vtid/VTID-00000',
  '/api/v1/vtid/allocator/status',
  '/api/v1/tasks?limit=1',
  '/api/v1/vtid/VTID-00000/execution-status',
  '/api/v1/commandhub/board?limit=1',
  '/api/v1/board?limit=1',
  '/api/v1/approvals/pending?limit=1',
  '/api/v1/approvals/count',
];

const fetchMock = () => global.fetch as unknown as jest.Mock;

describe('VTID-05063 ledger read gate on the real routers', () => {
  const ENV = { ...process.env };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';
    delete process.env.LEDGER_READ_AUTH_MODE;
    __resetLedgerReadAuthLogState();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...ENV };
    warn.mockRestore();
    error.mockRestore();
  });

  describe('enforce', () => {
    beforeEach(() => { process.env.LEDGER_READ_AUTH_MODE = 'enforce'; });

    it.each(TIER1_GETS)('anonymous GET %s → 401 without reaching Supabase', async (url) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: 'missing bearer token' });
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it.each(TIER1_GETS)('bad bearer on GET %s → 401', async (url) => {
      const res = await request(app).get(url).set('Authorization', 'Basic not-a-bearer');
      expect(res.status).toBe(401);
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it.each(TIER1_GETS)('service token on GET %s passes the gate', async (url) => {
      const res = await request(app).get(url).set('Authorization', 'Bearer svc-token');
      expect([401, 403]).not.toContain(res.status);
    });

    it('HEAD follows GET and is gated', async () => {
      const res = await request(app).head('/api/v1/tasks?limit=1');
      expect(res.status).toBe(401);
    });

    it('the shadowed tasks-router copy of GET /api/v1/vtid/:vtid is gated too', async () => {
      const only = express();
      only.use('/', tasksRouter);
      const res = await request(only).get('/api/v1/vtid/VTID-00000');
      expect(res.status).toBe(401);
    });

    it('/api/v1/vtid/list is not captured by /:vtid (vtid router mounted before the tasks router)', async () => {
      await request(app).get('/api/v1/vtid/list?limit=1').set('Authorization', 'Bearer svc-token');
      const urls = fetchMock().mock.calls.map((c) => String(typeof c[0] === 'string' ? c[0] : c[0]?.url));
      expect(urls.some((u) => u.includes('vtid=eq.list'))).toBe(false);
    });

    it('GET /api/v1/vtid/health stays open to anonymous callers', async () => {
      const res = await request(app).get('/api/v1/vtid/health');
      expect([401, 403]).not.toContain(res.status);
    });

    it('GET /api/v1/approvals/feed (GitHub PR feed, Tier 2) stays open', async () => {
      const res = await request(app).get('/api/v1/approvals/feed?limit=1');
      expect([401, 403]).not.toContain(res.status);
    });

    it('OPTIONS preflights stay open', async () => {
      expect((await request(app).options('/api/v1/oasis/vtid-ledger')).status).toBe(200);
      const board = await request(app)
        .options('/api/v1/commandhub/board')
        .set('Origin', 'http://localhost:5173')
        .set('Access-Control-Request-Method', 'GET');
      expect([401, 403]).not.toContain(board.status);
    });

    it('a 401 from the board to an allowlisted origin still carries the CORS headers (cors runs first)', async () => {
      const res = await request(app).get('/api/v1/commandhub/board?limit=1').set('Origin', 'http://localhost:5173');
      expect(res.status).toBe(401);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });
  });

  describe('log (the default)', () => {
    it('anonymous reads still pass and log the route template once, without the query string', async () => {
      const res = await request(app).get('/api/v1/vtid/list?limit=1&tenant=secret-tenant');
      expect([401, 403]).not.toContain(res.status);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ledger read would be rejected'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('GET /api/v1/vtid/list ');
      expect(lines[0]).not.toContain('secret-tenant');
    });
  });
});
