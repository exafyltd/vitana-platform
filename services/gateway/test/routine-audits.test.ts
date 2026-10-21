/**
 * routes/routine-audits.ts — X-Routine-Token audit endpoints for the
 * claude.ai routines.
 *
 * VTID-05098 (Loop Engineering Phase 2): /routines/audits/push-pipeline and
 * /routines/audits/migration-backlog were removed with their routines
 * (push-pipeline-probe, migration-backlog). The remaining endpoints keep their
 * token gate.
 */
import express from 'express';
import request from 'supertest';

const TOKEN = 'test-routine-token';

function buildApp() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { routineAuditsRouter } = require('../src/routes/routine-audits');
  const app = express();
  app.use('/', routineAuditsRouter);
  return app;
}

const REMAINING = [
  '/api/v1/routines/audits/oasis-summary',
  '/api/v1/routines/audits/io-pressure',
  '/api/v1/routines/audits/autopilot-recs',
  '/api/v1/routines/audits/vitana-index',
  '/api/v1/routines/audits/knowledge-docs-staleness',
  '/api/v1/routines/audits/dyk-tour-progress',
  '/api/v1/routines/audits/spec-memory-quarantine',
  '/api/v1/routines/audits/mobile-screen-latency',
];

describe('routine audit endpoints', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.ROUTINE_INGEST_TOKEN = TOKEN;
  });
  afterAll(() => {
    process.env = env;
  });

  it.each([
    '/api/v1/routines/audits/push-pipeline',
    '/api/v1/routines/audits/migration-backlog',
  ])('VTID-05098: %s is gone (404), even with a valid token', async (p) => {
    const res = await request(buildApp()).get(p).set('X-Routine-Token', TOKEN);
    expect(res.status).toBe(404);
  });

  it.each(REMAINING)('%s still requires the routine token (401 without it)', async (p) => {
    const res = await request(buildApp()).get(p);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'Invalid or missing X-Routine-Token header' });
  });

  it('answers 503 when the gateway has no ROUTINE_INGEST_TOKEN configured', async () => {
    delete process.env.ROUTINE_INGEST_TOKEN;
    const res = await request(buildApp()).get(REMAINING[0]).set('X-Routine-Token', TOKEN);
    expect(res.status).toBe(503);
  });
});
