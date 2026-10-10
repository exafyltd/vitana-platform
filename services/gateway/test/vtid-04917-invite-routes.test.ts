/**
 * VTID-04917 — the routes around a calendar invite.
 *
 *   - POST /chat/send and POST /chat/groups/:id/send accept message_type
 *     'calendar_invite' and store ONLY the card the server built from the
 *     sender's own entry (whatever the client put in content_data);
 *     a refused entry answers with the service's status and reason and
 *     inserts nothing;
 *   - the calendar router's invite routes pass the verified caller through
 *     and accept only { response } of accepted | maybe | declined.
 */
import request from 'supertest';
import express from 'express';

const SENDER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const ENTRY = '66666666-6666-4666-8666-666666666666';
const MSG = '99999999-9999-4999-8999-999999999999';

const CARD = {
  kind: 'calendar_invite', v: 2, ref_type: 'calendar_entry', ref_id: ENTRY,
  title: 'Coffee at Luigi', start_time: '2026-10-12T15:00:00Z', end_time: null, location: null,
};

const mockBuildForChat = jest.fn();
const mockRespond = jest.fn();
const mockState = jest.fn();
const mockBuildFromEntry = jest.fn();
jest.mock('../src/services/calendar-invite', () => ({
  ...jest.requireActual('../src/services/calendar-invite'),
  buildInviteForChat: (...a: unknown[]) => mockBuildForChat(...a),
  buildInviteFromEntry: (...a: unknown[]) => mockBuildFromEntry(...a),
  respondToInvite: (...a: unknown[]) => mockRespond(...a),
  getInviteState: (...a: unknown[]) => mockState(...a),
}));

function tableChain() {
  const result = () => Promise.resolve({ data: [], error: null });
  const chain: any = {
    select: () => chain, eq: () => chain, in: () => chain, limit: () => chain,
    maybeSingle: result, single: result,
    then: (resolve: any, reject: any) => result().then(resolve, reject),
  };
  return chain;
}
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({ from: jest.fn(() => tableChain()) })) }));

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer ok') return res.status(401).json({ ok: false, error: 'unauthorized' });
    req.identity = { user_id: '11111111-1111-4111-8111-111111111111', tenant_id: 'tenant-1', vitana_id: 'me' };
    return next();
  },
  optionalAuth: (req: any, _res: any, next: any) => {
    if (req.headers.authorization === 'Bearer ok') req.identity = { user_id: '11111111-1111-4111-8111-111111111111' };
    return next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/notification-service', () => ({ notifyUser: jest.fn().mockResolvedValue({ pushed: true }) }));
const mockEmit = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => mockEmit(...a) }));
jest.mock('../src/services/conversation-client', () => ({ processConversationTurn: jest.fn() }));
jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('de'),
  bulkGetUserLocales: jest.fn().mockResolvedValue(new Map()),
}));
const mockInsertDm = jest.fn();
jest.mock('../src/routes/chat-repository', () => ({
  ...jest.requireActual('../src/routes/chat-repository'),
  insertChatMessage: (...a: unknown[]) => mockInsertDm(...a),
}));
const mockInsertGroup = jest.fn();
jest.mock('../src/routes/chat-groups-repository', () => ({
  ...jest.requireActual('../src/routes/chat-groups-repository'),
  fetchChatGroupMembership: jest.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
  listChatGroupMemberIds: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchChatGroupName: jest.fn().mockResolvedValue({ data: { name: 'G' }, error: null }),
  insertChatGroupMessage: (...a: unknown[]) => mockInsertGroup(...a),
}));
jest.mock('../src/services/calendar-service', () => ({
  ...jest.requireActual('../src/services/calendar-service'),
  getOwnCalendarEvent: jest.fn(async (id: string) => (id === 'e1' ? { id: 'e1' } : null)),
}));

import chatRouter from '../src/routes/chat';
import chatGroupsRouter from '../src/routes/chat-groups';
import calendarRouter from '../src/routes/calendar';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/chat/groups', chatGroupsRouter);
  a.use('/chat', chatRouter);
  a.use('/calendar', calendarRouter);
  return a;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE = 'service-key';
  mockBuildForChat.mockReset().mockResolvedValue({ ok: true, metadata: CARD, content: '📅 Coffee at Luigi' });
  mockInsertDm.mockReset().mockImplementation(async (_sb: unknown, row: any) => ({ data: { id: MSG, ...row }, error: null }));
  mockInsertGroup.mockReset().mockImplementation(async (_sb: unknown, row: any) => ({ data: { id: MSG, ...row }, error: null }));
  mockRespond.mockReset();
  mockState.mockReset();
  mockBuildFromEntry.mockReset();
  mockEmit.mockClear();
});

