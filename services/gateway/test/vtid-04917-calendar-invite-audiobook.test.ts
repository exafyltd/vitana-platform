/**
 * VTID-04917 — invite someone to a calendar entry through the messenger, and
 * the audiobook daily reminder in the calendar.
 *
 * Runs the real services against a fake PostgREST (global fetch) and mocked
 * calendar producers, so the rules are proven without touching any
 * database: what can be invited to, that the card is built on the server
 * from the sender's own entry, who may answer, what Accept does for each
 * kind (join a free event, open a paid one / a room, copy an own entry),
 * and that the audiobook entry is one daily row with no calendar push.
 */
const mockUpsert = jest.fn();
const mockCancel = jest.fn();
const mockGetOwn = jest.fn();
jest.mock('../src/services/calendar-producers', () => ({
  upsertCalendarEntryFromSource: (...a: unknown[]) => mockUpsert(...a),
  cancelCalendarEntriesForSource: (...a: unknown[]) => mockCancel(...a),
}));
jest.mock('../src/services/calendar-service', () => ({
  ...jest.requireActual('../src/services/calendar-service'),
  getOwnCalendarEvent: (...a: unknown[]) => mockGetOwn(...a),
}));

import {
  buildInviteForChat,
  buildInviteFromEntry,
  getInviteState,
  inviteMetadataOf,
  respondToInvite,
} from '../src/services/calendar-invite';
import { audiobookEntryStart, syncAudiobookCalendarEntry } from '../src/services/guided-journey/audiobook-calendar';
import { CALENDAR_SOURCE_TYPES } from '../src/types/calendar';
import * as fs from 'fs';
import * as path from 'path';

const SENDER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '77777777-7777-4777-8777-777777777777';
const EVENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const ROOM = '55555555-5555-4555-8555-555555555555';
const ENTRY = '66666666-6666-4666-8666-666666666666';
const GROUP = '88888888-8888-4888-8888-888888888888';
const MSG = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-10-10T10:00:00Z');

type Db = {
  events: Record<string, any>;
  sessions: Record<string, any>;
  rooms: Record<string, any>;
  tickets: Array<{ event_id: string; price: number }>;
  participants: Array<{ event_id: string; user_id: string; status: string }>;
  messages: Record<string, any>;
  members: Array<{ group_id: string; user_id: string }>;
  responses: Array<{ message_id: string; user_id: string; response: string }>;
};
let db: Db;
let writes: Array<{ table: string; body: any; prefer: string }>;

function respond(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as any);
}
const eq = (q: URLSearchParams, k: string) => (q.get(k) || '').replace(/^eq\./, '');

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE = 'service-key';
  mockUpsert.mockReset().mockResolvedValue({ action: 'created', event: null });
  mockCancel.mockReset().mockResolvedValue(1);
  mockGetOwn.mockReset().mockResolvedValue(null);
  writes = [];
  db = {
    events: { [EVENT]: { title: 'Sunset walk', start_time: '2026-10-11T18:00:00Z', end_time: '2026-10-11T19:00:00Z', metadata: {}, max_participants: null } },
    sessions: { [SESSION]: { status: 'scheduled', starts_at: '2026-10-10T12:00:00Z', ends_at: null, session_title: 'Breathwork', room_id: ROOM } },
    rooms: { [ROOM]: { access_level: 'public', title: 'Calm room' } },
    tickets: [],
    participants: [],
    messages: {},
    members: [{ group_id: GROUP, user_id: FRIEND }, { group_id: GROUP, user_id: SENDER }],
    responses: [],
  };
  (global as any).fetch = jest.fn((url: string, init?: any) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const q = u.searchParams;
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body);
      writes.push({ table, body, prefer: init.headers?.Prefer ?? '' });
      if (table === 'calendar_invite_responses') {
        db.responses = db.responses.filter((r) => !(r.message_id === body.message_id && r.user_id === body.user_id));
        db.responses.push(body);
      }
      if (table === 'global_event_participants') db.participants.push(body);
      return respond(201, '');
    }
    if (table === 'global_community_events') return respond(200, db.events[eq(q, 'id')] ? [db.events[eq(q, 'id')]] : []);
    if (table === 'live_room_sessions') return respond(200, db.sessions[eq(q, 'id')] ? [db.sessions[eq(q, 'id')]] : []);
    if (table === 'live_rooms') return respond(200, db.rooms[eq(q, 'id')] ? [db.rooms[eq(q, 'id')]] : []);
    if (table === 'event_ticket_types') return respond(200, db.tickets.filter((t) => t.event_id === eq(q, 'event_id')));
    if (table === 'global_event_participants') return respond(200, db.participants.filter((p) => p.event_id === eq(q, 'event_id')));
    if (table === 'chat_messages') return respond(200, db.messages[eq(q, 'id')] ? [db.messages[eq(q, 'id')]] : []);
    if (table === 'chat_group_members') {
      return respond(200, db.members.filter((m) => m.group_id === eq(q, 'group_id') && m.user_id === eq(q, 'user_id')));
    }
    if (table === 'calendar_invite_responses') return respond(200, db.responses.filter((r) => r.message_id === eq(q, 'message_id')));
    return respond(404, []);
  });
});

