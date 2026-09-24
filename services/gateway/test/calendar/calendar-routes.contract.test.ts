/**
 * VTID-04458 — calendar regression suite: the /api/v1/calendar HTTP contract.
 *
 * The app, the ORB tools and the orb-agent all talk to these routes. This
 * suite pins, per route: that it exists, who may call it, how it rejects bad
 * input, and the exact response shape — with every service below the route
 * replaced by a scripted fake, so nothing touches a database.
 *
 * Responses are compared with __golden__/calendar-routes.json. An intended
 * change is re-recorded with UPDATE_CALENDAR_GOLDEN=1 and committed with it.
 */
import express from 'express';
import request from 'supertest';
import { expectGolden } from './golden';

const G = 'calendar-routes';

const EVENT = {
  id: 'e1', user_id: 'u1', title: 'Walk', description: null,
  start_time: '2026-10-05T07:30:00.000Z', end_time: '2026-10-05T08:00:00.000Z',
  location: null, event_type: 'workout', status: 'confirmed', priority: 'medium',
  role_context: 'community', source_type: 'manual', source_ref_type: null, source_ref_id: null,
  completed_at: null, completion_status: null, rrule: null, timezone: null, reminder_offsets: null, emoji: null,
  wellness_tags: ['movement'], priority_score: 50, metadata: {}, pillar: 'exercise', contribution_vector: null,
  is_recurring: false, recurring_pattern: null, attendees_count: 0, has_rewards: false, source_message_id: null,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', activated_at: null,
  completion_notes: null, original_start_time: null, reschedule_count: 0,
};

let calls: Array<[string, unknown[]]> = [];
const rec = (name: string, result: unknown) => jest.fn(async (...args: unknown[]) => { calls.push([name, args]); return result; });

