/**
 * VTID-03470 — POST /send / POST /vitana-reply split.
 *
 * Contract under test:
 *   - POST /send NEVER triggers Vitana reply generation, for any receiver
 *     (bot or human) — it only ever inserts the message. This used to be a
 *     fire-and-forget side effect that Cloud Run's CPU throttling could
 *     silently kill before it finished writing the reply.
 *   - POST /send to a human still fires the existing push notification path
 *     unchanged (regression guard — this is the "don't damage anything
 *     else" check for the /send edit).
 *   - POST /vitana-reply generates + awaits + writes the bot's reply within
 *     its own request lifetime, returning the reply text.
 *   - POST /vitana-reply is guarded against concurrent duplicate calls for
 *     the same user (409 while one is in flight), mirroring the old /send
 *     guard from VTID-03459.
 */

import request from 'supertest';
import express from 'express';

const VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001';

// ── Chainable Supabase mock (same shape used elsewhere in this suite) ────
function createChainableMock() {
  let defaultData: any = { data: null, error: null };
  const responseQueue: any[] = [];
  const chain: any = {
    from: jest.fn(() => chain),
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    lt: jest.fn(() => chain),
    is: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: any, reject: any) => {
      const data = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      return Promise.resolve(data).then(resolve, reject);
    }),
    mockResolvedValueOnce: (data: any) => {
      responseQueue.push(data);
      return chain;
    },
    setDefault: (data: any) => {
      defaultData = data;
    },
  };
  return chain;
}

let mockSupabase: ReturnType<typeof createChainableMock>;

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabase),
}));

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'user-1', tenant_id: 'tenant-1', vitana_id: 'user1handle' };
    return next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/system-controls-service', () => ({
  isVitanaBrainEnabled: jest.fn().mockResolvedValue(false),
}));

const mockProcessConversationTurn = jest.fn();
jest.mock('../src/services/conversation-client', () => ({
  processConversationTurn: (...args: any[]) => mockProcessConversationTurn(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatRouter = require('../src/routes/chat').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { notifyUser } = require('../src/services/notification-service');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/chat', chatRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase = createChainableMock();
  mockSupabase.setDefault({ data: { id: 'msg-1', content: 'hi' }, error: null });
});

describe('POST /send', () => {
  it('inserts the message and never calls processConversationTurn, even when receiver is the Vitana bot', async () => {
    const res = await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: VITANA_BOT_USER_ID, content: 'send a message to Anna' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(mockProcessConversationTurn).not.toHaveBeenCalled();
    // No push notification for the bot receiver either.
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('still fires the push notification path for a human receiver (regression guard)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: 'human-peer-1', content: 'hey there' });

    expect(res.status).toBe(201);
    expect(mockProcessConversationTurn).not.toHaveBeenCalled();
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser.mock.calls[0][0]).toBe('human-peer-1');
  });
});

describe('POST /vitana-reply', () => {
  it('generates and awaits the reply, writes it, and returns it in the response', async () => {
    mockProcessConversationTurn.mockResolvedValueOnce({
      ok: true,
      reply: 'Sure, sending that to Anna now.',
      thread_id: 'thread-1',
      turn_number: 1,
      meta: { model_used: 'gemini-2.5-pro', latency_ms: 1200 },
    });

    const res = await request(makeApp())
      .post('/api/v1/chat/vitana-reply')
      .send({ content: 'send a message to Anna' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, reply: 'Sure, sending that to Anna now.' });
    expect(mockProcessConversationTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects empty content with 400', async () => {
    const res = await request(makeApp())
      .post('/api/v1/chat/vitana-reply')
      .send({ content: '   ' });

    expect(res.status).toBe(400);
    expect(mockProcessConversationTurn).not.toHaveBeenCalled();
  });

  it('returns 502 when the turn fails or produces no reply', async () => {
    mockProcessConversationTurn.mockResolvedValueOnce({ ok: false, reply: '', error: 'llm_timeout' });

    const res = await request(makeApp())
      .post('/api/v1/chat/vitana-reply')
      .send({ content: 'hello' });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
  });

  it('rejects a concurrent duplicate call for the same user with 409, without running a second turn', async () => {
    // Every call takes 100ms, giving a deliberately-delayed second request
    // (fired 20ms after the first) a real window to overlap the first.
    mockProcessConversationTurn.mockImplementation(
      () => new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: true, reply: 'done', thread_id: 't', turn_number: 1,
          meta: { model_used: 'x', latency_ms: 1 },
        }), 100);
      }),
    );

    const app = makeApp();
    const [firstRes, secondRes] = await Promise.all([
      request(app).post('/api/v1/chat/vitana-reply').send({ content: 'first message' }),
      (async () => {
        await new Promise((r) => setTimeout(r, 20));
        return request(app).post('/api/v1/chat/vitana-reply').send({ content: 'second message' });
      })(),
    ]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(409);
    expect(mockProcessConversationTurn).toHaveBeenCalledTimes(1);
  });
});
