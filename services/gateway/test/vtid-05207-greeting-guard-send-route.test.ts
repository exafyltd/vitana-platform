/**
 * VTID-05207 — the greeting guard wired into POST /api/v1/chat/send
 * (routes/chat.ts), plan Part B / finding F10.
 *
 *   - a DM tagged content_data.source='new_member_greeting' runs
 *     checkGreetingSend BEFORE the insert; a refusal answers one generic 403
 *     and nothing is inserted or notified;
 *   - an allowed greeting flows on to the (already-merged) Lane-D push path;
 *   - an UNTAGGED ordinary DM NEVER touches the guard and behaves exactly as
 *     today (regression — the guard only adds restrictions to tagged DMs).
 */
import request from 'supertest';
import express from 'express';

function createChainableMock() {
  let defaultData: any = { data: null, error: null };
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'or', 'order', 'limit', 'lt', 'gte', 'is', 'single', 'maybeSingle']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = jest.fn((resolve: any, reject: any) => Promise.resolve(defaultData).then(resolve, reject));
  chain.setDefault = (data: any) => {
    defaultData = data;
  };
  return chain;
}

let mockSupabase: ReturnType<typeof createChainableMock>;

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockSupabase) }));

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'user-1', tenant_id: 'tenant-1', vitana_id: 'user1handle' };
    return next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/notification-service', () => ({ notifyUser: jest.fn().mockResolvedValue(undefined) }));

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

// The guard is mocked here so this suite isolates the WIRING (guard runs,
// refusal short-circuits, success flows on). The guard's own logic is covered
// by vtid-05207-greeting-guard.test.ts.
jest.mock('../src/services/new-member-greeting-guard', () => {
  const actual = jest.requireActual('../src/services/new-member-greeting-guard');
  return { ...actual, checkGreetingSend: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatRouter = require('../src/routes/chat').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { notifyUser } = require('../src/services/notification-service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { coalesceChatPushes } = require('../src/services/chat-push-coalescer');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prepareNewMemberGreetingPush } = require('../src/services/new-member-greeting-push');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkGreetingSend, GREETING_REFUSED_CODE } = require('../src/services/new-member-greeting-guard');

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

describe('POST /send — greeting guard wiring', () => {
  it('refuses a tagged greeting DM with one generic 403 when the guard refuses — no insert, no notification', async () => {
    checkGreetingSend.mockResolvedValue({ ok: false, code: GREETING_REFUSED_CODE });
    const res = await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: 'newcomer-1', content: 'Welcome!', content_data: { source: 'new_member_greeting' } });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: GREETING_REFUSED_CODE });
    expect(checkGreetingSend).toHaveBeenCalledTimes(1);
    const input = checkGreetingSend.mock.calls[0][0];
    expect(input).toEqual(expect.objectContaining({ senderId: 'user-1', receiverId: 'newcomer-1', tenantId: 'tenant-1' }));
    expect(notifyUser).not.toHaveBeenCalled();
    expect(prepareNewMemberGreetingPush).not.toHaveBeenCalled();
  });

  it('lets an allowed greeting flow on to the Lane-D push grouping', async () => {
    checkGreetingSend.mockResolvedValue({ ok: true });
    prepareNewMemberGreetingPush.mockResolvedValue({
      userId: 'newcomer-1',
      payload: { title: 'x', body: 'y', data: {}, tag: 'chat:new_member_greeting' },
      opts: { suppressPush: 'coalesced' },
    });
    const res = await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: 'newcomer-1', content: 'Welcome!', content_data: { source: 'new_member_greeting' } });

    expect(res.status).toBe(201);
    expect(checkGreetingSend).toHaveBeenCalledTimes(1);
    expect(prepareNewMemberGreetingPush).toHaveBeenCalledTimes(1);
    expect(coalesceChatPushes).not.toHaveBeenCalled();
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: an untagged ordinary DM never touches the guard and is unchanged', async () => {
    const res = await request(makeApp()).post('/api/v1/chat/send').send({ receiver_id: 'peer-1', content: 'hey there' });

    expect(res.status).toBe(201);
    expect(checkGreetingSend).not.toHaveBeenCalled();
    expect(prepareNewMemberGreetingPush).not.toHaveBeenCalled();
    expect(coalesceChatPushes).toHaveBeenCalledTimes(1);
    expect(coalesceChatPushes.mock.calls[0][1]).toBe('dm:user-1');
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: a DM with a different source value is an ordinary DM (guard untouched)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/chat/send')
      .send({ receiver_id: 'peer-1', content: 'hey', content_data: { source: 'something_else' } });
    expect(res.status).toBe(201);
    expect(checkGreetingSend).not.toHaveBeenCalled();
    expect(coalesceChatPushes).toHaveBeenCalledTimes(1);
  });
});