const ownEntry = (over: Record<string, unknown> = {}) => ({
  id: ENTRY, user_id: SENDER, title: 'Coffee at Luigi', status: 'confirmed', source_type: 'manual',
  source_ref_type: null, source_ref_id: null, metadata: null, rrule: null,
  start_time: '2026-10-12T15:00:00Z', end_time: '2026-10-12T16:00:00Z', location: "Luigi's", description: 'private notes', ...over,
});
const rsvpEntry = (over: Record<string, unknown> = {}) =>
  ownEntry({ title: 'Sunset walk', source_type: 'community_rsvp', source_ref_type: 'community_event', source_ref_id: EVENT, start_time: '2026-10-11T18:00:00Z', end_time: '2026-10-11T19:00:00Z', location: 'Lake park', ...over });

function message(over: Record<string, unknown> = {}, md: Record<string, unknown> = {}) {
  db.messages[MSG] = {
    id: MSG, sender_id: SENDER, receiver_id: FRIEND, group_id: null, message_type: 'calendar_invite',
    metadata: { kind: 'calendar_invite', v: 2, ref_type: 'community_event', ref_id: EVENT, title: 'Sunset walk', start_time: '2026-10-11T18:00:00Z', end_time: null, location: null, ...md },
    ...over,
  };
}

