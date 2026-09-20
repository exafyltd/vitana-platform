/**
 * VTID-04209 — the Operator Console shows a small badge distinguishing a
 * reply produced under a verified exafy_admin session from one produced
 * anonymously.
 *
 * Two halves, both pinned:
 *   1. Backend — POST /chat's reply meta carries `authenticated: boolean`,
 *      derived from the SAME already-verified callerIdentity/geminiUserRole
 *      this route resolves from the real JWT (optionalAuth), mirroring
 *      VTID-03926's own coverage pattern for that identity resolution.
 *   2. Frontend — app.js renders the badge from `msg.meta.authenticated`,
 *      distinct from the VTID-04031 cost badge, with its own CSS.
 */

import type { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

let optionalAuthImpl: (req: Request, res: Response, next: NextFunction) => void =
  (_req, _res, next) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: Request, res: Response, next: NextFunction) => optionalAuthImpl(req, res, next),
  };
});

const createChainableMock = () => {
  const chain: any = {
    from: jest.fn(() => chain),
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve)),
  };
  return chain;
};
const mockSupabase = createChainableMock();

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSupabase) }));
jest.mock('../src/services/ai-orchestrator', () => ({
  processMessage: jest.fn().mockResolvedValue({ reply: 'stub', meta: {} }),
}));
jest.mock('../src/services/github-service', () => ({
  default: {
    triggerWorkflow: jest.fn().mockResolvedValue(undefined),
    getWorkflowRuns: jest.fn().mockResolvedValue({ workflow_runs: [] }),
  },
}));
jest.mock('../src/services/oasis-event-service', () => ({
  default: {
    deployRequested: jest.fn().mockResolvedValue(undefined),
    deployAccepted: jest.fn().mockResolvedValue(undefined),
    deployFailed: jest.fn().mockResolvedValue(undefined),
  },
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' }),
}));
jest.mock('../src/services/deploy-orchestrator', () => ({
  __esModule: true,
  default: { executeDeploy: jest.fn(), createVtid: jest.fn(), createTask: jest.fn() },
}));
jest.mock('../src/services/gemini-operator', () => ({
  processWithGemini: jest.fn().mockResolvedValue({
    reply: 'mocked gemini response',
    meta: { provider: 'deepseek', model: 'deepseek-flash' },
    toolResults: [],
  }),
}));

import request from 'supertest';
import app from '../src/index';
import { processWithGemini } from '../src/services/gemini-operator';

const mockedProcessWithGemini = processWithGemini as jest.Mock;

describe('VTID-04209 backend — reply meta.authenticated', () => {
  beforeEach(() => {
    mockedProcessWithGemini.mockClear();
    optionalAuthImpl = (_req, _res, next) => next();
  });

  it('is true for a verified exafy_admin identity', async () => {
    optionalAuthImpl = (req, _res, next) => {
      (req as any).identity = { user_id: 'u-admin', exafy_admin: true };
      next();
    };
    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'status?' }).expect(200);
    expect(res.body.meta.authenticated).toBe(true);
  });

  it('is false for an unauthenticated (anonymous) caller', async () => {
    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'status?' }).expect(200);
    expect(res.body.meta.authenticated).toBe(false);
  });

  it('is false for a verified but non-admin identity', async () => {
    optionalAuthImpl = (req, _res, next) => {
      (req as any).identity = { user_id: 'u-plain', exafy_admin: false };
      next();
    };
    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'status?' }).expect(200);
    expect(res.body.meta.authenticated).toBe(false);
  });

  it('never trusts the client-supplied x-operator-role header', async () => {
    const res = await request(app)
      .post('/api/v1/operator/chat')
      .set('x-operator-role', 'admin')
      .send({ message: 'status?' })
      .expect(200);
    expect(res.body.meta.authenticated).toBe(false);
  });

  it('preserves every other field processWithGemini already returned on meta', async () => {
    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'status?' }).expect(200);
    expect(res.body.meta.provider).toBe('deepseek');
    expect(res.body.meta.model).toBe('deepseek-flash');
  });
});

describe('VTID-04209 frontend — auth-state badge', () => {
  const FE = path.resolve(__dirname, '../src/frontend/command-hub');
  const APP_JS = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(FE, 'styles.css'), 'utf8');
  const INDEX_HTML = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');

  function fnBody(name: string): string {
    const start = APP_JS.indexOf(`\nfunction ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = APP_JS.indexOf('\nfunction ', start + 1);
    return APP_JS.slice(start, next === -1 ? undefined : next);
  }

  it('renders "admin"/"anon" from msg.meta.authenticated, distinct from the cost badge', () => {
    const body = fnBody('renderOperatorChat');
    expect(body).toContain("if (!isSent && msg.meta && typeof msg.meta.authenticated === 'boolean') {");
    expect(body).toContain("authBadge.textContent = msg.meta.authenticated ? 'admin' : 'anon';");
    expect(body).toContain("message-auth-badge--admin");
    expect(body).toContain("message-auth-badge--anon");
  });

  it('does not gate on msg.meta.provider — a turn with no tool/provider still gets the badge', () => {
    const body = fnBody('renderOperatorChat');
    const authBlockStart = body.indexOf("typeof msg.meta.authenticated === 'boolean'");
    const costBlockStart = body.indexOf('msg.meta.provider');
    expect(authBlockStart).toBeGreaterThan(-1);
    expect(costBlockStart).toBeGreaterThan(authBlockStart);
  });

  it('ships the CSS for both badge states', () => {
    expect(CSS).toContain('.message-auth-badge {');
    expect(CSS).toContain('.message-auth-badge--admin {');
    expect(CSS).toContain('.message-auth-badge--anon {');
  });

  it('bumps the shared cache-bust version for app.js and styles.css together', () => {
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260920-vtid-04209-auth-state-badge').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
  });
});

describe('VTID-04209 command-hub-ownership-guard allowlist', () => {
  const {
    evaluateMarkerAuthorization,
  } = require('../../../scripts/ci/command-hub-ownership-guard.js');

  it('authorizes this VTID by branch name', () => {
    expect(evaluateMarkerAuthorization('claude/vtid-04209-auth-state-badge', '')).toEqual({
      allowed: true,
      reason: 'allowlisted-marker',
    });
  });

  it('authorizes this VTID by PR title', () => {
    expect(
      evaluateMarkerAuthorization('some-other-branch', 'Operator: badge distinguishing authenticated vs anon turns (VTID-04209)')
    ).toEqual({ allowed: true, reason: 'allowlisted-marker' });
  });
});
