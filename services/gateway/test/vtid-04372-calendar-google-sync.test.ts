/**
 * VTID-04372 — Google Calendar two-way sync, built and switched off.
 *
 * Pins: the on/off gate, the event a calendar entry becomes (no Google
 * reminders, only the member's own lenses), the push plan, busy-interval
 * merging, one full sync run against a scripted Google + PostgREST, the
 * routes, busy blocks in the window read, the narrow OAuth scopes, and that
 * the migration keeps all three tables service-role only.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const ROOT = path.resolve(__dirname, '../../..');
const READY_ENV = { CALENDAR_GOOGLE_SYNC_ENABLED: 'true', GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' };

function withEnv(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

describe('pure parts', () => {
  const sync = jest.requireActual('../src/services/calendar-google-sync');

  it('is off unless the flag is exactly "true" and the Google client is configured', () => {
    expect(sync.googleSyncAvailability(READY_ENV)).toBe('ready');
    expect(sync.googleSyncAvailability({ ...READY_ENV, CALENDAR_GOOGLE_SYNC_ENABLED: 'TRUE' })).toBe('not_configured');
    expect(sync.googleSyncAvailability({ ...READY_ENV, CALENDAR_GOOGLE_SYNC_ENABLED: undefined })).toBe('not_configured');
    expect(sync.googleSyncAvailability({ ...READY_ENV, GOOGLE_OAUTH_CLIENT_SECRET: undefined })).toBe('not_configured');
  });

  const base = {
    id: 'e1', title: 'Zone-2 run', start_time: '2026-10-06T04:30:00Z', end_time: null,
    status: 'confirmed', role_context: 'community', emoji: '🏃',
  };

  it('an entry becomes a Google event with no Google reminders and a link back', () => {
    const ev = sync.toGoogleEvent(base, 'Europe/Berlin');
    expect(ev).toMatchObject({
      summary: '🏃 Zone-2 run',
      start: { dateTime: '2026-10-06T04:30:00.000Z', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-10-06T05:00:00.000Z', timeZone: 'Europe/Berlin' }, // no end → 30 min
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { vitanaland_event_id: 'e1' } },
    });
    expect(ev.recurrence).toBeUndefined();
    expect(sync.toGoogleEvent({ ...base, rrule: 'FREQ=DAILY' }, 'Europe/Berlin').recurrence).toEqual(['RRULE:FREQ=DAILY']);
    expect(sync.toGoogleEvent({ ...base, rrule: 'RRULE:FREQ=WEEKLY' }, 'UTC').recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
  });

  it('only the member’s own community / personal entries are pushed', () => {
    expect(sync.isPushable({ status: 'confirmed', role_context: 'community' })).toBe(true);
    expect(sync.isPushable({ status: 'confirmed', role_context: 'personal' })).toBe(true);
    expect(sync.isPushable({ status: 'confirmed', role_context: 'admin' })).toBe(false);
    expect(sync.isPushable({ status: 'confirmed', role_context: 'developer' })).toBe(false);
    expect(sync.isPushable({ status: 'cancelled', role_context: 'community' })).toBe(false);
  });

  it('plans create, update, no-op and delete; an entry outside the read keeps its Google copy', () => {
    const same = sync.pushHash(sync.toGoogleEvent({ ...base, id: 'keep' }, 'UTC'));
    const ops = sync.planPush(
      [
        { ...base, id: 'new' },
        { ...base, id: 'renamed', title: 'New title' },
        { ...base, id: 'keep' },
        { ...base, id: 'gone', status: 'cancelled' },
        { ...base, id: 'moved-to-admin', role_context: 'admin' },
      ],
      [
        { id: 'l-renamed', calendar_event_id: 'renamed', google_event_id: 'g-renamed', pushed_hash: 'old' },
        { id: 'l-keep', calendar_event_id: 'keep', google_event_id: 'g-keep', pushed_hash: same },
        { id: 'l-gone', calendar_event_id: 'gone', google_event_id: 'g-gone', pushed_hash: 'x' },
        { id: 'l-admin', calendar_event_id: 'moved-to-admin', google_event_id: 'g-admin', pushed_hash: 'x' },
        { id: 'l-deleted', calendar_event_id: null, google_event_id: 'g-deleted', pushed_hash: 'x' },
        { id: 'l-old', calendar_event_id: 'last-month', google_event_id: 'g-old', pushed_hash: 'x' },
      ],
      'UTC',
    );
    const summary = ops.map((o: any) => `${o.op}:${o.entryId ?? o.linkId}`).sort();
    expect(summary).toEqual(['create:new', 'delete:l-admin', 'delete:l-deleted', 'delete:l-gone', 'update:renamed'].sort());
  });

  it('merges overlapping busy intervals and drops broken ones', () => {
    expect(sync.normalizeBusy([
      { start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z' },
      { start: '2026-10-06T08:00:00Z', end: '2026-10-06T09:00:00Z' },
      { start: '2026-10-06T10:30:00Z', end: '2026-10-06T12:00:00Z' },
      { start: 'nope', end: '2026-10-06T12:00:00Z' },
      { start: '2026-10-06T13:00:00Z', end: '2026-10-06T13:00:00Z' },
    ])).toEqual([
      { start_time: '2026-10-06T08:00:00.000Z', end_time: '2026-10-06T09:00:00.000Z' },
      { start_time: '2026-10-06T10:00:00.000Z', end_time: '2026-10-06T12:00:00.000Z' },
    ]);
  });
});

describe('one sync run', () => {
  const NOW = Date.parse('2026-10-05T06:00:00Z');
  const realFetch = global.fetch;
  let calls: Array<{ url: string; method: string; body: any }>;
  let restore: () => void;
  let emit: jest.Mock;
  let sync: any;

  beforeEach(() => {
    restore = withEnv({ ...READY_ENV, SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE: 'k' });
    jest.resetModules();
    jest.doMock('../src/connectors/runtime/dispatcher', () => ({ getConnectorAccessToken: jest.fn(async () => 'g-token') }));
    jest.doMock('../src/services/daily-pace-service', () => ({ getUserTimezone: jest.fn(async () => 'Europe/Berlin') }));
    emit = jest.fn(async () => undefined);
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: emit }));
    sync = require('../src/services/calendar-google-sync');
  });
  afterEach(() => {
    restore();
    global.fetch = realFetch;
    jest.dontMock('../src/connectors/runtime/dispatcher');
    jest.dontMock('../src/services/daily-pace-service');
    jest.dontMock('../src/services/oasis-event-service');
  });

  function script(opts: { entries: any[]; links: any[]; googleFail?: { match: string; status: number } }) {
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      const u = String(url);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: u, method, body });
      const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
      if (opts.googleFail && u.includes('googleapis.com') && u.includes(opts.googleFail.match) && method !== 'GET') {
        return json({ error: { message: 'nope' } }, opts.googleFail.status);
      }
      if (u.endsWith('/calendar/v3/calendars') && method === 'POST') return json({ id: 'cal-vitanaland' });
      if (u.includes('/calendar/v3/calendars/') && method === 'POST') return json({ id: `g-${body.extendedProperties.private.vitanaland_event_id}` });
      if (u.includes('/calendar/v3/calendars/') && method === 'PUT') return json({ id: 'x' });
      if (u.includes('/calendar/v3/calendars/') && method === 'DELETE') return new Response(null, { status: 204 });
      if (u.endsWith('/freeBusy')) {
        return json({ calendars: { primary: { busy: [{ start: '2026-10-06T08:00:00Z', end: '2026-10-06T09:00:00Z' }] } } });
      }
      if (u.includes('/rest/v1/calendar_events')) return json(opts.entries);
      if (u.includes('/rest/v1/calendar_google_links') && method === 'GET') return json(opts.links);
      return new Response('', { status: 200 });
    }) as any;
  }

  const state = { user_id: 'u1', enabled: true, google_calendar_id: null, last_push_at: null, last_pull_at: null, last_error: null };
  const entry = { id: 'e1', title: 'Sunset walk', start_time: '2026-10-05T16:00:00Z', end_time: null, status: 'confirmed', role_context: 'community' };

  it('creates the Vitanaland calendar, pushes the entry, replaces busy times, records success', async () => {
    script({ entries: [entry], links: [] });
    const r = await sync.syncUser(state, NOW);
    expect(r).toMatchObject({ ok: true, created: 1, updated: 0, deleted: 0, busy: 1 });

    const g = calls.filter((c) => c.url.includes('googleapis.com'));
    expect(g[0]).toMatchObject({ method: 'POST', body: { summary: 'Vitanaland', timeZone: 'Europe/Berlin' } });
    expect(g[1].url).toContain('/calendars/cal-vitanaland/events');
    expect(g[1].body.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(g[2].url).toContain('/freeBusy');
    expect(g[2].body.items).toEqual([{ id: 'primary' }]);
    // Only the app-created calendar and freebusy are ever written or read.
    expect(g.every((c) => c.url.includes('/calendars/cal-vitanaland') || c.url.endsWith('/calendars') || c.url.endsWith('/freeBusy'))).toBe(true);

    const link = calls.find((c) => c.url.includes('/calendar_google_links?on_conflict') && c.method === 'POST')!;
    expect(link.body).toMatchObject({ user_id: 'u1', calendar_event_id: 'e1', google_event_id: 'g-e1' });
    const del = calls.find((c) => c.url.includes('/calendar_external_busy') && c.method === 'DELETE')!;
    expect(del.url).toContain('user_id=eq.u1');
    const ins = calls.find((c) => c.url.endsWith('/calendar_external_busy') && c.method === 'POST')!;
    expect(ins.body).toEqual([expect.objectContaining({ user_id: 'u1', source: 'google', start_time: '2026-10-06T08:00:00.000Z' })]);
    expect(Object.keys(ins.body[0]).sort()).toEqual(['end_time', 'fetched_at', 'source', 'start_time', 'user_id']);
    const last = calls.filter((c) => c.url.includes('/calendar_google_sync') && c.method === 'PATCH').pop()!;
    expect(last.body).toMatchObject({ last_error: null });
    expect(emit).not.toHaveBeenCalled();
  });

  it('an event the member already deleted in Google just loses its link', async () => {
    script({ entries: [], links: [{ id: 'l1', calendar_event_id: null, google_event_id: 'g-x', pushed_hash: 'h' }], googleFail: { match: '/events/g-x', status: 410 } });
    const r = await sync.syncUser({ ...state, google_calendar_id: 'cal-vitanaland' }, NOW);
    expect(r).toMatchObject({ ok: true, deleted: 1 });
    expect(calls.some((c) => c.url.includes('/calendar_google_links?id=eq.l1') && c.method === 'DELETE')).toBe(true);
  });

  it('a deleted Vitanaland calendar is forgotten so the next run recreates it', async () => {
    script({ entries: [entry], links: [], googleFail: { match: '/calendars/cal-old/events', status: 404 } });
    const r = await sync.syncUser({ ...state, google_calendar_id: 'cal-old' }, NOW);
    expect(r).toMatchObject({ ok: false, error: 'vitanaland_calendar_missing' });
    expect(calls.some((c) => c.url.includes('/calendar_google_sync') && c.method === 'PATCH' && c.body.google_calendar_id === null)).toBe(true);
  });

  it('a failure is recorded on the state row and emitted once, not on every repeat', async () => {
    script({ entries: [entry], links: [], googleFail: { match: '/freeBusy', status: 403 } });
    const r = await sync.syncUser({ ...state, google_calendar_id: 'cal-vitanaland' }, NOW);
    expect(r.ok).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ vtid: 'VTID-04372', type: 'calendar.google_sync.failed' });
    await sync.syncUser({ ...state, google_calendar_id: 'cal-vitanaland', last_error: r.error }, NOW);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('the tick does nothing at all while switched off', async () => {
    const off = withEnv({ CALENDAR_GOOGLE_SYNC_ENABLED: undefined });
    script({ entries: [], links: [] });
    expect(await sync.runGoogleSyncTick(NOW)).toEqual({ ok: true, skipped: 'not_configured', users: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(sync.startGoogleSyncLoop()).toBe(false);
    off();
  });
});

describe('routes', () => {
  function app(mocks: Record<string, any>) {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      optionalAuth: (req: any, _res: any, next: any) => { req.identity = { user_id: 'u1' }; next(); },
    }));
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => undefined) }));
    jest.doMock('../src/services/calendar-google-sync', () => ({
      ...jest.requireActual('../src/services/calendar-google-sync'),
      ...mocks,
    }));
    const router = require('../src/routes/calendar').default;
    const a = express();
    a.use(express.json());
    a.use('/api/v1/calendar', router);
    return a;
  }
  afterEach(() => {
    jest.dontMock('../src/middleware/auth-supabase-jwt');
    jest.dontMock('../src/services/oasis-event-service');
    jest.dontMock('../src/services/calendar-google-sync');
  });

  it('status reports not_configured while switched off', async () => {
    const r = await request(app({ googleSyncAvailability: () => 'not_configured' })).get('/api/v1/calendar/google');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ availability: 'not_configured', enabled: false, connect_url: expect.stringContaining('include=calendar_sync') });
  });

  it('enable: 503 while switched off, 409 with the connect link when Google is not connected, 200 when it is', async () => {
    expect((await request(app({ enableGoogleSync: async () => ({ ok: false, error: 'not_configured' }) })).post('/api/v1/calendar/google/enable')).status).toBe(503);
    const nc = await request(app({ enableGoogleSync: async () => ({ ok: false, error: 'not_connected', connect_url: '/c' }) })).post('/api/v1/calendar/google/enable');
    expect(nc.status).toBe(409);
    expect(nc.body).toMatchObject({ error: 'not_connected', connect_url: '/c' });
    const ok = await request(app({ enableGoogleSync: async () => ({ ok: true, state: {} }) })).post('/api/v1/calendar/google/enable');
    expect(ok.status).toBe(200);
  });

  it('disable turns it off', async () => {
    const off = jest.fn(async () => undefined);
    const r = await request(app({ disableGoogleSync: off })).post('/api/v1/calendar/google/disable');
    expect(r.status).toBe(200);
    expect(off).toHaveBeenCalledWith('u1');
  });
});

describe('wiring', () => {
  const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '../src', p), 'utf8');

  it('the window read adds Google busy times only when sync is ready and busy blocks are wanted', () => {
    const route = src('routes/calendar.ts');
    const at = route.indexOf('listExternalBusy(');
    expect(at).toBeGreaterThan(0);
    const before = route.slice(route.lastIndexOf("router.get('/events/window'", at), at);
    expect(before).toContain('if (includeBusy)');
    expect(before).toContain("googleSyncAvailability() === 'ready'");
  });

  it('the loop is wired at boot and pinned on no environment yet', () => {
    expect(src('index.ts')).toContain('startGoogleSyncLoop()');
    for (const wf of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      expect(fs.readFileSync(path.join(ROOT, '.github/workflows', wf), 'utf8')).not.toContain('CALENDAR_GOOGLE_SYNC_ENABLED');
    }
  });

  it('asks Google only for the app-created calendar and free/busy', () => {
    const { GOOGLE_SUB_SCOPES, parseGoogleInclude } = jest.requireActual('../src/services/social-connect-service');
    expect(GOOGLE_SUB_SCOPES.calendar_sync).toEqual([
      'https://www.googleapis.com/auth/calendar.app.created',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ]);
    expect(parseGoogleInclude('calendar_sync')).toEqual(['calendar_sync']);
  });

  it('the migration keeps all three tables service-role only and stores no tokens', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260923180000_vtid_04372_calendar_google_sync.sql'), 'utf8');
    for (const t of ['calendar_google_sync', 'calendar_google_links', 'calendar_external_busy']) {
      expect(sql).toContain(`ALTER TABLE public.${t}`);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM PUBLIC, anon, authenticated`));
    }
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).not.toMatch(/access_token|refresh_token/);
  });
});
