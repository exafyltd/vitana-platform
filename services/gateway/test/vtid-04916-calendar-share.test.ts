/**
 * VTID-04916 — share a calendar entry to the news feed.
 *
 * Runs the real service against a fake PostgREST (global fetch), so the
 * rules are proven without touching any database: what is shareable, that
 * the author is always the verified caller, one share per event, the daily
 * limit, and the error mapping of the database's own guards.
 */
import {
  checkShareTarget,
  isShareableEntry,
  shareCalendarEntryToFeed,
  shareRefOf,
  SHARE_LIMIT_PER_DAY,
} from '../src/services/calendar-share';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const ROOM = '55555555-5555-4555-8555-555555555555';
const OTHER_EVENT = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-10-10T10:00:00Z');

type Db = {
  events: Record<string, { title: string; start_time: string | null; end_time: string | null }>;
  sessions: Record<string, { status: string; starts_at: string | null; ends_at: string | null; session_title: string | null; room_id: string | null }>;
  rooms: Record<string, { access_level: string; title: string }>;
  posts: Array<{ id: string; user_id: string; attached_ref_id: string | null; created_at: string; body?: any }>;
  insertError?: { status: number; body: string };
};

let db: Db;
let inserts: any[];

function respond(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as any);
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE = 'service-key';
  inserts = [];
  db = {
    events: { [EVENT]: { title: 'Sunset walk', start_time: '2026-10-11T18:00:00Z', end_time: '2026-10-11T19:00:00Z' } },
    sessions: { [SESSION]: { status: 'scheduled', starts_at: '2026-10-10T12:00:00Z', ends_at: null, session_title: 'Breathwork', room_id: ROOM } },
    rooms: { [ROOM]: { access_level: 'public', title: 'Calm room' } },
    posts: [],
  };
  (global as any).fetch = jest.fn((url: string, init?: any) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const q = u.searchParams;
    const eqId = (q.get('id') || '').replace(/^eq\./, '');
    if (init?.method === 'POST' && table === 'profile_posts') {
      const body = JSON.parse(init.body);
      inserts.push(body);
      if (db.insertError) return respond(db.insertError.status, db.insertError.body);
      const row = { id: `post-${inserts.length}`, user_id: body.user_id, attached_ref_id: body.attached_ref_id, created_at: NOW.toISOString(), body };
      db.posts.push(row);
      return respond(201, [{ id: row.id }]);
    }
    if (table === 'global_community_events') return respond(200, db.events[eqId] ? [db.events[eqId]] : []);
    if (table === 'live_room_sessions') return respond(200, db.sessions[eqId] ? [db.sessions[eqId]] : []);
    if (table === 'live_rooms') return respond(200, db.rooms[eqId] ? [db.rooms[eqId]] : []);
    if (table === 'profile_posts') {
      const user = (q.get('user_id') || '').replace(/^eq\./, '');
      let rows = db.posts.filter((p) => p.user_id === user);
      const inIds = q.get('attached_ref_id') || '';
      if (inIds.startsWith('in.(')) {
        const ids = inIds.slice(4, -1).split(',');
        rows = rows.filter((p) => p.attached_ref_id && ids.includes(p.attached_ref_id));
      } else if (inIds === 'not.is.null') {
        const since = Date.parse((q.get('created_at') || '').replace(/^gte\./, ''));
        rows = rows.filter((p) => p.attached_ref_id && Date.parse(p.created_at) >= since);
      }
      return respond(200, rows.map((p) => ({ id: p.id, attached_ref_id: p.attached_ref_id })));
    }
    return respond(404, []);
  });
});

const eventEntry = (over: Record<string, unknown> = {}) => ({
  id: 'e1', user_id: USER, status: 'confirmed', source_ref_type: 'community_event', source_ref_id: EVENT,
  start_time: '2026-10-11T18:00:00Z', end_time: '2026-10-11T19:00:00Z', metadata: { meetup_id: EVENT }, ...over,
});

