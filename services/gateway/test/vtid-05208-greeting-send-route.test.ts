/**
 * VTID-05208 — POST /api/v1/chat/send wiring for new-member greeting DMs.
 *
 *   - a text DM tagged content_data.source='new_member_greeting' goes through
 *     prepareNewMemberGreetingPush (recipient-keyed 24 h grouping) and never
 *     through the per-conversation coalescer;
 *   - an untagged DM still uses coalesceChatPushes with dm:<sender>
 *     (ordinary DMs unchanged);
 *   - a tagged DM whose prepare step returns null (test/service account, or
 *     the exclusion lookup failed) is still sent (201) but writes no
 *     notification.
 */

import request from 'supertest';
import express from 'express';

function createChainableMock() {
  let defaultData: any = { data: null, error: null };
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'or', 'order', 'limit', 'lt', 'is', 'single', 'maybeSingle']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = jest.fn((resolve: any, reject: any) => Promise.resolve(defaultData).then(resolve, reject));
  chain.setDefault = (data: any) => {
    defaultData = data;
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

jest.mock('../src/services/chat-push-coalescer', () => {
  const actual = jest.requireActual('../src/services/chat-push-coalescer');
  return {
    ...actual,
    coalesceChatPushes: jest.fn(async (_sb: unknown, _key: string, items: any[]) =>
      items.map((i) => ({ userId: i.userId, payload: { ...i.payload, tag: 'chat:dm:user-1' } })),
    ),
  };
});

jest.mock('../src/services/new-member-greeting-push', () => {
  const actual = jest.requireActual('../src/services/new-member-greeting-push');
  return { ...actual, prepareNewMemberGreetingPush: jest.fn() };
});

// VTID-05207: a greeting DM now passes through checkGreetingSend before the
// push path. This Lane-D suite covers the push grouping, so the guard is
// mocked as allowing — its own logic is covered by vtid-05207-greeting-guard*.
jest.mock('../src/services/new-member-greeting-guard', () => {
  const actual = jest.requireActual('../src/services/new-member-greeting-guard');
  return { ...actual, checkGreetingSend: jest.fn().mockResolvedValue({ ok: true }) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatRouter = require('../src/routes/chat').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { notifyUser } = require('../src/services/notification-service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { coalesceChatPushes } = require('../src/services/chat-push-coalescer');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prepareNewMemberGreetingPush } = require('../src/services/new-member-greeting-push');

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

describe('POST /send — new-member greeting DMs', () => {
  it('a tagged text DM goes through the greeting grouping, not the conversation coalescer', async () => {
    prepareNewMemberGreetingPush.mockImplementation(async (_sb: unknown, input: any) => ({
      userId: input.receiverId,
      payload: { ...input.payload, tag: 'chat:new_member_greeting' },
      opts: { suppressPush: 'coalesced' },
    }));
    const res = await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: 'newcomer-1', content: 'Welcome!', content_data: { source: 'new_member_greeting' } });

    expect(res.status).toBe(201);
    expect(prepareNewMemberGreetingPush).toHaveBeenCalledTimes(1);
    const input = prepareNewMemberGreetingPush.mock.calls[0][1];
    expect(input).toEqual(expect.objectContaining({ senderId: 'user-1', receiverId: 'newcomer-1' }));
    expect(input.payload.data).toEqual(expect.objectContaining({ sender_id: 'user-1', url: '/inbox/u/user-1' }));
    expect(coalesceChatPushes).not.toHaveBeenCalled();
    expect(notifyUser).toHaveBeenCalledTimes(1);
    const [uid, tenant, type, payload, , opts] = notifyUser.mock.calls[0];
    expect([uid, tenant, type]).toEqual(['newcomer-1', 'tenant-1', 'new_chat_message']);
    expect(payload.tag).toBe('chat:new_member_greeting');
    expect(opts).toEqual({ suppressPush: 'coalesced' });
  });

  it('an untagged DM is unchanged: per-conversation coalescing keyed dm:<sender>', async () => {
    const res = await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: 'peer-1', content: 'hey there' });

    expect(res.status).toBe(201);
    expect(prepareNewMemberGreetingPush).not.toHaveBeenCalled();
    expect(coalesceChatPushes).toHaveBeenCalledTimes(1);
    expect(coalesceChatPushes.mock.calls[0][1]).toBe('dm:user-1');
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });

  it('a DM with another source value is an ordinary DM', async () => {
    await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: 'peer-1', content: 'hey', content_data: { source: 'something_else' } });
    expect(prepareNewMemberGreetingPush).not.toHaveBeenCalled();
    expect(coalesceChatPushes).toHaveBeenCalledTimes(1);
  });

  it('a tagged DM whose prepare step returns null is sent (201) but writes no notification', async () => {
    prepareNewMemberGreetingPush.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: 'newcomer-1', content: 'Welcome!', content_data: { source: 'new_member_greeting' } });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prepareNewMemberGreetingPush).toHaveBeenCalledTimes(1);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(coalesceChatPushes).not.toHaveBeenCalled();
  });
});
