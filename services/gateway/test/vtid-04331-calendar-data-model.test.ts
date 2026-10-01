/**
 * VTID-04331 — calendar step 2: data model, producer contract, recurrence
 * expansion and grey busy blocks.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseRRule, expandOccurrences, zonedTimeToEpoch } from '../src/services/calendar-recurrence';
import { buildCalendarWindow, toBusyBlock } from '../src/services/calendar-service';
import {
  diffEntry,
  seriesEntryRefId,
  upsertCalendarEntryFromSource,
  upsertCalendarSeriesFromSource,
  completeCalendarEntriesForSource,
  completeSourceForCalendarEvent,
} from '../src/services/calendar-producers';
import {
  CreateCalendarEventSchema,
  RRULE_PATTERN,
  CALENDAR_SOURCE_TYPES,
  CALENDAR_ROLE_CONTEXTS,
  getVisibleContexts,
} from '../src/types/calendar';

const repoRoot = path.resolve(__dirname, '../../..');
const migration = fs.readFileSync(
  path.join(repoRoot, 'supabase/migrations/20260923130000_vtid_04331_calendar_data_model.sql'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Schema mirrors
// ---------------------------------------------------------------------------
describe('types mirror the migration CHECKs', () => {
  it('source types', () => {
    for (const t of CALENDAR_SOURCE_TYPES) expect(migration).toContain(`'${t}'`);
  });
  it('role contexts', () => {
    const check = migration.slice(migration.indexOf('valid_role_context'));
    for (const c of CALENDAR_ROLE_CONTEXTS) expect(check).toContain(`'${c}'`);
  });
  it('rrule regex is the same in SQL and TS', () => {
    const sql = /rrule ~ '([^']+)'/.exec(migration)![1];
    expect(RRULE_PATTERN.source).toBe(sql);
  });
  it('the create schema accepts the new columns and rejects bad ones', () => {
    const base = { title: 'Walk', start_time: '2026-10-01T07:30:00Z' };
    expect(CreateCalendarEventSchema.safeParse({ ...base, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE', reminder_offsets: [10], emoji: '🏃', timezone: 'Europe/Berlin' }).success).toBe(true);
    expect(CreateCalendarEventSchema.safeParse({ ...base, rrule: 'FREQ=HOURLY' }).success).toBe(false);
    expect(CreateCalendarEventSchema.safeParse({ ...base, reminder_offsets: [-1] }).success).toBe(false);
    expect(CreateCalendarEventSchema.safeParse({ ...base, reminder_offsets: [1, 2, 3, 4, 5, 6] }).success).toBe(false);
    expect(CreateCalendarEventSchema.safeParse({ ...base, source_type: 'lab_order' }).success).toBe(true);
    expect(CreateCalendarEventSchema.safeParse({ ...base, role_context: 'professional' }).success).toBe(true);
  });
  it('professional is its own lens', () => {
    expect(getVisibleContexts('professional')).toEqual(['professional', 'personal']);
  });
});

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------
describe('parseRRule', () => {
  it('parses the supported parts', () => {
    expect(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO;COUNT=4')).toEqual({
      freq: 'WEEKLY', interval: 2, count: 4, until: null, byday: [1, 5],
    });
    expect(parseRRule('FREQ=DAILY;UNTIL=20261231T235959Z')!.until).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
  });
  it('rejects what the CHECK rejects', () => {
    expect(parseRRule('FREQ=HOURLY')).toBeNull();
    expect(parseRRule('FREQ=DAILY;INTERVAL=0')).toBeNull();
    expect(parseRRule('FREQ=WEEKLY;BYDAY=XX')).toBeNull();
  });
});

describe('expandOccurrences', () => {
  const TZ = 'Europe/Berlin';

  it('daily habit keeps 07:30 local across the DST change', () => {
    // 2026-10-24 07:30 CEST (05:30Z); DST ends 2026-10-25.
    const occ = expandOccurrences(
      { start_time: '2026-10-24T05:30:00Z', end_time: '2026-10-24T05:45:00Z', rrule: 'FREQ=DAILY', timezone: TZ },
      { from: '2026-10-24T00:00:00Z', to: '2026-10-27T00:00:00Z' },
      TZ,
    );
    expect(occ.map((o) => o.start)).toEqual([
      '2026-10-24T05:30:00.000Z', // 07:30 CEST
      '2026-10-25T06:30:00.000Z', // 07:30 CET
      '2026-10-26T06:30:00.000Z',
    ]);
    expect(occ[1].end).toBe('2026-10-25T06:45:00.000Z');
  });

  it('weekly BYDAY, window filter and series index', () => {
    // Monday 2026-10-05 18:00 Berlin
    const start = new Date(zonedTimeToEpoch(2026, 10, 5, 18, 0, 0, TZ)).toISOString();
    const occ = expandOccurrences(
      { start_time: start, end_time: null, rrule: 'FREQ=WEEKLY;BYDAY=MO,TH' },
      { from: '2026-10-08T00:00:00Z', to: '2026-10-20T00:00:00Z' },
      TZ,
    );
    // Mon 5 (index 0) is before the window: Thu 8, Mon 12, Thu 15, Mon 19.
    expect(occ.map((o) => [o.start.slice(0, 10), o.index])).toEqual([
      ['2026-10-08', 1], ['2026-10-12', 2], ['2026-10-15', 3], ['2026-10-19', 4],
    ]);
  });

  it('COUNT and UNTIL stop the series', () => {
    const w = { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' };
    expect(expandOccurrences({ start_time: '2026-03-01T08:00:00Z', end_time: null, rrule: 'FREQ=DAILY;COUNT=3' }, w, 'UTC')).toHaveLength(3);
    expect(expandOccurrences({ start_time: '2026-03-01T08:00:00Z', end_time: null, rrule: 'FREQ=DAILY;UNTIL=20260305T080000Z' }, w, 'UTC')).toHaveLength(5);
  });

  it('monthly on the 31st skips short months', () => {
    const occ = expandOccurrences(
      { start_time: '2026-01-31T09:00:00Z', end_time: null, rrule: 'FREQ=MONTHLY;COUNT=4' },
      { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' },
      'UTC',
    );
    expect(occ.map((o) => o.start.slice(0, 10))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  });

  it('an invalid rule or window yields nothing', () => {
    expect(expandOccurrences({ start_time: '2026-01-01T00:00:00Z', end_time: null, rrule: 'nope' }, { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }, 'UTC')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Window + busy blocks
// ---------------------------------------------------------------------------
function ev(over: Record<string, unknown>): any {
  return {
    id: 'e', user_id: 'u', title: 'T', description: 'secret', location: 'Room 4', status: 'confirmed',
    start_time: '2026-10-05T10:00:00Z', end_time: '2026-10-05T11:00:00Z', role_context: 'community',
    rrule: null, timezone: null, source_ref_id: 'src', metadata: { attendees: ['x'] }, ...over,
  };
}

describe('buildCalendarWindow', () => {
  const window = { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' };
  const expand = (e: any) => expandOccurrences(e, window, 'UTC');

  it('developer lens: own + personal in full, community as busy blocks with no details', () => {
    const rows = [
      ev({ id: 'dev', role_context: 'developer', start_time: '2026-10-05T09:00:00Z' }),
      ev({ id: 'pers', role_context: 'personal', start_time: '2026-10-05T12:00:00Z', end_time: '2026-10-05T12:30:00Z' }),
      ev({ id: 'life', role_context: 'community', start_time: '2026-10-05T08:00:00Z', end_time: '2026-10-05T08:30:00Z' }),
    ];
    const items = buildCalendarWindow(rows, 'developer', window, { includeBusy: true, fallbackTz: 'UTC', expand });
    expect(items.map((i) => [i.id, i.busy])).toEqual([['life', true], ['dev', false], ['pers', false]]);
    const busy = items[0];
    expect(busy.event).toBeNull();
    expect(JSON.stringify(busy)).not.toMatch(/secret|Room 4|attendees|src/);
  });

  it('include_busy=false hides other lenses entirely; cancelled entries never show', () => {
    const rows = [ev({ id: 'life' }), ev({ id: 'gone', role_context: 'developer', status: 'cancelled' })];
    expect(buildCalendarWindow(rows, 'developer', window, { includeBusy: false, fallbackTz: 'UTC', expand })).toEqual([]);
  });

  it('super admin sees everything, nothing is busy', () => {
    const rows = [ev({ id: 'a' }), ev({ id: 'b', role_context: 'developer' })];
    expect(buildCalendarWindow(rows, 'super_admin', window, { includeBusy: true, fallbackTz: 'UTC', expand }).every((i) => !i.busy)).toBe(true);
  });

  it('recurring entries become one item per occurrence', () => {
    const rows = [ev({ id: 'habit', start_time: '2026-10-01T07:00:00Z', end_time: '2026-10-01T07:10:00Z', rrule: 'FREQ=DAILY' })];
    const items = buildCalendarWindow(rows, 'community', window, { includeBusy: true, fallbackTz: 'UTC', expand });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'habit::2026-10-05T07:00:00.000Z', event_id: 'habit', occurrence_index: 4, busy: false });
  });

  it('toBusyBlock keeps only time fields', () => {
    expect(Object.keys(toBusyBlock({ id: 'x', event_id: 'x', start_time: 'a', end_time: 'b', occurrence_index: null })).sort())
      .toEqual(['busy', 'end_time', 'event', 'event_id', 'id', 'occurrence_index', 'start_time']);
  });
});

// ---------------------------------------------------------------------------
// Producer contract (PostgREST mocked)
// ---------------------------------------------------------------------------
describe('producer contract', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; method: string; body: any }>;
  let db: any[];

  function mockFetch(handler?: (url: string, method: string, body: any) => Response | undefined) {
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), method, body });
      const custom = handler?.(String(url), method, body);
      if (custom) return custom;
      const u = new URL(String(url));
      const get = (k: string) => u.searchParams.get(k);
      const matches = (r: any) =>
        (!get('user_id') || get('user_id') === `eq.${r.user_id}`) &&
        (!get('source_ref_type') || get('source_ref_type') === `eq.${r.source_ref_type}`) &&
        (!get('source_ref_id') || get('source_ref_id') === `eq.${r.source_ref_id}`) &&
        (!get('id') || get('id') === `eq.${r.id}`);
      if (method === 'GET') return new Response(JSON.stringify(db.filter(matches)), { status: 200 });
      if (method === 'POST') {
        const row = { id: `id${db.length + 1}`, completed_at: null, ...body };
        db.push(row);
        return new Response(JSON.stringify([row]), { status: 201 });
      }
      if (method === 'PATCH') {
        const hit = db.filter(matches);
        hit.forEach((r) => Object.assign(r, body));
        return new Response(JSON.stringify(hit), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as any;
  }

  beforeEach(() => {
    calls = [];
    db = [];
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  const ref = { source_type: 'autopilot' as const, source_ref_type: 'autopilot_recommendation', source_ref_id: 'rec1' };

  it('creates once, then is a no-op, then updates only what changed', async () => {
    mockFetch();
    const entry = { title: 'Walk', start_time: '2026-10-05T10:00:00Z', event_type: 'workout' as const };
    expect((await upsertCalendarEntryFromSource('u1', ref, entry)).action).toBe('created');
    expect(db[0]).toMatchObject({ user_id: 'u1', source_type: 'autopilot', source_ref_id: 'rec1', status: 'confirmed' });

    db[0].start_time = '2026-10-05T10:00:00+00:00'; // how Postgres returns it
    expect((await upsertCalendarEntryFromSource('u1', ref, entry)).action).toBe('unchanged');

    const r = await upsertCalendarEntryFromSource('u1', ref, { ...entry, title: 'Long walk' });
    expect(r.action).toBe('updated');
    expect(calls.at(-1)!.body).toMatchObject({ title: 'Long walk' });
    expect(calls.at(-1)!.body).not.toHaveProperty('start_time');
  });

  it('never moves a completed entry; reactivates a cancelled one', async () => {
    mockFetch();
    db.push({ id: 'x', user_id: 'u1', ...ref, title: 'Walk', start_time: '2026-10-05T10:00:00Z', status: 'confirmed', completed_at: '2026-10-05T11:00:00Z', completion_status: 'completed' });
    expect((await upsertCalendarEntryFromSource('u1', ref, { title: 'Walk', start_time: '2026-10-06T10:00:00Z' })).action).toBe('kept_completed');
    db[0].completed_at = null; db[0].completion_status = null; db[0].status = 'cancelled';
    expect((await upsertCalendarEntryFromSource('u1', ref, { title: 'Walk', start_time: '2026-10-05T10:00:00Z' })).action).toBe('reactivated');
    expect(db[0].status).toBe('confirmed');
  });

  it('a lost insert race (409) becomes an update, not a failure', async () => {
    let first = true;
    mockFetch((url, method) => {
      if (method === 'POST' && first) {
        first = false;
        db.push({ id: 'w', user_id: 'u1', ...ref, title: 'Other', start_time: '2026-10-05T10:00:00Z', status: 'confirmed', completed_at: null });
        return new Response('{"code":"23505"}', { status: 409 });
      }
      return undefined;
    });
    const r = await upsertCalendarEntryFromSource('u1', ref, { title: 'Walk', start_time: '2026-10-05T10:00:00Z' });
    expect(r.action).toBe('updated');
    expect(db).toHaveLength(1);
  });

  it('a series cancels keys that dropped out of the plan', async () => {
    mockFetch();
    const series = { source_type: 'goal_plan' as const, source_ref_type: 'goal_plan_step', series_id: 'plan1' };
    await upsertCalendarSeriesFromSource('u1', series, [
      { key: 's1', title: 'A', start_time: '2026-10-05T09:00:00Z' },
      { key: 's2', title: 'B', start_time: '2026-10-06T09:00:00Z' },
    ]);
    const r = await upsertCalendarSeriesFromSource('u1', series, [{ key: 's1', title: 'A', start_time: '2026-10-05T09:00:00Z' }]);
    expect(r).toMatchObject({ created: 0, unchanged: 1 });
    const cancel = calls.at(-1)!;
    expect(cancel.method).toBe('PATCH');
    expect(decodeURIComponent(cancel.url)).toContain('source_ref_id=like.plan1:*');
    expect(decodeURIComponent(cancel.url)).toContain(`source_ref_id=not.in.("${seriesEntryRefId('plan1', 's1')}")`);
    expect(decodeURIComponent(cancel.url)).toContain('completed_at=is.null');
    expect(cancel.body).toMatchObject({ status: 'cancelled' });
  });

  it('completing the source ticks open entries off', async () => {
    mockFetch();
    await completeCalendarEntriesForSource('u1', 'autopilot_recommendation', 'rec1');
    const c = calls[0];
    expect(c.method).toBe('PATCH');
    expect(c.url).toContain('completed_at=is.null');
    expect(c.body).toMatchObject({ completion_status: 'completed' });
  });

  it('ticking an entry off completes its recommendation through the canonical RPC', async () => {
    mockFetch((url) => (url.includes('/rpc/') ? new Response('{"ok":true}', { status: 200 }) : undefined));
    const r = await completeSourceForCalendarEvent({ source_ref_type: 'autopilot_recommendation', source_ref_id: 'rec1' }, 'u1');
    expect(r.completed).toBe(true);
    expect(calls[0].url).toContain('/rpc/complete_autopilot_recommendation');
    expect(calls[0].body).toEqual({ p_recommendation_id: 'rec1', p_user_id: 'u1' });
  });

  it('other source types are left alone', async () => {
    mockFetch();
    expect((await completeSourceForCalendarEvent({ source_ref_type: 'provider_appointment', source_ref_id: 'x' }, 'u1')).completed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('diffEntry compares instants, not strings', () => {
    expect(diffEntry({ start_time: '2026-10-05T10:00:00+00:00' }, { start_time: '2026-10-05T10:00:00.000Z' })).toEqual({});
    expect(diffEntry({ reminder_offsets: [10] }, { reminder_offsets: [10, 60] })).toEqual({ reminder_offsets: [10, 60] });
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
describe('wiring', () => {
  const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
  it('calendar completion completes the source', () => {
    expect(src('src/routes/calendar.ts')).toContain('completeSourceForCalendarEvent(event, userId)');
  });
  it('recommendation completion completes its calendar entries', () => {
    expect(src('src/routes/autopilot-recommendations.ts')).toContain("completeCalendarEntriesForSource(userId, 'autopilot_recommendation', recId)");
  });
  it('the window route exists and is bounded', () => {
    const r = src('src/routes/calendar.ts');
    expect(r).toContain("router.get('/events/window'");
    expect(r).toContain('62 * 86_400_000');
  });
});