describe('what can be shared (VTID-04916)', () => {
  it('community events and live room sessions, from trigger rows or legacy client rows', () => {
    expect(shareRefOf(eventEntry())).toEqual({ ref_type: 'community_event', ref_id: EVENT });
    expect(shareRefOf({ source_ref_type: null, metadata: { meetup_id: EVENT } })).toEqual({ ref_type: 'community_event', ref_id: EVENT });
    expect(shareRefOf({ source_ref_type: 'live_room_session', source_ref_id: SESSION })).toEqual({ ref_type: 'live_room_session', ref_id: SESSION });
  });

  it('never health plans, lab orders, appointments, plans, journeys, Autopilot or private entries', () => {
    for (const source_ref_type of ['health_plan', 'lab_test_order', 'provider_appointment', 'goal_plan_step', 'journey', 'autopilot_recommendation', null]) {
      expect(shareRefOf({ source_ref_type, source_ref_id: EVENT, metadata: {} })).toBeNull();
    }
    expect(shareRefOf({ source_ref_type: 'community_event', source_ref_id: 'not-a-uuid' })).toBeNull();
  });

  it('isShareableEntry: not cancelled, not over', () => {
    expect(isShareableEntry(eventEntry(), NOW)).toBe(true);
    expect(isShareableEntry(eventEntry({ status: 'cancelled' }), NOW)).toBe(false);
    expect(isShareableEntry(eventEntry({ end_time: '2026-10-10T09:00:00Z' }), NOW)).toBe(false);
    expect(isShareableEntry(eventEntry({ source_ref_type: 'health_plan', metadata: {} }), NOW)).toBe(false);
  });
});

describe('sharing (VTID-04916)', () => {
  it('posts as the verified caller with the attached event, public by default', async () => {
    const r = await shareCalendarEntryToFeed(USER, eventEntry(), { text: '  I am going!  ' }, NOW);
    expect(r).toEqual({ ok: true, post_id: 'post-1', ref: { ref_type: 'community_event', ref_id: EVENT } });
    expect(inserts).toEqual([{ user_id: USER, content: 'I am going!', is_public: true, attached_ref_type: 'community_event', attached_ref_id: EVENT }]);
  });

  it('a card-only share is allowed (empty text), and is_public=false is kept', async () => {
    const r = await shareCalendarEntryToFeed(USER, eventEntry(), { is_public: false }, NOW);
    expect(r.ok).toBe(true);
    expect(inserts[0]).toMatchObject({ content: '', is_public: false });
  });

  it("another member's entry is not found, whatever the caller claims", async () => {
    const r = await shareCalendarEntryToFeed(USER, eventEntry({ user_id: OTHER }), {}, NOW);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(inserts).toHaveLength(0);
    const none = await shareCalendarEntryToFeed(USER, null, {}, NOW);
    expect(none).toMatchObject({ ok: false, status: 404 });
  });

  it('the author can never be set from the input', async () => {
    await shareCalendarEntryToFeed(USER, eventEntry(), { text: 'hi', user_id: OTHER } as any, NOW);
    expect(inserts[0].user_id).toBe(USER);
    expect(Object.keys(inserts[0]).sort()).toEqual(['attached_ref_id', 'attached_ref_type', 'content', 'is_public', 'user_id']);
  });

  it('private entries, cancelled entries and past or missing events are refused', async () => {
    expect(await shareCalendarEntryToFeed(USER, eventEntry({ source_ref_type: 'health_plan', metadata: {} }), {}, NOW)).toMatchObject({ status: 409, reason: 'private_entry' });
    expect(await shareCalendarEntryToFeed(USER, eventEntry({ status: 'cancelled' }), {}, NOW)).toMatchObject({ status: 409, reason: 'cancelled' });
    db.events[EVENT].end_time = '2026-10-10T09:00:00Z';
    expect(await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW)).toMatchObject({ status: 409, reason: 'past' });
    delete db.events[EVENT];
    expect(await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW)).toMatchObject({ status: 409, reason: 'not_found' });
    expect(inserts).toHaveLength(0);
  });

  it('one share per event: the second answers ALREADY_SHARED with the first post id', async () => {
    await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW);
    const again = await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW);
    expect(again).toEqual({ ok: false, status: 409, error: 'ALREADY_SHARED', post_id: 'post-1' });
    expect(inserts).toHaveLength(1);
  });

  it(`at most ${SHARE_LIMIT_PER_DAY} event shares per member per day`, async () => {
    for (let i = 0; i < SHARE_LIMIT_PER_DAY; i++) {
      db.posts.push({ id: `old-${i}`, user_id: USER, attached_ref_id: `66666666-6666-4666-8666-00000000000${i}`, created_at: '2026-10-10T06:00:00Z' });
    }
    const r = await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW);
    expect(r).toMatchObject({ ok: false, status: 429, error: 'SHARE_LIMIT' });
    expect(inserts).toHaveLength(0);
    db.posts = db.posts.map((p) => ({ ...p, created_at: '2026-10-09T06:00:00Z' }));
    expect((await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW)).ok).toBe(true);
  });

  it('maps the database guards: unique race, hourly post limit, suspension', async () => {
    db.insertError = { status: 409, body: '{"code":"23505","message":"duplicate key"}' };
    expect(await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW)).toMatchObject({ status: 409, error: 'ALREADY_SHARED' });
    // The duplicate-content guard shares the 23505 code; it is not an earlier share.
    db.insertError = { status: 409, body: '{"code":"23505","message":"duplicate_post_suppressed","hint":"duplicate_post"}' };
    expect(await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW)).toMatchObject({ status: 409, error: 'DUPLICATE_POST' });
    db.insertError = { status: 400, body: '{"code":"P0001","message":"RATE_LIMITED"}' };
    expect(await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW)).toMatchObject({ status: 429, error: 'RATE_LIMITED' });
    db.insertError = { status: 400, body: '{"code":"P0001","message":"USER_SUSPENDED"}' };
    expect(await shareCalendarEntryToFeed(USER, eventEntry(), {}, NOW)).toMatchObject({ status: 403, error: 'USER_SUSPENDED' });
  });
});

