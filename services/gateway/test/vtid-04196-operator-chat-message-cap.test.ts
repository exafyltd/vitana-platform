/**
 * VTID-04196: cap `message` on OperatorChatMessageSchema at the input
 * boundary, so an oversized POST /api/v1/operator/chat body is rejected
 * with a 400 BEFORE it ever reaches the LLM call.
 *
 * Before this: the schema had `z.string().min(1, ...)` with no upper
 * bound. operator-threads.ts's own `clipMessage()` truncates a message to
 * MESSAGE_MAX_CHARS only when persisting it to `operator_messages` — after
 * the full, unbounded text has already been sent to the model. That let
 * the stored copy silently diverge from what was actually said, and gave
 * an oversized payload no protection on the path that actually costs money
 * (the LLM call itself).
 *
 * This reuses operator-threads.ts's own MESSAGE_MAX_CHARS as the single
 * source of truth, rather than introducing a second, divergence-prone
 * constant for the same concept.
 */

import { OperatorChatMessageSchema } from '../src/types/operator-chat';
import { MESSAGE_MAX_CHARS } from '../src/services/operator-threads';

describe('VTID-04196 OperatorChatMessageSchema — message length cap (pure)', () => {
  it('accepts a message exactly at the cap', () => {
    const result = OperatorChatMessageSchema.safeParse({ message: 'a'.repeat(MESSAGE_MAX_CHARS) });
    expect(result.success).toBe(true);
  });

  it('rejects a message one character over the cap', () => {
    const result = OperatorChatMessageSchema.safeParse({ message: 'a'.repeat(MESSAGE_MAX_CHARS + 1) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain(String(MESSAGE_MAX_CHARS));
    }
  });

  it('still rejects an empty message (min(1) is unchanged)', () => {
    const result = OperatorChatMessageSchema.safeParse({ message: '' });
    expect(result.success).toBe(false);
  });

  it('a normal short message still passes', () => {
    const result = OperatorChatMessageSchema.safeParse({ message: 'How is staging looking?' });
    expect(result.success).toBe(true);
  });

  it('the cap is exactly operator-threads.ts\'s own MESSAGE_MAX_CHARS — no second constant introduced', () => {
    // Regression guard against exactly the divergence class this VTID's own
    // header warns about (VTID-03644's five diverged language-name copies).
    expect(MESSAGE_MAX_CHARS).toBe(6_000);
  });
});

// ==================== Route-level: rejected before any LLM call ====================

let optionalAuthImpl: (req: any, res: any, next: any) => void = (_req: any, _res: any, next: any) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: any, res: any, next: any) => optionalAuthImpl(req, res, next),
  };
});

const createChainableMock = () => {
  const chain: any = {
    from: jest.fn(() => chain), select: jest.fn(() => chain), insert: jest.fn(() => chain), update: jest.fn(() => chain),
    delete: jest.fn(() => chain), eq: jest.fn(() => chain), order: jest.fn(() => chain), limit: jest.fn(() => chain),
    single: jest.fn(() => chain), maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve)),
  };
  return chain;
};
const mockSupabase = createChainableMock();
jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSupabase) }));
jest.mock('../src/services/ai-orchestrator', () => ({ processMessage: jest.fn().mockResolvedValue({ reply: 'stub', meta: {} }) }));
jest.mock('../src/services/oasis-event-service', () => ({
  default: { deployRequested: jest.fn(), deployAccepted: jest.fn(), deployFailed: jest.fn() },
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' }),
}));
jest.mock('../src/services/deploy-orchestrator', () => ({
  __esModule: true,
  default: { executeDeploy: jest.fn(), createVtid: jest.fn(), createTask: jest.fn() },
}));
jest.mock('../src/services/gemini-operator', () => {
  const actual = jest.requireActual('../src/services/gemini-operator');
  return { ...actual, processWithGemini: jest.fn() };
});

import request from 'supertest';
import app from '../src/index';
import { processWithGemini } from '../src/services/gemini-operator';

const processWithGeminiMock = processWithGemini as unknown as jest.Mock;

describe('VTID-04196 POST /api/v1/operator/chat — oversized message rejected pre-LLM', () => {
  beforeEach(() => {
    processWithGeminiMock.mockReset();
    optionalAuthImpl = (_req: any, _res: any, next: any) => next();
  });

  it('400s an over-cap message and never calls the model', async () => {
    const res = await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'a'.repeat(MESSAGE_MAX_CHARS + 1) })
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.details).toContain(String(MESSAGE_MAX_CHARS));
    expect(processWithGeminiMock).not.toHaveBeenCalled();
  });

  it('a message exactly at the cap is accepted and reaches the model', async () => {
    processWithGeminiMock.mockResolvedValueOnce({
      reply: 'ok',
      meta: { provider: 'deepseek', model: 'deepseek-flash' },
      toolResults: [],
    });

    const res = await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'a'.repeat(MESSAGE_MAX_CHARS) })
      .expect(200);

    expect(res.body.reply).toBe('ok');
    expect(processWithGeminiMock).toHaveBeenCalledTimes(1);
  });

  it('POST /chat/stream applies the identical cap (shared schema)', async () => {
    const res = await request(app)
      .post('/api/v1/operator/chat/stream')
      .send({ message: 'a'.repeat(MESSAGE_MAX_CHARS + 1) })
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(processWithGeminiMock).not.toHaveBeenCalled();
  });
});