describe('the invite card is built on the server (VTID-04917)', () => {
  it("a community event the sender is going to: the event's own title, no private fields", async () => {
    const r = await buildInviteFromEntry(SENDER, rsvpEntry({ title: 'my own name for it' }), NOW);
    expect(r).toEqual({
      ok: true,
      content: '📅 Sunset walk',
      metadata: { kind: 'calendar_invite', v: 2, ref_type: 'community_event', ref_id: EVENT, title: 'Sunset walk', start_time: '2026-10-11T18:00:00Z', end_time: '2026-10-11T19:00:00Z', location: 'Lake park' },
    });
    expect(JSON.stringify(r)).not.toContain('private notes');
  });

  it('a live room session in a public room', async () => {
    const r = await buildInviteFromEntry(SENDER, ownEntry({ source_type: 'live_room', source_ref_type: 'live_room_session', source_ref_id: SESSION, start_time: '2026-10-10T12:00:00Z', end_time: null }), NOW);
    expect(r).toMatchObject({ ok: true, metadata: { ref_type: 'live_room_session', ref_id: SESSION, title: 'Breathwork' } });
  });

  it("the sender's own one-off entry (manual or an accepted invite)", async () => {
    expect(await buildInviteFromEntry(SENDER, ownEntry(), NOW)).toMatchObject({ ok: true, metadata: { ref_type: 'calendar_entry', ref_id: ENTRY, title: 'Coffee at Luigi' } });
    expect(await buildInviteFromEntry(SENDER, ownEntry({ source_type: 'invite' }), NOW)).toMatchObject({ ok: true });
  });

  it("never someone else's entry, a cancelled or finished one, a series, or a private kind", async () => {
    expect(await buildInviteFromEntry(SENDER, ownEntry({ user_id: STRANGER }), NOW)).toMatchObject({ ok: false, status: 404 });
    expect(await buildInviteFromEntry(SENDER, null, NOW)).toMatchObject({ ok: false, status: 404 });
    expect(await buildInviteFromEntry(SENDER, ownEntry({ status: 'cancelled' }), NOW)).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(await buildInviteFromEntry(SENDER, ownEntry({ start_time: '2026-10-09T08:00:00Z', end_time: '2026-10-09T09:00:00Z' }), NOW)).toMatchObject({ ok: false, reason: 'past' });
    expect(await buildInviteFromEntry(SENDER, ownEntry({ rrule: 'FREQ=DAILY' }), NOW)).toMatchObject({ ok: false, reason: 'recurring' });
    for (const source_type of ['health_plan', 'lab_order', 'appointment', 'goal_plan', 'journey', 'autopilot', 'subscription', 'reminder', 'audiobook', 'assistant']) {
      expect(await buildInviteFromEntry(SENDER, ownEntry({ source_type }), NOW)).toMatchObject({ ok: false, status: 409, reason: 'private_entry' });
    }
  });

  it('an event that is over, gone or in a non-public room is not invitable', async () => {
    db.rooms[ROOM].access_level = 'premium';
    expect(await buildInviteFromEntry(SENDER, ownEntry({ source_type: 'live_room', source_ref_type: 'live_room_session', source_ref_id: SESSION, start_time: '2026-10-10T12:00:00Z' }), NOW)).toMatchObject({ ok: false, reason: 'not_public' });
    delete db.events[EVENT];
    expect(await buildInviteFromEntry(SENDER, rsvpEntry(), NOW)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('the chat routes pass only entry_id; the entry is loaded as the sender', async () => {
    mockGetOwn.mockResolvedValue(ownEntry());
    const r = await buildInviteForChat(SENDER, { entry_id: ENTRY, title: 'forged', start_time: '2099-01-01T00:00:00Z' }, NOW);
    expect(mockGetOwn).toHaveBeenCalledWith(ENTRY, SENDER);
    expect(r).toMatchObject({ ok: true, metadata: { title: 'Coffee at Luigi', start_time: '2026-10-12T15:00:00Z' } });
    expect(await buildInviteForChat(SENDER, {}, NOW)).toEqual({ ok: false, status: 400, error: 'entry_id_required' });
    expect(await buildInviteForChat(SENDER, { entry_id: 'not-a-uuid' }, NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it('only version-2 cards with a known reference are answerable (older client-made cards are left alone)', () => {
    expect(inviteMetadataOf({ id: MSG, sender_id: SENDER, receiver_id: FRIEND, group_id: null, message_type: 'calendar_invite', metadata: { title: 'old', date: '2026-10-11' } })).toBeNull();
    expect(inviteMetadataOf({ id: MSG, sender_id: SENDER, receiver_id: FRIEND, group_id: null, message_type: 'text', metadata: { v: 2 } })).toBeNull();
  });
});

describe('answering an invite (VTID-04917)', () => {
  it('a free community event: Accept joins it through the participation row (the database adds the calendar entry)', async () => {
    message();
    expect(await respondToInvite(FRIEND, MSG, 'accepted', NOW)).toEqual({ ok: true, response: 'accepted', action: 'joined', path: `/comm/events-meetups?event=${EVENT}` });
    expect(db.participants).toEqual([{ event_id: EVENT, user_id: FRIEND, status: 'attending' }]);
    expect(db.responses).toEqual([expect.objectContaining({ message_id: MSG, user_id: FRIEND, response: 'accepted' })]);
    expect(writes.find((w) => w.table === 'global_event_participants')?.prefer).toContain('merge-duplicates');
  });

  it('a paid event (ticket price or is_paid) or a full one is never joined from the card: the event page opens', async () => {
    message();
    db.tickets.push({ event_id: EVENT, price: 15 });
    expect(await respondToInvite(FRIEND, MSG, 'accepted', NOW)).toMatchObject({ action: 'open_event', path: `/comm/events-meetups?event=${EVENT}` });
    db.tickets = [];
    db.events[EVENT].metadata = { is_paid: true };
    expect(await respondToInvite(FRIEND, MSG, 'accepted', NOW)).toMatchObject({ action: 'open_event' });
    db.events[EVENT].metadata = {};
    db.events[EVENT].max_participants = 1;
    db.participants.push({ event_id: EVENT, user_id: STRANGER, status: 'attending' });
    expect(await respondToInvite(FRIEND, MSG, 'accepted', NOW)).toMatchObject({ action: 'open_event' });
    expect(db.participants.filter((p) => p.user_id === FRIEND)).toHaveLength(0);
  });

  it('a live room opens the room', async () => {
    message({}, { ref_type: 'live_room_session', ref_id: SESSION });
    expect(await respondToInvite(FRIEND, MSG, 'accepted', NOW)).toEqual({ ok: true, response: 'accepted', action: 'open_room', path: `/comm/live-rooms/${ROOM}/view` });
  });

  it('an event that is over by now is not joined', async () => {
    message();
    db.events[EVENT].start_time = '2026-10-09T18:00:00Z';
    db.events[EVENT].end_time = '2026-10-09T19:00:00Z';
    expect(await respondToInvite(FRIEND, MSG, 'accepted', NOW)).toEqual({ ok: false, status: 409, error: 'EVENT_NOT_OPEN' });
    expect(db.participants).toHaveLength(0);
  });

  it("Maybe and No on an event are recorded and never touch the member's participation", async () => {
    message();
    expect(await respondToInvite(FRIEND, MSG, 'maybe', NOW)).toMatchObject({ action: 'recorded' });
    expect(await respondToInvite(FRIEND, MSG, 'declined', NOW)).toMatchObject({ action: 'recorded' });
    expect(db.participants).toHaveLength(0);
    expect(db.responses).toEqual([expect.objectContaining({ response: 'declined' })]);
  });

  it("an own entry: Accept copies it into the recipient's calendar, No removes the copy", async () => {
    message({}, { ref_type: 'calendar_entry', ref_id: ENTRY, title: 'Coffee at Luigi', start_time: '2026-10-12T15:00:00Z', end_time: '2026-10-12T16:00:00Z', location: "Luigi's" });
    expect(await respondToInvite(FRIEND, MSG, 'accepted', NOW)).toEqual({ ok: true, response: 'accepted', action: 'added' });
    expect(mockUpsert).toHaveBeenCalledWith(
      FRIEND,
      { source_type: 'invite', source_ref_type: 'calendar_invite', source_ref_id: MSG },
      expect.objectContaining({ title: 'Coffee at Luigi', start_time: '2026-10-12T15:00:00Z', location: "Luigi's", metadata: { invited_by: SENDER, message_id: MSG } }),
    );
    expect(await respondToInvite(FRIEND, MSG, 'declined', NOW)).toEqual({ ok: true, response: 'declined', action: 'removed' });
    expect(mockCancel).toHaveBeenCalledWith(FRIEND, 'calendar_invite', MSG);
  });

  it('only the recipient or a group member can answer; never the sender, never a stranger', async () => {
    message();
    expect(await respondToInvite(SENDER, MSG, 'accepted', NOW)).toEqual({ ok: false, status: 409, error: 'OWN_INVITE' });
    expect(await respondToInvite(STRANGER, MSG, 'accepted', NOW)).toEqual({ ok: false, status: 404, error: 'NOT_FOUND' });
    message({ receiver_id: null, group_id: GROUP });
    expect(await respondToInvite(FRIEND, MSG, 'maybe', NOW)).toMatchObject({ ok: true });
    expect(await respondToInvite(STRANGER, MSG, 'maybe', NOW)).toMatchObject({ ok: false, status: 404 });
    expect(await respondToInvite(FRIEND, 'not-a-uuid', 'maybe', NOW)).toMatchObject({ ok: false, status: 404 });
    expect(writes.filter((w) => w.table === 'calendar_invite_responses')).toHaveLength(1);
  });

  it('the card state: my answer and the counts, for the sender and the members', async () => {
    message({ receiver_id: null, group_id: GROUP });
    await respondToInvite(FRIEND, MSG, 'maybe', NOW);
    db.responses.push({ message_id: MSG, user_id: STRANGER, response: 'accepted' });
    expect(await getInviteState(FRIEND, MSG)).toEqual({ my_response: 'maybe', counts: { accepted: 1, maybe: 1, declined: 0 }, is_sender: false });
    expect(await getInviteState(SENDER, MSG)).toMatchObject({ my_response: null, is_sender: true });
    expect(await getInviteState(STRANGER, MSG)).toBeNull();
  });
});

describe('the audiobook reminder in the calendar (VTID-04917)', () => {
  it('starts today at the chosen local time, DST-correct', () => {
    expect(audiobookEntryStart({ time: '08:00', tz: 'Europe/Berlin' }, NOW).toISOString()).toBe('2026-10-10T06:00:00.000Z'); // CEST
    expect(audiobookEntryStart({ time: '08:00', tz: 'Europe/Berlin' }, new Date('2026-12-01T10:00:00Z')).toISOString()).toBe('2026-12-01T07:00:00.000Z'); // CET
    expect(audiobookEntryStart({ time: '21:00', tz: 'America/New_York' }, NOW).toISOString()).toBe('2026-10-11T01:00:00.000Z');
    // Just after midnight in Tokyo it is already the next local day.
    expect(audiobookEntryStart({ time: '07:00', tz: 'Asia/Tokyo' }, new Date('2026-10-10T16:30:00Z')).toISOString()).toBe('2026-10-10T22:00:00.000Z');
  });

  it('one daily entry per member with no calendar push (the audiobook dispatcher stays the only sender)', async () => {
    expect(await syncAudiobookCalendarEntry(SENDER, { time: '08:00', tz: 'Europe/Berlin' }, NOW)).toBe('upserted');
    expect(mockUpsert).toHaveBeenCalledWith(
      SENDER,
      { source_type: 'audiobook', source_ref_type: 'audiobook_reminder', source_ref_id: SENDER },
      expect.objectContaining({
        start_time: '2026-10-10T06:00:00.000Z',
        end_time: '2026-10-10T06:20:00.000Z',
        rrule: 'FREQ=DAILY',
        timezone: 'Europe/Berlin',
        reminder_offsets: [],
        role_context: 'community',
        emoji: '🎧',
      }),
    );
  });

  it('switching the reminder off cancels the entry', async () => {
    expect(await syncAudiobookCalendarEntry(SENDER, null, NOW)).toBe('cancelled');
    expect(mockCancel).toHaveBeenCalledWith(SENDER, 'audiobook_reminder', SENDER);
  });

  it('a calendar failure never throws (the reminder is saved either way)', async () => {
    mockUpsert.mockResolvedValueOnce({ action: 'failed', event: null, error: 'boom' });
    expect(await syncAudiobookCalendarEntry(SENDER, { time: '08:00', tz: 'UTC' }, NOW)).toBe('failed');
    mockUpsert.mockRejectedValueOnce(new Error('network'));
    expect(await syncAudiobookCalendarEntry(SENDER, { time: '08:00', tz: 'UTC' }, NOW)).toBe('failed');
    mockCancel.mockRejectedValueOnce(new Error('network'));
    expect(await syncAudiobookCalendarEntry(SENDER, null, NOW)).toBe('failed');
  });

  it("'audiobook' is an allowed source type in the code and in the newest constraint migration", () => {
    expect(CALENDAR_SOURCE_TYPES).toContain('audiobook');
    const sql = fs.readFileSync(path.join(__dirname, '../../../supabase/migrations/20261010150000_vtid_04917_audiobook_source_type.sql'), 'utf8');
    const check = sql.slice(sql.indexOf('ADD CONSTRAINT valid_source_type'));
    expect(check).toContain("'audiobook'");
    // Every value it allows is known; full parity with the newest migration is
    // pinned by vtid-04331-calendar-data-model.test.ts.
    for (const t of check.match(/'[a-z_]+'/g) ?? []) expect(CALENDAR_SOURCE_TYPES).toContain(t.slice(1, -1));
  });
});
