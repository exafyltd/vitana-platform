/**
 * VTID-04436 — Vitanaland entries pushed into the member's Outlook and
 * iPhone (iCloud) calendars.
 *
 * Pins the pure mapping (Graph event + recurrence, iCalendar), the plan
 * (create / update / delete from hashes), the Outlook and iCloud writers
 * against scripted Graph / CalDAV / PostgREST, the busy pull skipping the
 * Vitanaland calendar, the hub wiring, and the migration.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const push = jest.requireActual('../src/services/connected-apps/calendar-push');

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  title: 'Morning walk',
  description: null,
  start_time: '2026-10-05T05:30:00.000Z', // 07:30 in Berlin (CEST)
  end_time: '2026-10-05T06:00:00.000Z',
  rrule: null,
  timezone: 'Europe/Berlin',
  status: 'scheduled',
  role_context: 'community',
  emoji: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe('Outlook mapping', () => {
  it('a single entry is written in UTC, with no reminder of its own and shown as busy', () => {
    const b = push.toGraphEvent(entry({ emoji: '🚶', description: 'Around the lake' }), 'UTC');
    expect(b).toEqual({
      subject: '🚶 Morning walk',
      body: { contentType: 'text', content: 'Around the lake' },
      start: { dateTime: '2026-10-05T05:30:00', timeZone: 'UTC' },
      end: { dateTime: '2026-10-05T06:00:00', timeZone: 'UTC' },
      isReminderOn: false,
      showAs: 'busy',
    });
  });

  it('a repeating entry keeps its own zone and wall-clock time', () => {
    const b = push.toGraphEvent(entry({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' }), 'UTC');
    expect(b.start).toEqual({ dateTime: '2026-10-05T07:30:00', timeZone: 'Europe/Berlin' });
    expect(b.recurrence).toEqual({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'monday' },
      range: { type: 'noEnd', startDate: '2026-10-05', recurrenceTimeZone: 'Europe/Berlin' },
    });
  });

  it('covers every rule shape the app writes', () => {
    const start = Date.parse('2026-10-05T05:30:00Z');
    expect(push.toGraphRecurrence('FREQ=DAILY;INTERVAL=2;COUNT=10', start, 'Europe/Berlin')).toEqual({
      pattern: { type: 'daily', interval: 2 },
      range: { type: 'numbered', startDate: '2026-10-05', numberOfOccurrences: 10, recurrenceTimeZone: 'Europe/Berlin' },
    });
    expect(push.toGraphRecurrence('FREQ=WEEKLY', start, 'Europe/Berlin').pattern.daysOfWeek).toEqual(['monday']);
    expect(push.toGraphRecurrence('FREQ=MONTHLY;UNTIL=20270101T000000Z', start, 'Europe/Berlin')).toEqual({
      pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 5 },
      range: { type: 'endDate', startDate: '2026-10-05', endDate: '2027-01-01', recurrenceTimeZone: 'Europe/Berlin' },
    });
    expect(push.toGraphRecurrence('FREQ=YEARLY', start, 'UTC')).toBeNull();
  });

  it('an entry without an end gets 30 minutes', () => {
    const b = push.toGraphEvent(entry({ end_time: null }), 'UTC');
    expect(b.end.dateTime).toBe('2026-10-05T06:00:00');
  });
});

describe('iCloud mapping', () => {
  it('a single entry is a UTC VEVENT with a stable UID and escaped text', () => {
    const ics = push.toIcs(entry({ title: 'Walk; then, coffee', description: 'Line 1\nLine 2' }), 'UTC', '20260924T090000Z');
    expect(ics).toContain('UID:vitanaland-e1@vitanaland.com\r\n');
    expect(ics).toContain('DTSTART:20261005T053000Z\r\n');
    expect(ics).toContain('DTEND:20261005T060000Z\r\n');
    expect(ics).toContain('SUMMARY:Walk\\; then\\, coffee\r\n');
    expect(ics).toContain('DESCRIPTION:Line 1\\nLine 2\r\n');
    expect(ics).not.toContain('VALARM'); // Vitanaland already reminds
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('a repeating entry carries the rule unchanged and its local time with TZID', () => {
    const ics = push.toIcs(entry({ rrule: 'FREQ=DAILY;COUNT=5' }), 'UTC', '20260924T090000Z');
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20261005T073000\r\n');
    expect(ics).toContain('RRULE:FREQ=DAILY;COUNT=5\r\n');
  });

  it('folds long lines at 75 octets without splitting a character', () => {
    const folded = push.icsFold(`SUMMARY:${'ü'.repeat(60)}`);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'ü'.repeat(60)}`);
  });

  it('the hash ignores DTSTAMP, so an unchanged entry is not rewritten every sync', () => {
    const a = push.renderIcs(entry(), 'UTC', Date.parse('2026-09-24T09:00:00Z'));
    const b = push.renderIcs(entry(), 'UTC', Date.parse('2026-09-25T09:00:00Z'));
    expect(a.hash).toBe(b.hash);
    expect(a.body).not.toBe(b.body);
    expect(push.renderIcs(entry({ title: 'Run' }), 'UTC', 0).hash).not.toBe(a.hash);
  });
});

describe('planExternalPush', () => {
  const render = (e: any) => push.renderGraph(e, 'UTC');

  it('creates new, updates changed, leaves unchanged, deletes gone and no-longer-pushed', () => {
    const same = entry({ id: 'same' });
    const changed = entry({ id: 'changed', title: 'New title' });
    const admin = entry({ id: 'admin', role_context: 'admin' });
    const cancelled = entry({ id: 'cxl', status: 'cancelled' });
    const links = [
      { id: 'l-same', calendar_event_id: 'same', remote_id: 'r-same', pushed_hash: render(same).hash },
      { id: 'l-changed', calendar_event_id: 'changed', remote_id: 'r-changed', pushed_hash: 'old' },
      { id: 'l-gone', calendar_event_id: null, remote_id: 'r-gone', pushed_hash: 'x' },
      { id: 'l-cxl', calendar_event_id: 'cxl', remote_id: 'r-cxl', pushed_hash: 'x' },
    ];
    const ops = push.planExternalPush([same, changed, admin, cancelled, entry({ id: 'new' })], links, render);
    expect(ops.map((o: any) => [o.op, o.entryId ?? o.remoteId])).toEqual([
      ['delete', 'r-gone'],
      ['update', 'changed'],
      ['delete', 'r-cxl'],
      ['create', 'new'],
    ]);
  });

  it('an entry the provider cannot represent is not created (and a stale copy is removed)', () => {
    const odd = entry({ id: 'odd', rrule: 'FREQ=YEARLY' });
    expect(push.planExternalPush([odd], [], render)).toEqual([]);
    const ops = push.planExternalPush([odd], [{ id: 'l', calendar_event_id: 'odd', remote_id: 'r', pushed_hash: 'h' }], render);
    expect(ops).toEqual([{ op: 'delete', linkId: 'l', remoteId: 'r' }]);
  });
});

// ---------------------------------------------------------------------------
// Writers against scripted services
// ---------------------------------------------------------------------------

interface Call { method: string; url: string; body: any; headers: Record<string, string> }

function harness(tables: Record<string, any[]>, remote: (c: Call) => { status: number; json?: any } | null) {
  const calls: Call[] = [];
  const fetchMock = jest.fn(async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    let body: any = init.body;
    try { body = body ? JSON.parse(body) : undefined; } catch { /* ics / xml */ }
    const call = { method, url: String(url), body, headers: init.headers ?? {} };
    calls.push(call);
    if (String(url).startsWith('https://db.test/')) {
      const table = String(url).split('/rest/v1/')[1]?.split('?')[0] ?? '';
      const payload = method === 'GET' ? tables[table] ?? [] : null;
      return { ok: true, status: 200, text: async () => (payload ? JSON.stringify(payload) : ''), json: async () => payload } as any;
    }
    const r = remote(call) ?? { status: 200, json: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      text: async () => '',
      json: async () => r.json ?? {},
    } as any;
  });
  return { calls, fetchMock };
}

