/**
 * VTID-05126 — share any of my upcoming calendar entries (feed + chat).
 *
 * Owner decision 2026-10-12: a member can share any of their own upcoming
 * entries — business, private, medical, reminder, imported, Autopilot,
 * whatever its source. Pins, against the real services over a fake PostgREST:
 *   - the rule matrix over every CALENDAR_SOURCE_TYPES value (own + upcoming
 *     → yes; cancelled / done / ended / series → no);
 *   - an entry with a community event or live room is still shared AS that
 *     event (never `calendar_entry`), so the one-share-per-event index holds;
 *   - a `calendar_entry` post carries a snapshot of exactly title, times,
 *     emoji, status and — only on request — the place; never description,
 *     metadata or any other field; the member may rename it for the card;
 *   - the invite card follows the same choices;
 *   - "In meinen Kalender": public calendar_entry posts only, never the
 *     author's own, re-reads the current card, refuses cancelled / finished,
 *     copies only the card, idempotent by (viewer, feed_post, post id);
 *   - health entries are flagged sensitive.
 */
jest.mock('../src/services/calendar-producers', () => ({
  upsertCalendarEntryFromSource: jest.fn(),
  cancelCalendarEntriesForSource: jest.fn(),
}));

import { upsertCalendarEntryFromSource } from '../src/services/calendar-producers';
import {
  addSharedEntryToCalendar,
  entryShareRefOf,
  entrySnapshot,
  isSensitiveEntry,
  isShareableEntry,
  shareCalendarEntryToFeed,
  CARD_TITLE_MAX,
} from '../src/services/calendar-share';
import { buildInviteFromEntry } from '../src/services/calendar-invite';
import { CALENDAR_SOURCE_TYPES } from '../src/types/calendar';

const USER = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const ENTRY = '33333333-3333-4333-8333-333333333333';
const EVENT = '44444444-4444-4444-8444-444444444444';
const POST = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-12T10:00:00Z');

let inserts: any[];
let posts: any[];

function respond(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any);
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE = 'service-key';
  inserts = [];
  posts = [];
  (upsertCalendarEntryFromSource as jest.Mock).mockReset().mockResolvedValue({ action: 'created', event: { id: 'copy-1' } });
  (global as any).fetch = jest.fn((url: string, init?: any) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const q = u.searchParams;
    if (init?.method === 'POST' && table === 'profile_posts') {
      const body = JSON.parse(init.body);
      inserts.push(body);
      return respond(201, [{ id: `post-${inserts.length}` }]);
    }
    if (table === 'global_community_events') {
      return respond(200, [{ title: 'Sunset walk', start_time: '2026-10-13T18:00:00Z', end_time: '2026-10-13T19:00:00Z' }]);
    }
    if (table === 'profile_posts') {
      const id = (q.get('id') || '').replace(/^eq\./, '');
      if (id) return respond(200, posts.filter((p) => p.id === id));
      return respond(200, []);
    }
    return respond(404, []);
  });
});

const own = (over: Record<string, unknown> = {}) => ({
  id: ENTRY,
  user_id: USER,
  title: 'Erinnerung: Geburtstag von Maria Maksina',
  description: 'Geschenk: Buch. Diagnose-Notiz: privat',
  location: 'Bei Maria, Hauptstr. 5',
  emoji: '🎂',
  status: 'confirmed',
  source_type: 'reminder',
  source_ref_type: 'reminder',
  source_ref_id: 'rem-1',
  start_time: '2026-11-04T00:00:00Z',
  end_time: '2026-11-04T00:15:00Z',
  rrule: null,
  completed_at: null,
  completion_status: null,
  metadata: { secret: 'never copied' },
  wellness_tags: ['cardio'],
  ...over,
});