function build(identity: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) {
  jest.resetModules();
  calls = [];
  jest.doMock('../../src/middleware/auth-supabase-jwt', () => ({
    optionalAuth: (req: any, _res: any, next: any) => { if (identity) req.identity = identity; next(); },
  }));
  jest.doMock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => undefined) }));
  jest.doMock('../../src/lib/supabase', () => ({ getSupabase: () => null }));
  jest.doMock('../../src/routes/calendar-repository', () => ({}));
  jest.doMock('../../src/services/daily-pace-service', () => ({ getUserTimezone: jest.fn(async () => 'Europe/Berlin') }));
  jest.doMock('../../src/services/calendar-service', () => {
    const real = jest.requireActual('../../src/services/calendar-service');
    return {
      ...real,
      listCalendarEvents: rec('listCalendarEvents', { data: [EVENT], count: 1 }),
      getUserUpcomingEvents: rec('getUserUpcomingEvents', [EVENT]),
      getUserTodayEvents: rec('getUserTodayEvents', [EVENT]),
      getUserCalendarHistory: rec('getUserCalendarHistory', [EVENT]),
      getCalendarGaps: rec('getCalendarGaps', [{ start: '2026-10-05T09:00:00.000Z', end: '2026-10-05T10:00:00.000Z', duration_minutes: 60 }]),
      checkConflicts: rec('checkConflicts', [EVENT]),
      createCalendarEvent: rec('createCalendarEvent', EVENT),
      bulkCreateCalendarEvents: rec('bulkCreateCalendarEvents', [EVENT, { ...EVENT, id: 'e2' }]),
      updateCalendarEvent: rec('updateCalendarEvent', overrides.updateCalendarEvent === undefined ? EVENT : overrides.updateCalendarEvent),
      markEventCompleted: rec('markEventCompleted', overrides.markEventCompleted === undefined ? { ...EVENT, completion_status: 'completed' } : overrides.markEventCompleted),
      softDeleteEvent: rec('softDeleteEvent', overrides.softDeleteEvent === undefined ? { ...EVENT, status: 'cancelled' } : overrides.softDeleteEvent),
      getOwnCalendarEvent: rec('getOwnCalendarEvent', overrides.getOwnCalendarEvent === undefined ? EVENT : overrides.getOwnCalendarEvent),
      rescheduleEvent: rec('rescheduleEvent', { ...EVENT, start_time: '2026-10-06T07:30:00.000Z', end_time: '2026-10-06T08:00:00.000Z' }),
      listCalendarWindow: rec('listCalendarWindow', [
        { id: 'e1', event_id: 'e1', start_time: EVENT.start_time, end_time: EVENT.end_time, busy: false, occurrence_index: null, event: EVENT },
        { id: 'h1::2026-10-05T05:30:00.000Z', event_id: 'h1', start_time: '2026-10-05T05:30:00.000Z', end_time: '2026-10-05T05:45:00.000Z', busy: false, occurrence_index: 2, event: { ...EVENT, id: 'h1', rrule: 'FREQ=DAILY', event_type: 'wellness_nudge' } },
        { id: 'd1', event_id: 'd1', start_time: '2026-10-05T12:00:00.000Z', end_time: '2026-10-05T13:00:00.000Z', busy: true, occurrence_index: null, event: null },
      ]),
    };
  });
  jest.doMock('../../src/services/calendar-producers', () => ({ completeSourceForCalendarEvent: rec('completeSourceForCalendarEvent', { completed: true }) }));
  jest.doMock('../../src/services/calendar-ics-feed', () => ({
    getFeedStatus: rec('getFeedStatus', { active: true, created_at: '2026-10-01T00:00:00Z', last_used_at: null }),
    rotateFeedToken: rec('rotateFeedToken', 'tok_ABC-123'),
    revokeFeedToken: rec('revokeFeedToken', undefined),
    resolveFeedToken: jest.fn(async (t: string) => (t === 'good_token' ? 'u1' : null)),
    buildFeedForUser: rec('buildFeedForUser', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
  }));
  jest.doMock('../../src/services/calendar-google-sync', () => ({
    googleSyncAvailability: () => 'ready',
    GOOGLE_SYNC_CONNECT_URL: '/api/v1/social-accounts/connect/google?include=calendar_sync&mode=incremental',
    getSyncState: rec('getSyncState', { enabled: true, last_push_at: '2026-10-05T00:00:00Z', last_pull_at: null, last_error: null }),
    enableGoogleSync: rec('enableGoogleSync', overrides.enableGoogleSync ?? { ok: true }),
    disableGoogleSync: rec('disableGoogleSync', undefined),
    listExternalBusy: rec('listExternalBusy', [{ id: 'ext:google:1', event_id: 'ext:google:1', start_time: '2026-10-05T15:00:00.000Z', end_time: '2026-10-05T16:00:00.000Z', busy: true, occurrence_index: null, event: null, external: 'google' }]),
  }));
  jest.doMock('../../src/services/calendar-work-lens', () => {
    const real = jest.requireActual('../../src/services/calendar-work-lens');
    return {
      ...real,
      listWorkItems: rec('listWorkItems', real.deployItems('u1', [{ id: 'dep1', topic: 'prod.deploy.completed', service: 'gateway', created_at: '2026-10-05T10:00:00.000Z', metadata: { git_commit: 'abc1234' } }])),
    };
  });
  jest.doMock('../../src/services/calendar-rescheduler', () => ({ rescheduleUnactivatedTasks: rec('rescheduleUnactivatedTasks', { rescheduled: 2, cancelled: 1 }) }));
  jest.doMock('../../src/services/calendar-prioritizer', () => ({ reprioritizeAllUsers: rec('reprioritizeAllUsers', { users_processed: 3, total_updated: 7 }) }));
  jest.doMock('../../src/services/journey-calendar-mapper', () => ({ initializeJourneyCalendar: rec('initializeJourneyCalendar', { ok: true, events_created: 12 }) }));
  const router = require('../../src/routes/calendar').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/calendar', router);
  return app;
}

afterEach(() => jest.resetModules());

const MEMBER = { user_id: 'u1' };
const STAFF = { user_id: 'u1', exafy_admin: true };

/** Status, content type and body — the parts a client depends on. */
function shape(res: request.Response) {
  const type = String(res.headers['content-type'] ?? '').split(';')[0];
  return { status: res.status, type, body: type === 'application/json' ? res.body : res.text };
}

describe('route table', () => {
  it('exposes exactly these routes, in this order', () => {
    build(MEMBER);
    const router = require('../../src/routes/calendar').default;
    const routes = router.stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    expectGolden(G, 'routes', routes);
  });
});