describe('live room sessions (VTID-04916)', () => {
  const ref = { ref_type: 'live_room_session' as const, ref_id: SESSION };
  it('a scheduled session in a public room can be shared', async () => {
    expect(await checkShareTarget(ref, NOW)).toEqual({ ok: true, title: 'Breathwork' });
  });
  it('cancelled, ended, past or non-public sessions cannot', async () => {
    db.sessions[SESSION].status = 'cancelled';
    expect(await checkShareTarget(ref, NOW)).toEqual({ ok: false, reason: 'cancelled' });
    db.sessions[SESSION].status = 'ended';
    expect(await checkShareTarget(ref, NOW)).toEqual({ ok: false, reason: 'past' });
    db.sessions[SESSION] = { ...db.sessions[SESSION], status: 'scheduled', starts_at: '2026-10-10T07:00:00Z', ends_at: '2026-10-10T08:00:00Z' };
    expect(await checkShareTarget(ref, NOW)).toEqual({ ok: false, reason: 'past' });
    db.sessions[SESSION] = { ...db.sessions[SESSION], starts_at: '2026-10-10T12:00:00Z', ends_at: null };
    db.rooms[ROOM].access_level = 'private';
    expect(await checkShareTarget(ref, NOW)).toEqual({ ok: false, reason: 'not_public' });
  });
});