describe('writers', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = global.fetch;
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'service-role-secret';
    jest.resetModules();
    jest.doMock('../src/services/daily-pace-service', () => ({ getUserTimezone: jest.fn(async () => 'Europe/Berlin') }));
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.dontMock('../src/services/daily-pace-service');
    jest.dontMock('../src/services/oasis-event-service');
  });

  it('Outlook: creates the Vitanaland calendar once, then writes only into it', async () => {
    const { calls, fetchMock } = harness(
      { calendar_push_targets: [], calendar_push_links: [], calendar_events: [entry()] },
      (c) => {
        if (c.url.endsWith('/me/calendars') && c.method === 'POST') return { status: 201, json: { id: 'cal-v' } };
        if (c.url.includes('/me/calendars/cal-v/events')) return { status: 201, json: { id: 'ev-1' } };
        return null;
      },
    );
    global.fetch = fetchMock as any;
    const p = require('../src/services/connected-apps/calendar-push');
    const r = await p.pushOutlook('u1', 'ms-token', Date.parse('2026-09-24T09:00:00Z'));
    expect(r).toMatchObject({ created: 1, updated: 0, deleted: 0, calendar: 'cal-v' });

    const mk = calls.find((c) => c.url === 'https://graph.microsoft.com/v1.0/me/calendars')!;
    expect(mk.body).toEqual({ name: 'Vitanaland' });
    const target = calls.find((c) => c.method === 'POST' && c.url.includes('calendar_push_targets'))!;
    expect(target.body).toMatchObject({ user_id: 'u1', provider: 'microsoft', remote_calendar_id: 'cal-v' });
    const ev = calls.find((c) => c.url.includes('/me/calendars/cal-v/events'))!;
    expect(ev.body).toMatchObject({ subject: 'Morning walk', isReminderOn: false });
    const link = calls.find((c) => c.method === 'POST' && c.url.includes('calendar_push_links'))!;
    expect(link.body).toMatchObject({ user_id: 'u1', provider: 'microsoft', calendar_event_id: 'e1', remote_id: 'ev-1' });
    // Nothing ever touches another calendar.
    const graphWrites = calls.filter((c) => c.url.startsWith('https://graph') && c.method !== 'GET');
    expect(graphWrites.every((c) => c.url.endsWith('/me/calendars') || c.url.includes('/me/calendars/cal-v/'))).toBe(true);
  });

  it('Outlook: an existing Vitanaland calendar (earlier connection) is reused, not duplicated', async () => {
    const { calls, fetchMock } = harness(
      { calendar_push_targets: [], calendar_push_links: [], calendar_events: [] },
      (c) => {
        if (c.url.endsWith('/me/calendars') && c.method === 'POST') return { status: 409, json: { error: { code: 'ErrorFolderExists' } } };
        if (c.method === 'GET' && c.url.includes('/me/calendars?')) return { status: 200, json: { value: [{ id: 'cal-old', name: 'Vitanaland' }] } };
        return null;
      },
    );
    global.fetch = fetchMock as any;
    const p = require('../src/services/connected-apps/calendar-push');
    const r = await p.pushOutlook('u1', 'ms-token', Date.parse('2026-09-24T09:00:00Z'));
    expect(r.calendar).toBe('cal-old');
    expect(calls.filter((c) => c.url.endsWith('/me/calendars') && c.method === 'POST')).toHaveLength(1);
  });

  it('Outlook: the member deleted the Vitanaland calendar → forget it and say so; next sync recreates', async () => {
    const { calls, fetchMock } = harness(
      { calendar_push_targets: [{ remote_calendar_id: 'cal-v' }], calendar_push_links: [], calendar_events: [entry()] },
      (c) => (c.url.includes('/me/calendars/cal-v/events') ? { status: 404, json: {} } : null),
    );
    global.fetch = fetchMock as any;
    const p = require('../src/services/connected-apps/calendar-push');
    await expect(p.pushOutlook('u1', 'ms-token', Date.parse('2026-09-24T09:00:00Z'))).rejects.toThrow('vitanaland_calendar_missing');
    const reset = calls.filter((c) => c.method === 'POST' && c.url.includes('calendar_push_targets')).pop()!;
    expect(reset.body).toMatchObject({ provider: 'microsoft', remote_calendar_id: null });
  });

  it('Outlook: an entry deleted in Vitanaland is deleted from Outlook, and a 404 there is fine', async () => {
    const { calls, fetchMock } = harness(
      {
        calendar_push_targets: [{ remote_calendar_id: 'cal-v' }],
        calendar_push_links: [{ id: 'l1', calendar_event_id: null, remote_id: 'ev-gone', pushed_hash: 'h' }],
        calendar_events: [],
      },
      (c) => (c.method === 'DELETE' ? { status: 404 } : null),
    );
    global.fetch = fetchMock as any;
    const p = require('../src/services/connected-apps/calendar-push');
    const r = await p.pushOutlook('u1', 'ms-token', Date.parse('2026-09-24T09:00:00Z'));
    expect(r.deleted).toBe(1);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/me/events/ev-gone'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('calendar_push_links?id=eq.l1'))).toBe(true);
  });

  it('iCloud: MKCALENDAR a Vitanaland collection under the calendar home, then PUT one .ics per entry', async () => {
    const { calls, fetchMock } = harness(
      { calendar_push_targets: [], calendar_push_links: [], calendar_events: [entry()] },
      (c) => (c.method === 'MKCALENDAR' ? { status: 201 } : c.method === 'PUT' ? { status: 201 } : null),
    );
    global.fetch = fetchMock as any;
    const p = require('../src/services/connected-apps/calendar-push');
    const creds = { appleId: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop' };
    const r = await p.pushApple('u1', creds, 'https://p1-caldav.icloud.com/123/calendars/', Date.parse('2026-09-24T09:00:00Z'));
    expect(r).toMatchObject({ created: 1, calendar: 'https://p1-caldav.icloud.com/123/calendars/vitanaland/' });
    const mk = calls.find((c) => c.method === 'MKCALENDAR')!;
    expect(mk.url).toBe('https://p1-caldav.icloud.com/123/calendars/vitanaland/');
    expect(String(mk.body)).toContain('<d:displayname>Vitanaland</d:displayname>');
    expect(mk.headers.Authorization).toBe(`Basic ${Buffer.from('me@icloud.com:abcd-efgh-ijkl-mnop').toString('base64')}`);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('https://p1-caldav.icloud.com/123/calendars/vitanaland/vitanaland-e1.ics');
    expect(put.headers['Content-Type']).toBe('text/calendar; charset=utf-8');
    expect(String(put.body)).toContain('SUMMARY:Morning walk');
    const link = calls.find((c) => c.method === 'POST' && c.url.includes('calendar_push_links'))!;
    expect(link.body).toMatchObject({ provider: 'apple', remote_id: put.url });
  });

  it('iCloud: an existing collection (405 on MKCALENDAR) is reused', async () => {
    const { fetchMock } = harness(
      { calendar_push_targets: [], calendar_push_links: [], calendar_events: [] },
      (c) => (c.method === 'MKCALENDAR' ? { status: 405 } : null),
    );
    global.fetch = fetchMock as any;
    const p = require('../src/services/connected-apps/calendar-push');
    const r = await p.pushApple('u1', { appleId: 'a@b.c', password: 'x' }, 'https://h.test/1/calendars', 0);
    expect(r.calendar).toBe('https://h.test/1/calendars/vitanaland/');
  });

  it('iCloud: a revoked app-specific password surfaces as AppleAuthError', async () => {
    const { fetchMock } = harness(
      { calendar_push_targets: [], calendar_push_links: [], calendar_events: [] },
      () => ({ status: 401 }),
    );
    global.fetch = fetchMock as any;
    const p = require('../src/services/connected-apps/calendar-push');
    const dav = require('../src/services/connected-apps/apple-dav');
    await expect(p.pushApple('u1', { appleId: 'a@b.c', password: 'x' }, 'https://h.test/1/', 0)).rejects.toBeInstanceOf(dav.AppleAuthError);
  });
});

