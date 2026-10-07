/**
 * VTID-04926 — member @mentions in group chat.
 *
 * Owner report 2026-10-06: typing "@stefan" in "Alle Beisammen" did nothing.
 * Contract under test:
 *   - sanitizeMentions keeps only members of the group whose @name is in the
 *     text — never the sender, the Vitana bot, a service/test account, a
 *     malformed entry or a duplicate;
 *   - POST /:id/send stores ONLY the sanitized list in metadata.mentions
 *     (and nothing when nobody is validly tagged);
 *   - a tagged member gets exactly one push, `chat_mention`, titled in their
 *     language and deep-linking to the message; everybody else still gets
 *     the unchanged `new_chat_message`;
 *   - a failed service/test-account lookup fails closed (no tags, message
 *     still sends);
 *   - GET /:id marks service/test accounts and the bot `mentionable: false`.
 */

import request from 'supertest';
import express from 'express';
import { sanitizeMentions } from '../src/lib/chat-mentions';

const SENDER = '11111111-1111-4111-8111-111111111111';
const STEFAN = '22222222-2222-4222-8222-222222222222';
const MICHAEL = '33333333-3333-4333-8333-333333333333';
const TESTER = '44444444-4444-4444-8444-444444444444';
const OUTSIDER = '55555555-5555-4555-8555-555555555555';
const BOT = '00000000-0000-0000-0000-000000000001';

// ── Supabase mock: per-table results for the inline (non-repository) reads ──
let tableResults: Record<string, { data: unknown; error: unknown }> = {};
function tableChain(table: string) {
  const result = () => Promise.resolve(tableResults[table] ?? { data: [], error: null });
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    maybeSingle: result,
    then: (resolve: any, reject: any) => result().then(resolve, reject),
  };
  return chain;
}
const mockSupabase = { from: jest.fn((table: string) => tableChain(table)) };
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockSupabase) }));

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: '11111111-1111-4111-8111-111111111111', tenant_id: 'tenant-1' };
    return next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
}));

const mockNotifyUser = jest.fn().mockResolvedValue({ pushed: true, inapp: true });
jest.mock('../src/services/notification-service', () => ({
  notifyUser: (...a: unknown[]) => mockNotifyUser(...a),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/conversation-client', () => ({ processConversationTurn: jest.fn() }));
jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: jest.fn().mockResolvedValue(new Map([['22222222-2222-4222-8222-222222222222', 'de']])),
}));

const mockInsert = jest.fn();
jest.mock('../src/routes/chat-groups-repository', () => ({
  fetchChatGroupMembership: jest.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
  listChatGroupMemberIds: jest.fn().mockResolvedValue({
    data: [
      { user_id: '11111111-1111-4111-8111-111111111111' },
      { user_id: '22222222-2222-4222-8222-222222222222' },
      { user_id: '33333333-3333-4333-8333-333333333333' },
      { user_id: '44444444-4444-4444-8444-444444444444' },
      { user_id: '00000000-0000-0000-0000-000000000001' },
    ],
    error: null,
  }),
  fetchChatGroupName: jest.fn().mockResolvedValue({ data: { name: 'Alle Beisammen' }, error: null }),
  fetchChatGroupWithMembers: jest.fn().mockResolvedValue([
    { data: { id: 'g1', name: 'Alle Beisammen' }, error: null },
    {
      data: [
        { user_id: '11111111-1111-4111-8111-111111111111', role: 'member', joined_at: 'x' },
        { user_id: '22222222-2222-4222-8222-222222222222', role: 'member', joined_at: 'x' },
        { user_id: '44444444-4444-4444-8444-444444444444', role: 'member', joined_at: 'x' },
        { user_id: '00000000-0000-0000-0000-000000000001', role: 'member', joined_at: 'x' },
      ],
      error: null,
    },
  ]),
  insertChatGroupMessage: (...a: unknown[]) => mockInsert(...a),
}));

import chatGroupsRouter from '../src/routes/chat-groups';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/', chatGroupsRouter);
  return a;
}

const stefanTag = { user_id: STEFAN, display_name: 'Stefan Ehlke' };

describe('sanitizeMentions (VTID-04926)', () => {
  const memberIds = new Set([SENDER, STEFAN, MICHAEL, TESTER, BOT]);
  const base = { senderId: SENDER, memberIds, excludedIds: new Set([TESTER]) };

  it('keeps a member whose @name is in the text', () => {
    expect(sanitizeMentions({ ...base, raw: [stefanTag], content: 'Hi @Stefan Ehlke' })).toEqual([stefanTag]);
  });

  it('drops non-members, the sender, the bot, test accounts, absent names, junk and duplicates', () => {
    const raw = [
      { user_id: OUTSIDER, display_name: 'Out' },
      { user_id: SENDER, display_name: 'Me' },
      { user_id: BOT, display_name: 'Vitana' },
      { user_id: TESTER, display_name: 'E2E' },
      { user_id: MICHAEL, display_name: 'Michael' },
      { user_id: 'not-a-uuid', display_name: 'X' },
      { user_id: STEFAN, display_name: 'x'.repeat(81) },
      null,
      'string',
      stefanTag,
      stefanTag,
    ];
    const content = '@Out @Me @Vitana @E2E @Stefan Ehlke';
    expect(sanitizeMentions({ ...base, raw, content })).toEqual([stefanTag]);
  });

  it('returns nothing for a non-array or empty text', () => {
    expect(sanitizeMentions({ ...base, raw: 'x', content: '@Stefan Ehlke' })).toEqual([]);
    expect(sanitizeMentions({ ...base, raw: [stefanTag], content: '' })).toEqual([]);
  });
});

