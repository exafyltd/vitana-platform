/**
 * VTID-04374 — calendar maintenance.
 *
 * Pins the rescheduler's candidate rules (one-off, never completed, only once
 * the entry's local day is over), the DST-correct next slot, the staff-only
 * gate on the two global job routes, the in-process loop flag, and that the
 * retired /meetup-reminders job is a no-op.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  isDayOver,
  nextSlot,
  rescheduleUnactivatedTasks,
  isCalendarMaintenanceEnabled,
  MAX_RESCHEDULES,
} from '../src/services/calendar-rescheduler';

const BERLIN = 'Europe/Berlin';

describe('isDayOver', () => {
  const now = Date.parse('2026-09-23T10:00:00Z'); // 12:00 in Berlin

  it('false while the entry is still running or later today', () => {
    expect(isDayOver({ start_time: '2026-09-23T07:00:00Z', end_time: '2026-09-23T08:00:00Z' }, BERLIN, now)).toBe(false);
    expect(isDayOver({ start_time: '2026-09-23T12:00:00Z', end_time: null }, BERLIN, now)).toBe(false);
  });

  it('true once the local day it ended on is over', () => {
    expect(isDayOver({ start_time: '2026-09-22T07:00:00Z', end_time: '2026-09-22T08:00:00Z' }, BERLIN, now)).toBe(true);
  });

  it('uses the local day, not UTC: 23:30 Berlin yesterday is 21:30 UTC', () => {
    // Ended 2026-09-22 21:30 UTC = 23:30 Berlin on the 22nd → over by noon on the 23rd.
    expect(isDayOver({ start_time: '2026-09-22T21:00:00Z', end_time: '2026-09-22T21:30:00Z' }, BERLIN, now)).toBe(true);
    // In Los Angeles "now" is 03:00 on the 23rd, and the entry ended 14:30 on the 22nd.
    expect(isDayOver({ start_time: '2026-09-22T21:00:00Z', end_time: '2026-09-22T21:30:00Z' }, 'America/Los_Angeles', now)).toBe(true);
    // An entry ending 01:30 Berlin today is still today's.
    expect(isDayOver({ start_time: '2026-09-22T23:00:00Z', end_time: '2026-09-22T23:30:00Z' }, BERLIN, now)).toBe(false);
  });
});

describe('nextSlot', () => {
  it('tomorrow at the same local time, duration kept', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    const s = nextSlot({ start_time: '2026-09-21T07:30:00Z', end_time: '2026-09-21T08:15:00Z' }, BERLIN, now);
    expect(s).toEqual({ start: '2026-09-24T07:30:00.000Z', end: '2026-09-24T08:15:00.000Z' });
  });

  it('keeps the local wall-clock time across the DST change (09:00 stays 09:00)', () => {
    // 2026-10-24 09:00 Berlin (CEST, UTC+2) = 07:00Z. Clocks go back on the 25th.
    const now = Date.parse('2026-10-25T10:00:00Z');
    const s = nextSlot({ start_time: '2026-10-24T07:00:00Z', end_time: null }, BERLIN, now);
    // 2026-10-26 09:00 Berlin (CET, UTC+1) = 08:00Z — not 07:00Z.
    expect(s).toEqual({ start: '2026-10-26T08:00:00.000Z', end: null });
  });

  it('never lands in the past after a missed run', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    const s = nextSlot({ start_time: '2026-09-10T07:00:00Z', end_time: null }, BERLIN, now);
    expect(Date.parse(s.start)).toBeGreaterThan(now);
  });
});

describe('rescheduleUnactivatedTasks', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; method: string; body: any }> = [];
  beforeEach(() => {
    calls = [];
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
    jest.resetModules();
  });
  afterAll(() => {
    global.fetch = realFetch;
    jest.dontMock('../src/services/daily-pace-service');
    jest.dontMock('../src/services/oasis-event-service');
  });

  function run(candidates: any[], patchRows = 1) {
    jest.doMock('../src/services/daily-pace-service', () => ({ getUserTimezone: jest.fn(async () => BERLIN) }));
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => undefined) }));
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      if ((init.method ?? 'GET') === 'GET') return new Response(JSON.stringify(candidates), { status: 200 });
      return new Response(JSON.stringify(Array(patchRows).fill({})), { status: 200 });
    }) as any;
    const mod = require('../src/services/calendar-rescheduler');
    return mod.rescheduleUnactivatedTasks(Date.parse('2026-09-23T10:00:00Z'));
  }

  it('reads one-off, uncompleted, unactivated Autopilot/journey entries only', async () => {
    await run([]);
    const q = calls[0].url;
    expect(q).toContain('source_type=in.(autopilot,journey)');
    expect(q).toContain('rrule=is.null');
    expect(q).toContain('completed_at=is.null');
    expect(q).toContain('activated_at=is.null');
    // Tasks only — never journey milestones or sentinels.
    expect(q).toContain('source_ref_type=in.(autopilot_recommendation,journey_task)');
    // Only the last 3 days: months of old suggestions are never dragged forward.
    expect(q).toContain(`start_time=gte.${encodeURIComponent('2026-09-20T10:00:00.000Z')}`);
    expect(calls).toHaveLength(1);
  });

  it('moves an entry whose day is over; leaves today\'s alone', async () => {
    const r = await run([
      { id: 'a', user_id: 'u', title: 'Walk', start_time: '2026-09-22T07:00:00Z', end_time: '2026-09-22T07:30:00Z', timezone: null, reschedule_count: 0, original_start_time: null },
      { id: 'b', user_id: 'u', title: 'Stretch', start_time: '2026-09-23T06:00:00Z', end_time: '2026-09-23T06:30:00Z', timezone: null, reschedule_count: 0, original_start_time: null },
    ]);
    expect(r.rescheduled).toBe(1);
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain('id=eq.a');
    // The write re-checks the row is still open, so a race with "mark done" is safe.
    expect(patches[0].url).toContain('completed_at=is.null');
    expect(patches[0].body).toMatchObject({
      start_time: '2026-09-24T07:00:00.000Z',
      end_time: '2026-09-24T07:30:00.000Z',
      original_start_time: '2026-09-22T07:00:00Z',
      reschedule_count: 1,
    });
  });

  it(`drops an entry after ${MAX_RESCHEDULES} moves instead of moving it again`, async () => {
    const r = await run([
      { id: 'c', user_id: 'u', title: 'Meal prep', start_time: '2026-09-22T07:00:00Z', end_time: null, timezone: null, reschedule_count: MAX_RESCHEDULES, original_start_time: '2026-09-19T07:00:00Z' },
    ]);
    expect(r.cancelled).toBe(1);
    const p = calls.find((c) => c.method === 'PATCH')!;
    expect(p.body).toMatchObject({ status: 'cancelled', completion_status: 'skipped' });
  });

  it('a row completed in the meantime is not counted', async () => {
    const r = await run(
      [{ id: 'd', user_id: 'u', title: 'x', start_time: '2026-09-22T07:00:00Z', end_time: null, timezone: null, reschedule_count: 0, original_start_time: null }],
      0,
    );
    expect(r.rescheduled).toBe(0);
    expect(r.errors).toBe(0);
  });
});

describe('flags and routes', () => {
  it('the loop runs only on exactly "true"', () => {
    expect(isCalendarMaintenanceEnabled('true')).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'false']) expect(isCalendarMaintenanceEnabled(v)).toBe(false);
  });

  function app(identity: any) {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      optionalAuth: (req: any, _res: any, next: any) => {
        if (identity) req.identity = identity;
        next();
      },
    }));
    jest.doMock('../src/services/calendar-rescheduler', () => ({
      rescheduleUnactivatedTasks: jest.fn(async () => ({ rescheduled: 0, cancelled: 0, errors: 0, details: [] })),
    }));
    jest.doMock('../src/services/calendar-prioritizer', () => ({
      reprioritizeAllUsers: jest.fn(async () => ({ users_processed: 0, total_updated: 0, total_errors: 0 })),
    }));
    const router = require('../src/routes/calendar').default;
    const a = express();
    a.use(express.json());
    a.use('/api/v1/calendar', router);
    return a;
  }
  afterEach(() => {
    jest.dontMock('../src/middleware/auth-supabase-jwt');
    jest.dontMock('../src/services/calendar-rescheduler');
    jest.dontMock('../src/services/calendar-prioritizer');
  });

  it('a signed-in member cannot run the global jobs', async () => {
    const a = app({ user_id: 'u1' });
    expect((await request(a).post('/api/v1/calendar/reschedule')).status).toBe(403);
    expect((await request(a).post('/api/v1/calendar/reprioritize')).status).toBe(403);
  });

  it('Exafy staff can', async () => {
    const a = app({ user_id: 'u1', exafy_admin: true });
    expect((await request(a).post('/api/v1/calendar/reschedule')).status).toBe(200);
    expect((await request(a).post('/api/v1/calendar/reprioritize')).status).toBe(200);
  });

  it('the loop is wired at boot and pinned on staging only', () => {
    const index = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
    expect(index).toContain('startCalendarMaintenanceLoop()');
    const root = path.resolve(__dirname, '../../..');
    const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(stage).toContain('{name:"CALENDAR_MAINTENANCE_ENABLED", value:"true"}');
    const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(prod).not.toContain('CALENDAR_MAINTENANCE_ENABLED');
  });
});

describe('/meetup-reminders is retired', () => {
  it('the route is a no-op and nothing reads the missing attendance table', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/scheduled-notifications.ts'), 'utf8');
    const route = src.slice(src.indexOf("router.post('/meetup-reminders'"));
    expect(route.slice(0, 300)).toContain('retired: true');
    const repo = fs.readFileSync(path.resolve(__dirname, '../src/routes/scheduled-notifications-repository.ts'), 'utf8');
    expect(repo).not.toContain('community_meetup_attendance');
    const handler = fs.readFileSync(path.resolve(__dirname, '../src/services/automation-handlers/engagement-events.ts'), 'utf8');
    expect(handler).not.toContain('/scheduled-notifications/meetup-reminders');
  });
});

describe('moving your own entry', () => {
  const { moveBlockReason } = require('../src/services/calendar-service');
  const base = { status: 'confirmed', completed_at: null, rrule: null, source_type: 'manual', source_ref_type: null };

  it('your own entries and Vitana suggestions move', () => {
    expect(moveBlockReason(base)).toBeNull();
    expect(moveBlockReason({ ...base, source_type: 'assistant', source_ref_type: 'pillar_template' })).toBeNull();
    expect(moveBlockReason({ ...base, source_type: 'autopilot', source_ref_type: 'autopilot_recommendation' })).toBeNull();
    expect(moveBlockReason({ ...base, source_type: 'journey', source_ref_type: 'journey_task' })).toBeNull();
  });

  it('anything a source owns does not', () => {
    for (const [source_type, source_ref_type] of [
      ['appointment', 'provider_appointment'],
      ['lab_order', 'lab_test_order'],
      ['live_room', 'live_room_session'],
      ['goal_plan', 'goal_plan_step'],
      ['health_plan', 'user_health_plan'],
      ['invite', null],
      ['community_rsvp', null],
      ['journey', 'wave_milestone'],
    ]) {
      expect(moveBlockReason({ ...base, source_type, source_ref_type })).toBe('owned_by_source');
    }
  });

  it('done, cancelled and series entries do not', () => {
    expect(moveBlockReason({ ...base, completed_at: '2026-09-22T10:00:00Z' })).toBe('completed');
    expect(moveBlockReason({ ...base, status: 'cancelled' })).toBe('cancelled');
    expect(moveBlockReason({ ...base, rrule: 'FREQ=DAILY' })).toBe('recurring');
  });

  function moveApp(event: any) {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      optionalAuth: (req: any, _res: any, next: any) => {
        req.identity = { user_id: 'u1' };
        next();
      },
    }));
    const moved = jest.fn(async (_id: string, _u: string, s: string, e: string) => ({ ...event, start_time: s, end_time: e }));
    jest.doMock('../src/services/calendar-service', () => {
      const actual = jest.requireActual('../src/services/calendar-service');
      return { ...actual, getOwnCalendarEvent: jest.fn(async () => event), rescheduleEvent: moved };
    });
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => undefined) }));
    const router = require('../src/routes/calendar').default;
    const a = express();
    a.use(express.json());
    a.use('/api/v1/calendar', router);
    return { a, moved };
  }
  afterEach(() => {
    jest.dontMock('../src/middleware/auth-supabase-jwt');
    jest.dontMock('../src/services/calendar-service');
    jest.dontMock('../src/services/oasis-event-service');
  });

  const soon = new Date(Date.now() + 2 * 86_400_000);
  soon.setUTCMinutes(0, 0, 0);

  it('keeps the entry length when only a new start is given', async () => {
    const ev = { ...base, id: 'e1', start_time: '2026-09-20T08:00:00Z', end_time: '2026-09-20T08:45:00Z' };
    const { a, moved } = moveApp(ev);
    const r = await request(a).post('/api/v1/calendar/events/e1/move').send({ start_time: soon.toISOString() });
    expect(r.status).toBe(200);
    expect(moved).toHaveBeenCalledWith('e1', 'u1', soon.toISOString(), new Date(soon.getTime() + 45 * 60_000).toISOString());
  });

  it('refuses a booked appointment with a reason the app can show', async () => {
    const { a, moved } = moveApp({ ...base, id: 'e2', source_type: 'appointment', start_time: '2026-09-20T08:00:00Z', end_time: null });
    const r = await request(a).post('/api/v1/calendar/events/e2/move').send({ start_time: soon.toISOString() });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'NOT_MOVABLE', reason: 'owned_by_source' });
    expect(moved).not.toHaveBeenCalled();
  });

  it('rejects bad input and work items before reading anything', async () => {
    const { a } = moveApp({ ...base, id: 'e3', start_time: '2026-09-20T08:00:00Z', end_time: null });
    expect((await request(a).post('/api/v1/calendar/events/e3/move').send({ start_time: 'soon' })).status).toBe(400);
    expect((await request(a).post('/api/v1/calendar/events/e3/move').send({ start_time: soon.toISOString(), end_time: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await request(a).post('/api/v1/calendar/events/work:deploy_prod:x/move').send({ start_time: soon.toISOString() })).status).toBe(400);
  });
});