// ---------------------------------------------------------------------------
// Pull skips what was pushed
// ---------------------------------------------------------------------------

describe('busy pull skips the Vitanaland calendar', () => {
  let realFetch: typeof fetch;
  beforeEach(() => { realFetch = global.fetch; });
  afterEach(() => { global.fetch = realFetch; });

  it('Outlook: pushed events (and occurrences of a pushed series) are not busy blocks', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ value: [
        { id: 'ev-1', showAs: 'busy', start: { dateTime: '2026-09-24T09:00:00' }, end: { dateTime: '2026-09-24T10:00:00' } },
        { id: 'occ-7', seriesMasterId: 'ev-2', showAs: 'busy', start: { dateTime: '2026-09-24T11:00:00' }, end: { dateTime: '2026-09-24T12:00:00' } },
        { id: 'theirs', showAs: 'busy', start: { dateTime: '2026-09-24T13:00:00' }, end: { dateTime: '2026-09-24T14:00:00' } },
      ] }),
    })) as any;
    const { listOutlookBusy } = jest.requireActual('../src/connectors/productivity/microsoft');
    const r = await listOutlookBusy('t', 'a', 'b', new Set(['ev-1', 'ev-2']));
    expect(r).toEqual({ ok: true, busy: [{ start_time: '2026-09-24T13:00:00.000Z', end_time: '2026-09-24T14:00:00.000Z' }] });
  });

  it('iCloud: the Vitanaland collection is never queried for busy times', async () => {
    const queried: string[] = [];
    global.fetch = jest.fn(async (url: string, init: any) => {
      if (init.method === 'PROPFIND') {
        const cal = (p: string) => `<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>`;
        return { ok: true, status: 207, text: async () => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${cal('/1/calendars/home/')}${cal('/1/calendars/vitanaland/')}</d:multistatus>` } as any;
      }
      queried.push(String(url));
      return { ok: true, status: 207, text: async () => '<d:multistatus xmlns:d="DAV:"/>' } as any;
    }) as any;
    const dav = jest.requireActual('../src/services/connected-apps/apple-dav');
    await dav.listAppleEvents({ appleId: 'a', password: 'b' }, 'https://h.test/1/calendars/', '2026-09-24T00:00:00Z', '2026-10-24T00:00:00Z', ['https://h.test/1/calendars/vitanaland']);
    expect(queried).toEqual(['https://h.test/1/calendars/home/']);
  });
});

// ---------------------------------------------------------------------------
// Hub wiring, kill switch, migration
// ---------------------------------------------------------------------------

describe('wiring', () => {
  const hubSrc = fs.readFileSync(path.join(__dirname, '../src/services/connected-apps/hub.ts'), 'utf8');

  it('the Outlook and iCloud calendar syncs push first, then pull without their own calendar', () => {
    expect(hubSrc).toMatch(/pushOutlook\(userId, token, now\)[\s\S]*listOutlookBusy\([\s\S]*?pushed\?\.pushed_ids\)/);
    expect(hubSrc).toMatch(/pushApple\([\s\S]*listAppleEvents\([\s\S]*pushed \? \[pushed\.calendar\] : \[\]/);
  });

  it('turning a calendar app off forgets the push state for that provider', () => {
    expect(hubSrc).toMatch(/forgetPush\(userId, provider\)/);
  });

  it('CONNECTED_APPS_CALENDAR_PUSH=false is the kill switch; anything else is on', () => {
    expect(push.calendarPushEnabled({ CONNECTED_APPS_CALENDAR_PUSH: 'false' })).toBe(false);
    expect(push.calendarPushEnabled({})).toBe(true);
  });
});

describe('migration', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260924090000_vtid_04436_calendar_push.sql'), 'utf8');

  it('two service-role-only tables, one link per provider per entry', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.calendar_push_targets/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.calendar_push_links/);
    expect(sql).toMatch(/UNIQUE \(provider, calendar_event_id\)/);
    expect(sql).toMatch(/ON DELETE SET NULL/);
    expect(sql).toMatch(/REVOKE ALL ON public\.calendar_push_targets FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON public\.calendar_push_links\s+FROM PUBLIC, anon, authenticated/);
  });
});