describe('POST /api/v1/calendar/events/:id/share-to-feed (VTID-04916)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require('supertest');
  let shareCalls: any[];
  let oasis: jest.Mock;
  let windowItems: any[];
  let sharedLookup: (uid: string, ids: string[]) => Promise<Map<string, string>>;

  function app(identity: Record<string, unknown> | null, result: any = { ok: true, post_id: 'p1', ref: { ref_type: 'community_event', ref_id: EVENT } }) {
    jest.resetModules();
    shareCalls = [];
    oasis = jest.fn(async () => undefined);
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      optionalAuth: (req: any, _res: any, next: any) => { if (identity) req.identity = identity; next(); },
    }));
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: oasis }));
    jest.doMock('../src/lib/supabase', () => ({ getSupabase: () => null }));
    jest.doMock('../src/routes/calendar-repository', () => ({}));
    jest.doMock('../src/services/calendar-service', () => ({
      ...jest.requireActual('../src/services/calendar-service'),
      getOwnCalendarEvent: jest.fn(async (id: string, uid: string) => (id === 'e1' ? eventEntry({ user_id: uid }) : null)),
      listCalendarWindow: jest.fn(async () => windowItems),
    }));
    jest.doMock('../src/services/calendar-share', () => ({
      ...jest.requireActual('../src/services/calendar-share'),
      shareCalendarEntryToFeed: jest.fn(async (...args: any[]) => { shareCalls.push(args); return result; }),
      listSharedPostIds: jest.fn((uid: string, ids: string[]) => sharedLookup(uid, ids)),
    }));
    const router = require('../src/routes/calendar').default;
    const a = express();
    a.use(express.json());
    a.use('/api/v1/calendar', router);
    return a;
  }

  it('401 without a verified identity', async () => {
    const res = await request(app(null)).post('/api/v1/calendar/events/e1/share-to-feed').send({});
    expect(res.status).toBe(401);
  });

  it('rejects any field besides text and is_public — no author in the body', async () => {
    const res = await request(app({ user_id: USER })).post('/api/v1/calendar/events/e1/share-to-feed').send({ text: 'x', user_id: OTHER });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_BODY');
    expect(shareCalls).toHaveLength(0);
  });

  it('shares as the verified caller and returns the post id', async () => {
    const res = await request(app({ user_id: USER })).post('/api/v1/calendar/events/e1/share-to-feed').send({ text: 'Join me', is_public: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { post_id: 'p1' } });
    expect(shareCalls[0][0]).toBe(USER);
    expect(shareCalls[0][1]).toMatchObject({ id: 'e1', user_id: USER });
    expect(shareCalls[0][2]).toEqual({ text: 'Join me', is_public: true });
    expect(oasis).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-04916',
      type: 'calendar.shared_to_feed',
      payload: expect.objectContaining({ user_id: USER, entry_id: 'e1', post_id: 'p1', ref_type: 'community_event', ref_id: EVENT }),
    }));
  });

  it('passes the service status, error, reason and existing post id through', async () => {
    const res = await request(app({ user_id: USER }, { ok: false, status: 409, error: 'ALREADY_SHARED', post_id: 'p0' }))
      .post('/api/v1/calendar/events/e1/share-to-feed').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'ALREADY_SHARED', post_id: 'p0' });
    expect(oasis).not.toHaveBeenCalled();
  });

  const WINDOW = '/api/v1/calendar/events/window?from=2026-10-08T00:00:00Z&to=2026-10-20T00:00:00Z&include_busy=false';
  function windowFixture() {
    const future = { start_time: '2099-10-10T10:00:00Z', end_time: '2099-10-10T11:00:00Z' };
    const row = (id: string, event: any) => ({ id, event_id: id, start_time: future.start_time, end_time: future.end_time, busy: false, occurrence_index: null, event });
    return [
      row('a', eventEntry({ id: 'a', ...future })),
      row('b', eventEntry({ id: 'b', ...future, source_ref_id: OTHER_EVENT })),
      row('c', eventEntry({ id: 'c', ...future, source_ref_type: 'health_plan', source_ref_id: null, metadata: {} })),
      { id: 'busy', event_id: 'busy', start_time: future.start_time, end_time: future.end_time, busy: true, occurrence_index: null, event: null },
    ];
  }

  it('the window marks shareable entries and links ones already shared', async () => {
    windowItems = windowFixture();
    sharedLookup = async (uid, ids) => {
      expect(uid).toBe(USER);
      expect(ids.sort()).toEqual([EVENT, OTHER_EVENT].sort());
      return new Map([[OTHER_EVENT, 'p9']]);
    };
    const res = await request(app({ user_id: USER })).get(WINDOW);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.map((it: any) => [it.id, it]));
    expect(byId.a).toMatchObject({ shareable: true, shared_post_id: null });
    expect(byId.b).toMatchObject({ shareable: true, shared_post_id: 'p9' });
    expect(byId.c).toMatchObject({ shareable: false, shared_post_id: null });
    expect(byId.busy.shareable).toBeUndefined();
  });

  it('a failing shared-post lookup never breaks the window', async () => {
    windowItems = windowFixture();
    sharedLookup = async () => { throw new Error('postgrest down'); };
    const res = await request(app({ user_id: USER })).get(WINDOW);
    expect(res.status).toBe(200);
    expect(res.body.data.find((it: any) => it.id === 'b')).toMatchObject({ shareable: true, shared_post_id: null });
  });
});