describe('POST /:id/send with mentions (VTID-04926)', () => {
  beforeEach(() => {
    mockNotifyUser.mockClear();
    mockInsert.mockReset().mockImplementation((_sb: unknown, payload: any) =>
      Promise.resolve({ data: { id: 'msg-1', ...payload }, error: null }),
    );
    tableResults = {
      service_bot_accounts: { data: [], error: null },
      notification_test_actors: { data: [{ user_id: TESTER }], error: null },
      app_users: { data: null, error: null },
      profiles: { data: { display_name: 'Michael Lottmann' }, error: null },
    };
  });

  it('stores only the sanitized tags and pushes chat_mention to the tagged member', async () => {
    const res = await request(app())
      .post('/g1/send')
      .send({
        content: '@Stefan Ehlke wir haben dich vermisst',
        content_data: { mentions: [stefanTag, { user_id: TESTER, display_name: 'E2E' }, { user_id: OUTSIDER, display_name: 'Out' }] },
      });
    expect(res.status).toBe(201);
    expect(mockInsert.mock.calls[0][1].metadata).toEqual({ mentions: [stefanTag] });

    const byUser = new Map(mockNotifyUser.mock.calls.map((c) => [c[0], c]));
    const stefanCall = byUser.get(STEFAN)!;
    expect(stefanCall[2]).toBe('chat_mention');
    expect(stefanCall[3].title).toBe('Michael Lottmann hat dich in „Alle Beisammen“ erwähnt');
    expect(stefanCall[3].body).toBe('@Stefan Ehlke wir haben dich vermisst');
    expect(stefanCall[3].data.url).toBe('/inbox/g/g1/msg/msg-1');

    // Everyone else: the generic push. Nobody gets two.
    expect(byUser.get(MICHAEL)![2]).toBe('new_chat_message');
    // VTID-04928: the generic push opens the received message too.
    expect(byUser.get(MICHAEL)![3].data.url).toBe('/inbox/g/g1/msg/msg-1');
    expect(byUser.get(TESTER)![2]).toBe('new_chat_message');
    expect(mockNotifyUser.mock.calls.filter((c) => c[0] === STEFAN)).toHaveLength(1);
    expect(byUser.has(SENDER)).toBe(false);
    expect(byUser.has(BOT)).toBe(false);
  });

  it('stores no mentions key when nobody is validly tagged', async () => {
    await request(app())
      .post('/g1/send')
      .send({ content: '@Stefan hallo', content_data: { mentions: [stefanTag] } });
    expect(mockInsert.mock.calls[0][1].metadata).toEqual({});
    expect(mockNotifyUser.mock.calls.every((c) => c[2] === 'new_chat_message')).toBe(true);
  });

  it('keeps other content_data (attachments) and is unchanged without mentions', async () => {
    await request(app())
      .post('/g1/send')
      .send({ content: 'Foto', message_type: 'attachment', content_data: { attachments: [{ url: 'u', filename: 'a.png' }] } });
    expect(mockInsert.mock.calls[0][1].metadata).toEqual({ attachments: [{ url: 'u', filename: 'a.png' }] });
  });

  it('fails closed when the test-account lookup errors: message sends, nobody tagged', async () => {
    tableResults.notification_test_actors = { data: null, error: { message: 'boom' } };
    const res = await request(app())
      .post('/g1/send')
      .send({ content: '@Stefan Ehlke hi', content_data: { mentions: [stefanTag] } });
    expect(res.status).toBe(201);
    expect(mockInsert.mock.calls[0][1].metadata).toEqual({});
    expect(mockNotifyUser.mock.calls.every((c) => c[2] === 'new_chat_message')).toBe(true);
  });
});

describe('GET /:id mentionable flag (VTID-04926)', () => {
  it('marks test/service accounts and the bot as not mentionable', async () => {
    tableResults = {
      profiles: { data: [{ user_id: STEFAN, display_name: 'Stefan Ehlke', full_name: null, avatar_url: null }], error: null },
      app_users: { data: [], error: null },
      service_bot_accounts: { data: [], error: null },
      notification_test_actors: { data: [{ user_id: TESTER }], error: null },
    };
    const res = await request(app()).get('/g1');
    expect(res.status).toBe(200);
    const flags = Object.fromEntries(res.body.data.members.map((m: any) => [m.user_id, m.mentionable]));
    expect(flags).toEqual({ [SENDER]: true, [STEFAN]: true, [TESTER]: false, [BOT]: false });
  });

  it('offers nobody when the lookup fails', async () => {
    tableResults.service_bot_accounts = { data: null, error: { message: 'boom' } };
    const res = await request(app()).get('/g1');
    expect(res.body.data.members.every((m: any) => m.mentionable === false)).toBe(true);
  });
});
