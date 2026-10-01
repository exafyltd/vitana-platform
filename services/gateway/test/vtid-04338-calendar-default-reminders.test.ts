/**
 * VTID-04338 — calendar step 3: default reminders on every calendar entry.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  reminderRules,
  entryEmoji,
  computeDesiredReminders,
  reminderText,
  reminderKey,
  reconcileCalendarReminders,
  isCalendarRemindersEnabled,
  startCalendarRemindersLoop,
  ReminderEntry,
} from '../src/services/calendar-reminders';

jest.mock('../src/services/daily-pace-service', () => ({ getUserTimezone: jest.fn(async () => 'Europe/Berlin') }));
jest.mock('../src/i18n/server-locale', () => ({ bulkGetUserLocales: jest.fn(async (_s: any, ids: string[]) => new Map(ids.map((i) => [i, 'de']))) }));

const NOW = Date.parse('2026-10-05T06:00:00Z'); // 08:00 Berlin
const tzOf = () => 'Europe/Berlin';

function entry(over: Partial<ReminderEntry>): ReminderEntry {
  return {
    id: 'e1', user_id: 'u1', title: 'Sunset walk', start_time: '2026-10-05T16:00:00Z', end_time: '2026-10-05T17:00:00Z',
    event_type: 'community', source_type: 'manual', status: 'confirmed', completed_at: null, ...over,
  } as ReminderEntry;
}

describe('rules (owner-approved defaults)', () => {
  it('meeting / event 10 min, workout 30 min, habit at time, lab evening before + 1 h', () => {
    expect(reminderRules(entry({ event_type: 'community' }))).toEqual([{ kind: 'before', minutes: 10 }]);
    expect(reminderRules(entry({ event_type: 'workout' }))).toEqual([{ kind: 'before', minutes: 30 }]);
    expect(reminderRules(entry({ event_type: 'wellness_nudge' }))).toEqual([{ kind: 'before', minutes: 0 }]);
    expect(reminderRules(entry({ event_type: 'health', source_type: 'lab_order' as any }))).toEqual([
      { kind: 'evening_before', hour: 19 }, { kind: 'before', minutes: 60 },
    ]);
  });
  it('the entry’s own offsets win; {} means no reminders', () => {
    expect(reminderRules(entry({ reminder_offsets: [5, 1440, 5] }))).toEqual([{ kind: 'before', minutes: 5 }, { kind: 'before', minutes: 1440 }]);
    expect(reminderRules(entry({ reminder_offsets: [] }))).toEqual([]);
  });
  it('emoji: own, lab, per type, fallback', () => {
    expect(entryEmoji(entry({ emoji: '🧘' }))).toBe('🧘');
    expect(entryEmoji(entry({ source_type: 'lab_order' as any }))).toBe('🧪');
    expect(entryEmoji(entry({ event_type: 'workout' }))).toBe('🏃');
    expect(entryEmoji(entry({ event_type: 'unknown' as any }))).toBe('📌');
  });
});

describe('computeDesiredReminders', () => {
  it('one 10-min reminder for an event later today', () => {
    const d = computeDesiredReminders([entry({})], { now: NOW, tzOf });
    expect(d).toEqual([expect.objectContaining({ calendar_event_id: 'e1', offset_minutes: 10, fire_at: '2026-10-05T15:50:00.000Z', rule: 'before' })]);
  });

  it('lab tomorrow 08:00 Berlin: 19:00 local the evening before, and 07:00 local', () => {
    const lab = entry({ id: 'lab', event_type: 'health', source_type: 'lab_order' as any, start_time: '2026-10-06T06:00:00Z', end_time: null });
    const d = computeDesiredReminders([lab], { now: NOW, tzOf });
    expect(d.map((x) => [x.rule, x.fire_at, x.offset_minutes])).toEqual([
      ['evening_before', '2026-10-05T17:00:00.000Z', 780],
      ['before', '2026-10-06T05:00:00.000Z', 60],
    ]);
  });

  it('skips cancelled, completed, beyond-horizon; keeps recently due ones for sync', () => {
    const out = computeDesiredReminders([
      entry({ id: 'c', status: 'cancelled' }),
      entry({ id: 'd', completed_at: '2026-10-05T05:00:00Z' }),
      entry({ id: 'far', start_time: '2026-10-20T10:00:00Z' }),
      entry({ id: 'due', start_time: '2026-10-05T06:05:00Z' }), // fired 5 min ago
    ], { now: NOW, tzOf });
    expect(out.map((x) => x.calendar_event_id)).toEqual(['due']);
  });

  it('a daily habit gets one reminder per occurrence inside the 36 h horizon, at 07:30 local', () => {
    const habit = entry({ id: 'h', event_type: 'wellness_nudge', start_time: '2026-10-01T05:30:00Z', end_time: null, rrule: 'FREQ=DAILY', timezone: 'Europe/Berlin' });
    const out = computeDesiredReminders([habit], { now: NOW, lookbackMs: 0, tzOf });
    expect(out.map((x) => x.fire_at)).toEqual(['2026-10-06T05:30:00.000Z']);
  });

  it('an offset longer than the time until the event still fires if inside the horizon', () => {
    const e = entry({ id: 'w', start_time: '2026-10-06T10:00:00Z', reminder_offsets: [1440] });
    expect(computeDesiredReminders([e], { now: NOW, tzOf })[0].fire_at).toBe('2026-10-05T10:00:00.000Z');
  });
});

describe('reminderText', () => {
  const de: Record<string, string> = {
    'notif.calendar_reminder.in_minutes': '{title} in {minutes} Min.',
    'notif.calendar_reminder.in_hours': '{title} in {hours} Std.',
    'notif.calendar_reminder.now': '{title} — jetzt',
    'notif.calendar_reminder.tomorrow': 'Morgen um {time}: {title}',
  };
  const tr = (k: string, p: Record<string, string | number>) => de[k].replace(/\{(\w+)\}/g, (_, n) => String(p[n]));
  const base = { key: 'k', user_id: 'u1', calendar_event_id: 'e1', occurrence_start: '2026-10-06T06:00:00.000Z', fire_at: '', timezone: 'Europe/Berlin' };

  it('renders every variant with the emoji and local time', () => {
    const e = entry({ event_type: 'workout', title: 'Zone-2 run' });
    expect(reminderText(e, { ...base, offset_minutes: 30, rule: 'before' }, tr)).toBe('🏃 Zone-2 run in 30 Min.');
    expect(reminderText(e, { ...base, offset_minutes: 180, rule: 'before' }, tr)).toBe('🏃 Zone-2 run in 3 Std.');
    expect(reminderText(e, { ...base, offset_minutes: 0, rule: 'before' }, tr)).toBe('🏃 Zone-2 run — jetzt');
    expect(reminderText(entry({ source_type: 'lab_order' as any, title: 'Bluttest' }), { ...base, offset_minutes: 780, rule: 'evening_before' }, tr))
      .toBe('Morgen um 08:00: 🧪 Bluttest');
  });
});

describe('catalog', () => {
  it('every new key exists in DE and EN (tsc enforces), and in each translated locale', () => {
    const dir = path.resolve(__dirname, '../src/i18n/locales');
    for (const loc of ['de', 'en', 'es', 'fr', 'pl', 'pt', 'ru', 'sr', 'tr', 'zh']) {
      const json = JSON.parse(fs.readFileSync(path.join(dir, `${loc}.json`), 'utf8'));
      for (const k of ['in_minutes', 'in_hours', 'now', 'tomorrow']) {
        expect(json[`notif.calendar_reminder.${k}`]).toContain('{title}');
      }
    }
  });
});

describe('reconcile', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; method: string; body: any }>;
  afterAll(() => { global.fetch = realFetch; });

  function run(entries: ReminderEntry[], existing: any[], tenants = [{ user_id: 'u1', tenant_id: 't1', is_primary: true }]) {
    calls = [];
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      const u = String(url);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: u, method, body });
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
      if (u.includes('/calendar_events')) return json(u.includes('rrule=is.null') ? entries : []);
      if (u.includes('/reminders') && method === 'GET') return json(existing);
      if (u.includes('/user_tenants')) return json(tenants);
      if (u.includes('/reminders') && method === 'POST') return json(body);
      if (u.includes('/reminders') && method === 'PATCH') return json(existing.filter((r) => u.includes(r.id)));
      return json([]);
    }) as any;
    return reconcileCalendarReminders(NOW);
  }

  it('creates the missing reminder with localized text, tenant and link columns', async () => {
    const r = await run([entry({})], []);
    expect(r).toMatchObject({ ok: true, created: 1, cancelled: 0 });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('on_conflict=calendar_event_id,calendar_occurrence_start,reminder_offset_minutes');
    expect(post.body[0]).toMatchObject({
      user_id: 'u1', tenant_id: 't1', created_via: 'system', status: 'pending',
      calendar_event_id: 'e1', calendar_occurrence_start: '2026-10-05T16:00:00.000Z', reminder_offset_minutes: 10,
      next_fire_at: '2026-10-05T15:50:00.000Z', user_tz: 'Europe/Berlin', action_text: '🎉 Sunset walk in 10 Min.',
    });
    expect(post.body[0].spoken_message).toBe(post.body[0].action_text);
  });

  it('is a no-op when the reminder already exists', async () => {
    const existing = [{ id: 'r1', calendar_event_id: 'e1', calendar_occurrence_start: '2026-10-05T16:00:00+00:00', reminder_offset_minutes: 10 }];
    const r = await run([entry({})], existing);
    expect(r).toMatchObject({ created: 0, cancelled: 0 });
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('a moved entry: old reminder cancelled, new one created', async () => {
    const existing = [{ id: 'old1', calendar_event_id: 'e1', calendar_occurrence_start: '2026-10-05T15:00:00Z', reminder_offset_minutes: 10 }];
    const r = await run([entry({})], existing);
    expect(r).toMatchObject({ created: 1, cancelled: 1 });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(decodeURIComponent(patch.url)).toContain('id=in.("old1")');
    expect(patch.url).toContain('status=eq.pending');
    expect(patch.body).toMatchObject({ status: 'cancelled' });
  });

  it('a deleted / cancelled entry loses its pending reminders', async () => {
    const existing = [{ id: 'gone1', calendar_event_id: 'deleted', calendar_occurrence_start: '2026-10-05T16:00:00Z', reminder_offset_minutes: 10 }];
    expect(await run([], existing)).toMatchObject({ created: 0, cancelled: 1 });
  });

  it('a user without a tenant is skipped, not failed', async () => {
    expect(await run([entry({})], [], [])).toMatchObject({ ok: true, created: 0, skipped_no_tenant: 1 });
  });

  it('keys normalise the occurrence timestamp', () => {
    expect(reminderKey('e', '2026-10-05T16:00:00+00:00', 10)).toBe(reminderKey('e', '2026-10-05T16:00:00.000Z', 10));
  });
});

describe('flag and wiring', () => {
  it('needs the exact string "true" and does not start without it', () => {
    expect(isCalendarRemindersEnabled(undefined)).toBe(false);
    expect(isCalendarRemindersEnabled('TRUE')).toBe(false);
    expect(isCalendarRemindersEnabled('true')).toBe(true);
    delete process.env.CALENDAR_DEFAULT_REMINDERS_ENABLED;
    expect(startCalendarRemindersLoop()).toBe(false);
  });
  it('startup starts the loop; staging pins it; prod does not', () => {
    const root = path.resolve(__dirname, '..');
    expect(fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')).toContain('startCalendarRemindersLoop()');
    const wf = path.resolve(root, '../../.github/workflows');
    const staging = fs.readFileSync(path.join(wf, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(staging).toContain('{name:"CALENDAR_DEFAULT_REMINDERS_ENABLED", value:"true"}');
    const strip = staging.slice(staging.indexOf('.containerDefinitions[0].environment |='));
    expect(strip.slice(0, strip.indexOf('| not) ]'))).toContain('"CALENDAR_DEFAULT_REMINDERS_ENABLED"');
    expect(fs.readFileSync(path.join(wf, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8')).not.toContain('CALENDAR_DEFAULT_REMINDERS_ENABLED');
  });
});

describe('window read carries the same reminders the loop writes (VTID-04351)', () => {
  it('the /events/window route decorates entries with reminderRules + entryEmoji, never busy blocks', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/calendar.ts'), 'utf8');
    const route = src.slice(src.indexOf("router.get('/events/window'"), src.indexOf("router.get('/events/upcoming'"));
    expect(route).toContain("import('../services/calendar-reminders')");
    expect(route).toContain('reminders: reminderRules(it.event');
    expect(route).toContain('display_emoji: entryEmoji(it.event');
    expect(route).toMatch(/it\.event\s*\?/); // busy blocks (event null) pass through untouched
  });
});
