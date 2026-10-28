/**
 * VTID-03926 — Operator Console chat: thread the real caller identity into
 * processWithGemini() as `userRole`, so dev_* tools (dev_search_codebase,
 * dev_read_file, dev_db_query, PR/deploy tools — VTID-DEV-ASSIST,
 * VTID-03835/03836/03837) are actually reachable.
 *
 * Root cause: getRouterToolDefinitions(userRole) in gemini-operator.ts
 * hard-filters every dev_* tool unless userRole is 'developer'/'admin' —
 * but routes/operator.ts's POST /chat handler never resolved or passed a
 * userRole into processWithGemini() at all, so getRouterToolDefinitions
 * always ran with userRole === undefined and stripped every dev_* tool for
 * EVERY caller, including an authenticated exafy_admin session.
 *
 * Fix: derive userRole from the same verified `req.identity` (set by the
 * `optionalAuth` JWT middleware, VTID-03851's callerIdentity) already used
 * a few lines above to gate the thread-auth marker — not the
 * client-controlled `x-operator-role` header getOperatorRole() reads
 * elsewhere in this file, which would let an unauthenticated caller just
 * claim admin.
 */

import type { NextFunction, Request, Response } from 'express';

// Mock the JWT middleware so the admin-identity path is deterministic (no
// network, no JWKS). Each test sets `optionalAuthImpl` to simulate the
// identity outcome, matching the established pattern in
// self-healing-control-plane-auth.test.ts.
let optionalAuthImpl: (req: Request, res: Response, next: NextFunction) => void =
  (_req, _res, next) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: Request, res: Response, next: NextFunction) => optionalAuthImpl(req, res, next),
  };
});

// Create a chainable mock that supports Supabase's fluent API (mirrors
// operator-chat-oasis.test.ts's helper).
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

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));
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
    meta: { model: 'test-gemini', stub: true },
    toolResults: [],
  }),
}));

import request from 'supertest';
import app from '../src/index';
import { processWithGemini } from '../src/services/gemini-operator';

const mockedProcessWithGemini = processWithGemini as jest.Mock;

describe('VTID-03926: POST /api/v1/operator/chat threads real userRole into processWithGemini', () => {
  beforeEach(() => {
    mockedProcessWithGemini.mockClear();
    optionalAuthImpl = (_req, _res, next) => next();
  });

  it('passes userRole: undefined for an unauthenticated caller (no identity)', async () => {
    await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'search the codebase for x' })
      .expect(200);

    expect(mockedProcessWithGemini).toHaveBeenCalledTimes(1);
    const [call] = mockedProcessWithGemini.mock.calls[0];
    expect(call.userRole).toBeUndefined();
  });

  it("passes userRole: 'admin' for a verified exafy_admin identity", async () => {
    optionalAuthImpl = (req, _res, next) => {
      (req as any).identity = { user_id: 'u-admin', exafy_admin: true };
      next();
    };

    await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'search the codebase for x' })
      .expect(200);

    expect(mockedProcessWithGemini).toHaveBeenCalledTimes(1);
    const [call] = mockedProcessWithGemini.mock.calls[0];
    expect(call.userRole).toBe('admin');
  });

  it('does NOT grant admin tools for a verified but non-admin identity', async () => {
    optionalAuthImpl = (req, _res, next) => {
      (req as any).identity = { user_id: 'u-plain', exafy_admin: false };
      next();
    };

    await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'search the codebase for x' })
      .expect(200);

    const [call] = mockedProcessWithGemini.mock.calls[0];
    expect(call.userRole).toBeUndefined();
  });

  it('never trusts the client-supplied x-operator-role header for tool authorization', async () => {
    // No verified identity, but the caller claims admin via a plain header
    // — must NOT be treated as authorization for dev_* tools.
    await request(app)
      .post('/api/v1/operator/chat')
      .set('x-operator-role', 'admin')
      .send({ message: 'search the codebase for x' })
      .expect(200);

    const [call] = mockedProcessWithGemini.mock.calls[0];
    expect(call.userRole).toBeUndefined();
  });
});