describe('which own entries can be shared and invited to (VTID-05126)', () => {
  it('every source type, while upcoming', () => {
    for (const source_type of CALENDAR_SOURCE_TYPES) {
      expect(isShareableEntry(own({ source_type, source_ref_type: source_type }), NOW)).toBe(true);
    }
  });

  it('never cancelled, done, ended or a series', () => {
    expect(isShareableEntry(own({ status: 'cancelled' }), NOW)).toBe(false);
    expect(isShareableEntry(own({ completed_at: '2026-10-11T10:00:00Z' }), NOW)).toBe(false);
    expect(isShareableEntry(own({ completion_status: 'completed' }), NOW)).toBe(false);
    expect(isShareableEntry(own({ start_time: '2026-10-12T08:00:00Z', end_time: '2026-10-12T09:00:00Z' }), NOW)).toBe(false);
    expect(isShareableEntry(own({ rrule: 'FREQ=WEEKLY' }), NOW)).toBe(false);
  });

  it('an entry with a community event is shared as the event, never as calendar_entry', () => {
    expect(entryShareRefOf(own({ source_ref_type: 'community_event', source_ref_id: EVENT }))).toEqual({ ref_type: 'community_event', ref_id: EVENT });
    expect(entryShareRefOf(own({ source_ref_type: 'live_room_session', source_ref_id: EVENT }))).toEqual({ ref_type: 'live_room_session', ref_id: EVENT });
    expect(entryShareRefOf(own({ source_ref_type: null, metadata: { meetup_id: EVENT } }))).toEqual({ ref_type: 'community_event', ref_id: EVENT });
    expect(entryShareRefOf(own())).toEqual({ ref_type: 'calendar_entry', ref_id: ENTRY });
  });

  it('health sources are sensitive', () => {
    for (const source_type of ['health_plan', 'lab_order', 'appointment', 'test_result']) expect(isSensitiveEntry(own({ source_type }))).toBe(true);
    for (const source_type of ['manual', 'reminder', 'autopilot', 'community_rsvp']) expect(isSensitiveEntry(own({ source_type }))).toBe(false);
  });
});

describe('the card others see (VTID-05126)', () => {
  it('the snapshot holds only title, times, emoji, status — and the place only on request', () => {
    const snap = entrySnapshot(own());
    expect(Object.keys(snap).sort()).toEqual(['emoji', 'end_time', 'location', 'start_time', 'status', 'title']);
    expect(snap).toEqual({
      title: 'Erinnerung: Geburtstag von Maria Maksina', start_time: '2026-11-04T00:00:00Z', end_time: '2026-11-04T00:15:00Z',
      location: null, emoji: '🎂', status: 'confirmed',
    });
    expect(JSON.stringify(snap)).not.toMatch(/Geschenk|Diagnose|secret|cardio|reminder/);
    expect(entrySnapshot(own(), { include_location: true }).location).toBe('Bei Maria, Hauptstr. 5');
  });

  it('the member may rename it (trimmed, capped); an empty name falls back to the entry title', () => {
    expect(entrySnapshot(own(), { card_title: '  Marias Geburtstag  ' }).title).toBe('Marias Geburtstag');
    expect(entrySnapshot(own(), { card_title: '   ' }).title).toBe('Erinnerung: Geburtstag von Maria Maksina');
    expect(entrySnapshot(own(), { card_title: 'x'.repeat(300) }).title).toHaveLength(CARD_TITLE_MAX);
  });
});

describe('sharing an own entry to the feed (VTID-05126)', () => {
  it('posts a calendar_entry with the snapshot as the verified caller', async () => {
    const r = await shareCalendarEntryToFeed(USER, own(), { text: 'Wer ist dabei?', card_title: 'Marias Geburtstag', is_public: true }, NOW);
    expect(r).toEqual({ ok: true, post_id: 'post-1', ref: { ref_type: 'calendar_entry', ref_id: ENTRY } });
    expect(inserts[0]).toEqual({
      user_id: USER, content: 'Wer ist dabei?', is_public: true, attached_ref_type: 'calendar_entry', attached_ref_id: ENTRY,
      attached_snapshot: { title: 'Marias Geburtstag', start_time: '2026-11-04T00:00:00Z', end_time: '2026-11-04T00:15:00Z', location: null, emoji: '🎂', status: 'confirmed' },
    });
  });

  it('an event entry carries no snapshot (the feed reads the live event)', async () => {
    const r = await shareCalendarEntryToFeed(USER, own({ source_ref_type: 'community_event', source_ref_id: EVENT, start_time: '2026-10-13T18:00:00Z', end_time: '2026-10-13T19:00:00Z' }), {}, NOW);
    expect(r).toMatchObject({ ok: true, ref: { ref_type: 'community_event', ref_id: EVENT } });
    expect(inserts[0]).not.toHaveProperty('attached_snapshot');
  });

  it('refuses closed entries with their reason and inserts nothing', async () => {
    expect(await shareCalendarEntryToFeed(USER, own({ status: 'cancelled' }), {}, NOW)).toMatchObject({ status: 409, error: 'NOT_SHAREABLE', reason: 'cancelled' });
    expect(await shareCalendarEntryToFeed(USER, own({ completed_at: '2026-10-11T10:00:00Z' }), {}, NOW)).toMatchObject({ reason: 'done' });
    expect(await shareCalendarEntryToFeed(USER, own({ rrule: 'FREQ=DAILY' }), {}, NOW)).toMatchObject({ reason: 'recurring' });
    expect(await shareCalendarEntryToFeed(USER, own({ end_time: '2026-10-12T09:00:00Z', start_time: '2026-10-12T08:00:00Z' }), {}, NOW)).toMatchObject({ reason: 'past' });
    expect(await shareCalendarEntryToFeed(VIEWER, own(), {}, NOW)).toMatchObject({ status: 404 });
    expect(inserts).toHaveLength(0);
  });
});