describe('sending an invite in a chat (VTID-04917)', () => {
  it('a DM stores the server-built card and content, never what the client sent', async () => {
    const res = await request(app())
      .post('/chat/send')
      .set('Authorization', 'Bearer ok')
      .send({ receiver_id: FRIEND, message_type: 'calendar_invite', content: 'forged', content_data: { entry_id: ENTRY, title: 'forged', ref_type: 'community_event' } });
    expect(res.status).toBeLessThan(300);
    expect(mockBuildForChat).toHaveBeenCalledWith(SENDER, { entry_id: ENTRY, title: 'forged', ref_type: 'community_event' });
    const row = mockInsertDm.mock.calls[0][1];
    expect(row).toMatchObject({ sender_id: SENDER, receiver_id: FRIEND, message_type: 'calendar_invite', content: '📅 Coffee at Luigi' });
    expect(row.metadata).toEqual(CARD);
  });

  it('a group message does the same', async () => {
    const res = await request(app())
      .post('/chat/groups/g1/send')
      .set('Authorization', 'Bearer ok')
      .send({ message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(res.status).toBeLessThan(300);
    const row = mockInsertGroup.mock.calls[0][1];
    expect(row).toMatchObject({ group_id: 'g1', message_type: 'calendar_invite', content: '📅 Coffee at Luigi' });
    expect(row.metadata).toEqual(CARD);
  });

  it('a refused entry answers with the reason and sends nothing', async () => {
    mockBuildForChat.mockResolvedValue({ ok: false, status: 409, error: 'NOT_INVITABLE', reason: 'private_entry' });
    const dm = await request(app()).post('/chat/send').set('Authorization', 'Bearer ok')
      .send({ receiver_id: FRIEND, message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(dm.status).toBe(409);
    expect(dm.body).toEqual({ ok: false, error: 'NOT_INVITABLE', reason: 'private_entry' });
    const group = await request(app()).post('/chat/groups/g1/send').set('Authorization', 'Bearer ok')
      .send({ message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(group.status).toBe(409);
    expect(mockInsertDm).not.toHaveBeenCalled();
    expect(mockInsertGroup).not.toHaveBeenCalled();
  });

  it('other message types are unchanged: text still stores what was sent, unknown types are refused', async () => {
    await request(app()).post('/chat/send').set('Authorization', 'Bearer ok').send({ receiver_id: FRIEND, content: 'hi' });
    expect(mockBuildForChat).not.toHaveBeenCalled();
    expect(mockInsertDm.mock.calls[0][1]).toMatchObject({ message_type: 'text', content: 'hi', metadata: {} });
    const bad = await request(app()).post('/chat/send').set('Authorization', 'Bearer ok').send({ receiver_id: FRIEND, content: 'x', message_type: 'link_share' });
    expect(bad.status).toBe(400);
  });
});

describe('the calendar invite routes (VTID-04917)', () => {
  it('401 without a verified identity', async () => {
    expect((await request(app()).post(`/calendar/invites/${MSG}/respond`).send({ response: 'accepted' })).status).toBe(401);
    expect((await request(app()).get(`/calendar/invites/${MSG}`)).status).toBe(401);
    expect((await request(app()).get('/calendar/events/e1/invite-preview')).status).toBe(401);
  });

  it('answers as the verified caller, emits the OASIS event, returns where the app should go', async () => {
    mockRespond.mockResolvedValue({ ok: true, response: 'accepted', action: 'open_event', path: '/comm/events-meetups?event=x' });
    const res = await request(app()).post(`/calendar/invites/${MSG}/respond`).set('Authorization', 'Bearer ok').send({ response: 'accepted' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { response: 'accepted', action: 'open_event', path: '/comm/events-meetups?event=x' } });
    expect(mockRespond).toHaveBeenCalledWith(SENDER, MSG, 'accepted');
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ vtid: 'VTID-04917', type: 'calendar.invite.responded' }));
  });

  it('only { response } of accepted | maybe | declined', async () => {
    for (const body of [{}, { response: 'yes' }, { response: 'accepted', user_id: FRIEND }]) {
      const res = await request(app()).post(`/calendar/invites/${MSG}/respond`).set('Authorization', 'Bearer ok').send(body);
      expect(res.status).toBe(400);
    }
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it('passes refusals through without an OASIS event', async () => {
    mockRespond.mockResolvedValue({ ok: false, status: 409, error: 'OWN_INVITE' });
    const res = await request(app()).post(`/calendar/invites/${MSG}/respond`).set('Authorization', 'Bearer ok').send({ response: 'maybe' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'OWN_INVITE' });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('the card state and the preview', async () => {
    mockState.mockResolvedValueOnce({ my_response: 'maybe', counts: { accepted: 1, maybe: 1, declined: 0 }, is_sender: false }).mockResolvedValueOnce(null);
    expect((await request(app()).get(`/calendar/invites/${MSG}`).set('Authorization', 'Bearer ok')).body).toEqual({
      ok: true, data: { my_response: 'maybe', counts: { accepted: 1, maybe: 1, declined: 0 }, is_sender: false },
    });
    expect((await request(app()).get(`/calendar/invites/${MSG}`).set('Authorization', 'Bearer ok')).status).toBe(404);
    mockBuildFromEntry.mockResolvedValueOnce({ ok: true, metadata: CARD, content: 'x' }).mockResolvedValueOnce({ ok: false, status: 409, error: 'NOT_INVITABLE', reason: 'past' });
    expect((await request(app()).get('/calendar/events/e1/invite-preview').set('Authorization', 'Bearer ok')).body).toEqual({ ok: true, data: CARD });
    const refused = await request(app()).get('/calendar/events/e1/invite-preview').set('Authorization', 'Bearer ok');
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ ok: false, error: 'NOT_INVITABLE', reason: 'past' });
  });
});
