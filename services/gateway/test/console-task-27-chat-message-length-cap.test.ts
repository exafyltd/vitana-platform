/**
 * VTID-04191 (console task 27) — the `message` field of
 * `OperatorChatMessageSchema`, the Zod schema behind
 * `POST /api/v1/operator/chat` (and its SSE twin `/chat/stream`), had only a
 * `min(1)` constraint and no upper bound: a multi-megabyte body was accepted,
 * persisted as an OASIS chat event, and forwarded to the model. The schema now
 * caps the field at OPERATOR_CHAT_MESSAGE_MAX_LENGTH (20,000 characters), so an
 * oversized turn is refused by the route's pre-existing 400 validation response
 * — same body shape as every other validation failure — before any processing.
 */

import request from 'supertest';

// Mock the JWT middleware so identity resolution is deterministic (no JWKS,
// no network) — same pattern as vtid-03926-operator-chat-userrole.test.ts.
let optionalAuthImpl: (req: any, res: any, next: any) => void = (_req, _res, next) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: any, res: any, next: any) => optionalAuthImpl(req, res, next),
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
  default: { deployRequested: jest.fn(), deployAccepted: jest.fn(), deployFailed: jest.fn() },
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

import app from '../src/index';
import { processWithGemini } from '../src/services/gemini-operator';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import { OPERATOR_CHAT_MESSAGE_MAX_LENGTH } from '../src/types/operator-chat';

const mockedProcessWithGemini = processWithGemini as jest.Mock;
const mockedEmitOasisEvent = emitOasisEvent as jest.Mock;

describe('VTID-04191: POST /api/v1/operator/chat message length cap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedProcessWithGemini.mockResolvedValue({
      reply: 'mocked gemini response',
      meta: { model: 'test-gemini', stub: true },
      toolResults: [],
    });
    optionalAuthImpl = (_req, _res, next) => next();
  });

  it('pins the cap at 20,000 characters', () => {
    expect(OPERATOR_CHAT_MESSAGE_MAX_LENGTH).toBe(20_000);
  });

  // AC-1: over the cap → the route's normal 400 validation-error shape,
  // naming the length problem, and no processing at all.
  it('refuses a message over the cap with the standard validation-error shape naming the length problem', async () => {
    const response = await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'a'.repeat(OPERATOR_CHAT_MESSAGE_MAX_LENGTH + 1) })
      .expect(400);

    expect(response.body).toEqual({
      ok: false,
      error: 'Validation failed',
      details: expect.stringContaining('message: Message must be at most 20000 characters'),
    });
    expect(response.body.details).toContain('characters');

    // Refused BEFORE any processing: no model call, no OASIS chat event.
    expect(mockedProcessWithGemini).not.toHaveBeenCalled();
    expect(mockedEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('refuses an oversized message on the SSE twin /chat/stream with a plain 400 JSON body', async () => {
    const response = await request(app)
      .post('/api/v1/operator/chat/stream')
      .send({ message: 'a'.repeat(OPERATOR_CHAT_MESSAGE_MAX_LENGTH + 1) })
      .expect(400);

    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBe('Validation failed');
    expect(response.body.details).toContain('message: Message must be at most 20000 characters');
    expect(mockedProcessWithGemini).not.toHaveBeenCalled();
  });

  // AC-2: at (and under) the cap → completely unaffected.
  it('accepts a message exactly at the cap', async () => {
    const response = await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'a'.repeat(OPERATOR_CHAT_MESSAGE_MAX_LENGTH) })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.reply).toBeDefined();
    expect(mockedProcessWithGemini).toHaveBeenCalledTimes(1);
    expect(mockedProcessWithGemini.mock.calls[0][0].text).toHaveLength(OPERATOR_CHAT_MESSAGE_MAX_LENGTH);
  });

  it('accepts a short message unaffected by the cap', async () => {
    const response = await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'Hello, assistant!' })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(mockedProcessWithGemini).toHaveBeenCalledTimes(1);
  });
});