describe('inviting to an own entry (VTID-05126)', () => {
  it('any own kind; the card follows the member\'s title and place choice', async () => {
    const plain = await buildInviteFromEntry(USER, own({ source_type: 'appointment' }), NOW);
    expect(plain).toMatchObject({ ok: true, metadata: { ref_type: 'calendar_entry', ref_id: ENTRY, title: 'Erinnerung: Geburtstag von Maria Maksina', location: null } });
    const chosen = await buildInviteFromEntry(USER, own(), NOW, { card_title: 'Marias Geburtstag', include_location: true });
    expect(chosen).toMatchObject({ ok: true, metadata: { title: 'Marias Geburtstag', location: 'Bei Maria, Hauptstr. 5' }, content: '📅 Marias Geburtstag' });
  });

  it('still refuses cancelled, done, ended and series', async () => {
    for (const over of [{ status: 'cancelled' }, { completion_status: 'completed' }, { rrule: 'FREQ=WEEKLY' }, { start_time: '2026-10-12T08:00:00Z', end_time: '2026-10-12T09:00:00Z' }]) {
      expect(await buildInviteFromEntry(USER, own(over), NOW)).toMatchObject({ ok: false, error: 'NOT_INVITABLE' });
    }
  });
});

describe('"In meinen Kalender" from the feed (VTID-05126)', () => {
  const post = (over: Record<string, unknown> = {}) => ({
    id: POST, user_id: USER, is_public: true, attached_ref_type: 'calendar_entry',
    attached_snapshot: { title: 'Marias Geburtstag', start_time: '2026-11-04T00:00:00Z', end_time: '2026-11-04T00:15:00Z', location: null, emoji: '🎂', status: 'confirmed' },
    ...over,
  });

  it('copies only the card into the viewer\'s calendar, keyed by the post', async () => {
    posts.push(post());
    const r = await addSharedEntryToCalendar(VIEWER, POST, NOW);
    expect(r).toEqual({ ok: true, action: 'added', event_id: 'copy-1' });
    expect(upsertCalendarEntryFromSource).toHaveBeenCalledWith(
      VIEWER,
      { source_type: 'invite', source_ref_type: 'feed_post', source_ref_id: POST },
      expect.objectContaining({ title: 'Marias Geburtstag', start_time: '2026-11-04T00:00:00Z', location: null, emoji: '🎂', role_context: 'community' }),
    );
  });

  it('a second tap changes nothing', async () => {
    posts.push(post());
    (upsertCalendarEntryFromSource as jest.Mock).mockResolvedValueOnce({ action: 'unchanged', event: { id: 'copy-1' } });
    expect(await addSharedEntryToCalendar(VIEWER, POST, NOW)).toEqual({ ok: true, action: 'already', event_id: 'copy-1' });
  });

  it('never the author\'s own post, a private post, an event post, or a cancelled / finished entry', async () => {
    posts.push(post());
    expect(await addSharedEntryToCalendar(USER, POST, NOW)).toMatchObject({ ok: false, error: 'OWN_POST' });
    posts.length = 0; posts.push(post({ is_public: false }));
    expect(await addSharedEntryToCalendar(VIEWER, POST, NOW)).toMatchObject({ ok: false, status: 404 });
    posts.length = 0; posts.push(post({ attached_ref_type: 'community_event', attached_snapshot: null }));
    expect(await addSharedEntryToCalendar(VIEWER, POST, NOW)).toMatchObject({ ok: false, status: 404 });
    posts.length = 0; posts.push(post({ attached_snapshot: { ...post().attached_snapshot, status: 'cancelled' } }));
    expect(await addSharedEntryToCalendar(VIEWER, POST, NOW)).toMatchObject({ ok: false, error: 'NOT_OPEN' });
    posts.length = 0; posts.push(post({ attached_snapshot: { ...post().attached_snapshot, start_time: '2026-10-11T08:00:00Z', end_time: '2026-10-11T09:00:00Z' } }));
    expect(await addSharedEntryToCalendar(VIEWER, POST, NOW)).toMatchObject({ ok: false, error: 'NOT_OPEN' });
    expect(await addSharedEntryToCalendar(VIEWER, 'not-a-uuid', NOW)).toMatchObject({ ok: false, status: 404 });
    expect(upsertCalendarEntryFromSource).not.toHaveBeenCalled();
  });
});