describe('who may call', () => {
  const PROTECTED: Array<[string, string]> = [
    ['get', '/events'], ['get', '/events/window?from=2026-10-05T00:00:00Z&to=2026-10-06T00:00:00Z'], ['get', '/events/upcoming'],
    ['get', '/events/today'], ['get', '/events/history'], ['get', '/events/gaps'], ['get', '/conflicts'],
    ['post', '/events'], ['post', '/events/bulk'], ['patch', '/events/e1'], ['post', '/events/e1/move'],
    ['post', '/events/e1/complete'], ['delete', '/events/e1'], ['post', '/journey/initialize'],
    ['get', '/subscription'], ['post', '/subscription'], ['delete', '/subscription'],
    ['get', '/google'], ['post', '/google/enable'], ['post', '/google/disable'],
    ['post', '/reschedule'], ['post', '/reprioritize'],
  ];

  it.each(PROTECTED)('%s %s refuses an anonymous caller and calls nothing', async (method, path) => {
    const app = build(null);
    const res = await (request(app) as any)[method](`/api/v1/calendar${path}`).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    expect(calls).toEqual([]);
  });

  it('health and the feed are open', async () => {
    const app = build(null);
    expectGolden(G, 'open.health', shape(await request(app).get('/api/v1/calendar/health')));
    const feed = await request(app).get('/api/v1/calendar/feed/good_token.ics');
    expectGolden(G, 'open.feed', { ...shape(feed), cache: feed.headers['cache-control'], robots: feed.headers['x-robots-tag'] });
    expectGolden(G, 'open.feed.unknown', shape(await request(app).get('/api/v1/calendar/feed/bad_token.ics')));
    expectGolden(G, 'open.feed.malformed', shape(await request(app).get('/api/v1/calendar/feed/..%2Fetc.ics')));
  });

  it('whole-calendar jobs are staff only', async () => {
    const member = build(MEMBER);
    expectGolden(G, 'staff.member.reschedule', shape(await request(member).post('/api/v1/calendar/reschedule')));
    expectGolden(G, 'staff.member.reprioritize', shape(await request(member).post('/api/v1/calendar/reprioritize')));
    expect(calls).toEqual([]);
    const staff = build(STAFF);
    expectGolden(G, 'staff.staff.reschedule', shape(await request(staff).post('/api/v1/calendar/reschedule')));
    expectGolden(G, 'staff.staff.reprioritize', shape(await request(staff).post('/api/v1/calendar/reprioritize')));
  });
});

describe('reads', () => {
  it('list, upcoming, today, history, gaps, conflicts', async () => {
    const app = build(MEMBER);
    const base = '/api/v1/calendar';
    const out: Record<string, unknown> = {
      list: shape(await request(app).get(`${base}/events?limit=10`).set('X-Vitana-Active-Role', 'professional')),
      list_bad_limit: shape(await request(app).get(`${base}/events?limit=900`)),
      upcoming: shape(await request(app).get(`${base}/events/upcoming?limit=500`)),
      today: shape(await request(app).get(`${base}/events/today?timezone=Europe/Berlin`)),
      history: shape(await request(app).get(`${base}/events/history?days=9999&limit=9999`)),
      gaps: shape(await request(app).get(`${base}/events/gaps?date=2026-10-05`)),
      conflicts_missing: shape(await request(app).get(`${base}/conflicts?start_time=2026-10-05T07:00:00Z`)),
      conflicts: shape(await request(app).get(`${base}/conflicts?start_time=2026-10-05T07:00:00Z&end_time=2026-10-05T08:00:00Z`)),
    };
    expectGolden(G, 'reads', out);
    // The limits the routes clamp to, as passed to the services.
    expectGolden(G, 'reads.calls', calls.map(([n, a]) => [n, a.map((x) => (x instanceof Date ? x.toISOString() : x))]));
  });

  it('window: validation', async () => {
    const app = build(MEMBER);
    const w = (q: string) => request(app).get(`/api/v1/calendar/events/window${q}`);
    expectGolden(G, 'window.invalid', {
      missing: shape(await w('')),
      reversed: shape(await w('?from=2026-10-06T00:00:00Z&to=2026-10-05T00:00:00Z')),
      too_long: shape(await w('?from=2026-10-01T00:00:00Z&to=2026-12-03T00:00:00Z')),
    });
    expect(calls).toEqual([]);
  });

  it('window: member view — emoji, reminders, movable, external busy', async () => {
    const app = build(MEMBER);
    const res = await request(app).get('/api/v1/calendar/events/window?from=2026-10-05T00:00:00Z&to=2026-10-12T00:00:00Z');
    expectGolden(G, 'window.member', shape(res));
  });

  it('window: staff developer lens adds read-only work items; include flags turn parts off', async () => {
    const app = build(STAFF);
    const q = '/api/v1/calendar/events/window?from=2026-10-05T00:00:00Z&to=2026-10-12T00:00:00Z';
    const dev = await request(app).get(q).set('X-Vitana-Active-Role', 'developer');
    expectGolden(G, 'window.staff.developer', { lenses: dev.body.work_lenses, ids: dev.body.data.map((d: any) => [d.id, d.busy, d.display_emoji ?? null, d.movable ?? null]) });
    const off = await request(app).get(`${q}&include_work=false&include_busy=false`).set('X-Vitana-Active-Role', 'developer');
    expectGolden(G, 'window.staff.off', { lenses: off.body.work_lenses, ids: off.body.data.map((d: any) => d.id) });
    // A member claiming the developer role header gets no work lens.
    const member = build(MEMBER);
    const fake = await request(member).get(q).set('X-Vitana-Active-Role', 'developer');
    expect(fake.body.work_lenses).toEqual([]);
  });
});

describe('writes', () => {
  it('create: validation, defaults and role tagging', async () => {
    const app = build(MEMBER);
    const post = (body: unknown, role?: string) => {
      const r = request(app).post('/api/v1/calendar/events');
      return (role ? r.set('X-Vitana-Active-Role', role) : r).send(body as object);
    };
    expectGolden(G, 'create', {
      invalid: shape(await post({ title: 'x', start_time: 'tomorrow' })),
      ok: shape(await post({ title: 'Walk', start_time: '2026-10-05T07:30:00Z' })),
    });
    await post({ title: 'Deploy', start_time: '2026-10-05T07:30:00Z' }, 'developer');
    await post({ title: 'Review', start_time: '2026-10-05T07:30:00Z' }, 'staff');
    await post({ title: 'Mine', start_time: '2026-10-05T07:30:00Z', role_context: 'personal' }, 'developer');
    expectGolden(G, 'create.inputs', calls.filter(([n]) => n === 'createCalendarEvent').map(([, a]) => a));
  });

  it('bulk', async () => {
    const app = build(MEMBER);
    const post = (body: unknown) => request(app).post('/api/v1/calendar/events/bulk').send(body as object);
    expectGolden(G, 'bulk', {
      empty: shape(await post({ events: [] })),
      too_many: shape(await post({ events: Array.from({ length: 201 }, () => ({ title: 'x', start_time: '2026-10-05T07:30:00Z' })) })),
      one_bad: shape(await post({ events: [{ title: 'x', start_time: '2026-10-05T07:30:00Z' }, { title: '' }] })),
      ok: shape(await post({ events: [{ title: 'a', start_time: '2026-10-05T07:30:00Z' }, { title: 'b', start_time: '2026-10-06T07:30:00Z' }] })),
    });
  });

  it('update and delete', async () => {
    const app = build(MEMBER);
    expectGolden(G, 'update', {
      invalid: shape(await request(app).patch('/api/v1/calendar/events/e1').send({ rrule: 'FREQ=YEARLY' })),
      ok: shape(await request(app).patch('/api/v1/calendar/events/e1').send({ title: 'New' })),
      delete_ok: shape(await request(app).delete('/api/v1/calendar/events/e1')),
    });
    const missing = build(MEMBER, { updateCalendarEvent: null, softDeleteEvent: null });
    expectGolden(G, 'update.missing', {
      update: shape(await request(missing).patch('/api/v1/calendar/events/nope').send({ title: 'x' })),
      delete: shape(await request(missing).delete('/api/v1/calendar/events/nope')),
    });
  });

  it('move: validation, ownership rules, default duration', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000);
    soon.setUTCHours(9, 0, 0, 0);
    const start = soon.toISOString();
    const app = build(MEMBER);
    const move = (id: string, body: unknown) => request(app).post(`/api/v1/calendar/events/${id}/move`).send(body as object);
    const ok = await move('e1', { start_time: start });
    expect(ok.status).toBe(200);
    // Without an end, the entry keeps its length (30 min here).
    const call = calls.find(([n]) => n === 'rescheduleEvent')![1];
    expect(Date.parse(call[3] as string) - Date.parse(call[2] as string)).toBe(30 * 60_000);
    expectGolden(G, 'move.invalid', {
      work_item: shape(await move('work:deploy_prod:1', { start_time: start })),
      no_start: shape(await move('e1', {})),
      end_before_start: shape(await move('e1', { start_time: start, end_time: '2020-01-01T00:00:00Z' })),
      too_far: shape(await move('e1', { start_time: '2099-01-01T00:00:00Z' })),
      past: shape(await move('e1', { start_time: '2020-01-01T00:00:00Z' })),
    });
    const blocked: Record<string, unknown> = {};
    for (const [name, ev] of Object.entries({
      recurring: { ...EVENT, rrule: 'FREQ=DAILY' },
      appointment: { ...EVENT, source_type: 'appointment' },
      completed: { ...EVENT, completed_at: '2026-10-01T00:00:00Z' },
      not_found: null,
    })) {
      const a = build(MEMBER, { getOwnCalendarEvent: ev });
      blocked[name] = shape(await request(a).post('/api/v1/calendar/events/e1/move').send({ start_time: start }));
    }
    expectGolden(G, 'move.blocked', blocked);
  });

  it('complete: work items are read-only, completion reaches the source', async () => {
    const app = build(MEMBER);
    const done = (id: string, body: unknown) => request(app).post(`/api/v1/calendar/events/${id}/complete`).send(body as object);
    expectGolden(G, 'complete', {
      work_item: shape(await done('work:ticket_due:t1', {})),
      invalid: shape(await done('e1', { completion_status: 'maybe' })),
      completed: shape(await done('e1', {})),
      skipped: shape(await done('e1', { completion_status: 'skipped' })),
    });
    // Only a real completion completes the source.
    expect(calls.filter(([n]) => n === 'completeSourceForCalendarEvent')).toHaveLength(1);
    const missing = build(MEMBER, { markEventCompleted: null });
    expectGolden(G, 'complete.missing', shape(await request(missing).post('/api/v1/calendar/events/nope/complete').send({})));
  });

  it('journey initialize', async () => {
    const app = build(MEMBER);
    expectGolden(G, 'journey', shape(await request(app).post('/api/v1/calendar/journey/initialize').set('X-Vitana-Tenant', 't1').send({ language: 'de' })));
    expectGolden(G, 'journey.call', calls.map(([n, a]) => [n, a.map((x) => (x instanceof Date ? 'Date' : x))]));
  });
});

describe('subscription and Google', () => {
  it('feed link lifecycle', async () => {
    const app = build(MEMBER);
    expectGolden(G, 'subscription', {
      status: shape(await request(app).get('/api/v1/calendar/subscription')),
      create: shape(await request(app).post('/api/v1/calendar/subscription')),
      revoke: shape(await request(app).delete('/api/v1/calendar/subscription')),
    });
  });

  it('Google sync state and switch', async () => {
    const app = build(MEMBER);
    expectGolden(G, 'google', {
      state: shape(await request(app).get('/api/v1/calendar/google')),
      enable: shape(await request(app).post('/api/v1/calendar/google/enable')),
      disable: shape(await request(app).post('/api/v1/calendar/google/disable')),
    });
    const notConnected = build(MEMBER, { enableGoogleSync: { ok: false, error: 'not_connected', connect_url: '/connect' } });
    const notConfigured = build(MEMBER, { enableGoogleSync: { ok: false, error: 'not_configured' } });
    expectGolden(G, 'google.refused', {
      not_connected: shape(await request(notConnected).post('/api/v1/calendar/google/enable')),
      not_configured: shape(await request(notConfigured).post('/api/v1/calendar/google/enable')),
    });
  });
});
