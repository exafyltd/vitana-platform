/**
 * VTID-04373 — calendar reminders respect quiet hours, and pending reminder
 * text follows the entry when it is renamed.
 */

import {
  computeDesiredReminders,
  quietWindowFromPrefs,
  inQuietWindow,
  beforeQuietWindow,
  reminderText,
  reconcileCalendarReminders,
  QuietWindow,
  ReminderEntry,
} from '../src/services/calendar-reminders';

jest.mock('../src/services/daily-pace-service', () => ({ getUserTimezone: jest.fn(async () => 'Europe/Berlin') }));
jest.mock('../src/i18n/server-locale', () => ({ bulkGetUserLocales: jest.fn(async (_s: any, ids: string[]) => new Map(ids.map((i) => [i, 'de']))) }));

const NOW = Date.parse('2026-10-05T06:00:00Z'); // 08:00 Berlin
const TZ = 'Europe/Berlin';
const tzOf = () => TZ;
const NIGHT: QuietWindow = { startMin: 22 * 60, endMin: 7 * 60 };

function entry(over: Partial<ReminderEntry>): ReminderEntry {
  return {
    id: 'e1', user_id: 'u1', title: 'Sunset walk', start_time: '2026-10-05T16:00:00Z', end_time: '2026-10-05T17:00:00Z',
    event_type: 'community', source_type: 'manual', status: 'confirmed', completed_at: null, ...over,
  } as ReminderEntry;
}

describe('quiet window', () => {
  it('reads the preferences row; off, missing or empty windows are null', () => {
    expect(quietWindowFromPrefs({ dnd_enabled: true, dnd_start_time: '22:00:00', dnd_end_time: '07:00:00' })).toEqual(NIGHT);
    expect(quietWindowFromPrefs({ dnd_enabled: false, dnd_start_time: '22:00', dnd_end_time: '07:00' })).toBeNull();
    expect(quietWindowFromPrefs({ dnd_enabled: true, dnd_start_time: null, dnd_end_time: '07:00' })).toBeNull();
    expect(quietWindowFromPrefs({ dnd_enabled: true, dnd_start_time: '22:00', dnd_end_time: '22:00' })).toBeNull();
    expect(quietWindowFromPrefs({ dnd_enabled: true, dnd_start_time: '25:00', dnd_end_time: '07:00' })).toBeNull();
    expect(quietWindowFromPrefs(null)).toBeNull();
  });

  it('a window wrapping midnight covers the late evening and the early morning, local time', () => {
    expect(inQuietWindow(Date.parse('2026-10-05T20:30:00Z'), NIGHT, TZ)).toBe(true); // 22:30 Berlin
    expect(inQuietWindow(Date.parse('2026-10-06T04:00:00Z'), NIGHT, TZ)).toBe(true); // 06:00
    expect(inQuietWindow(Date.parse('2026-10-06T05:00:00Z'), NIGHT, TZ)).toBe(false); // 07:00
    expect(inQuietWindow(Date.parse('2026-10-05T19:59:00Z'), NIGHT, TZ)).toBe(false); // 21:59
    const lunch: QuietWindow = { startMin: 12 * 60, endMin: 13 * 60 };
    expect(inQuietWindow(Date.parse('2026-10-05T10:30:00Z'), lunch, TZ)).toBe(true); // 12:30
    expect(inQuietWindow(Date.parse('2026-10-05T11:00:00Z'), lunch, TZ)).toBe(false); // 13:00
  });

  it('moves to one minute before the window began — yesterday evening for a morning time', () => {
    expect(new Date(beforeQuietWindow(Date.parse('2026-10-06T04:00:00Z'), NIGHT, TZ)).toISOString()).toBe('2026-10-05T19:59:00.000Z');
    expect(new Date(beforeQuietWindow(Date.parse('2026-10-05T21:00:00Z'), NIGHT, TZ)).toISOString()).toBe('2026-10-05T19:59:00.000Z');
  });

  it('is DST-aware: the night the clocks go back keeps 21:59 local', () => {
    // 25 Oct 2026, 06:00 CET (+1) → 21:59 on 24 Oct, still CEST (+2).
    expect(new Date(beforeQuietWindow(Date.parse('2026-10-25T05:00:00Z'), NIGHT, TZ)).toISOString()).toBe('2026-10-24T19:59:00.000Z');
  });
});

describe('computeDesiredReminders with quiet hours', () => {
  const quietOf = () => NIGHT;

  it('an early workout reminds the evening before, not inside quiet hours', () => {
    const run = entry({ event_type: 'workout', title: 'Zone-2 run', start_time: '2026-10-06T04:30:00Z', end_time: null }); // 06:30 Berlin
    expect(computeDesiredReminders([run], { now: NOW, tzOf })).toEqual([
      expect.objectContaining({ fire_at: '2026-10-06T04:00:00.000Z', offset_minutes: 30 }),
    ]);
    const d = computeDesiredReminders([run], { now: NOW, tzOf, quietOf });
    expect(d).toEqual([expect.objectContaining({ fire_at: '2026-10-05T19:59:00.000Z', offset_minutes: 511, quiet_shifted: true })]);
  });

  it('a daytime reminder is untouched', () => {
    const d = computeDesiredReminders([entry({})], { now: NOW, tzOf, quietOf });
    expect(d).toEqual([expect.objectContaining({ fire_at: '2026-10-05T15:50:00.000Z', offset_minutes: 10 })]);
    expect(d[0].quiet_shifted).toBeUndefined();
  });

  it('a lab keeps its 19:00 heads-up and drops the moved 1-hour one', () => {
    const lab = entry({ id: 'lab', event_type: 'health', source_type: 'lab_order' as any, start_time: '2026-10-06T05:00:00Z', end_time: null }); // 07:00
    const d = computeDesiredReminders([lab], { now: NOW, tzOf, quietOf });
    expect(d.map((r) => r.fire_at)).toEqual(['2026-10-05T17:00:00.000Z']);
  });

  it('the entry’s own offsets are left where the member put them', () => {
    const own = entry({ event_type: 'workout', reminder_offsets: [30], start_time: '2026-10-06T04:30:00Z', end_time: null });
    const d = computeDesiredReminders([own], { now: NOW, tzOf, quietOf });
    expect(d).toEqual([expect.objectContaining({ fire_at: '2026-10-06T04:00:00.000Z', offset_minutes: 30 })]);
  });

  it('a moved reminder never lands after the entry or outside the window being built', () => {
    const run = entry({ event_type: 'workout', start_time: '2026-10-06T04:30:00Z', end_time: null });
    for (const r of computeDesiredReminders([run], { now: NOW, tzOf, quietOf })) {
      expect(Date.parse(r.fire_at)).toBeLessThanOrEqual(Date.parse(r.occurrence_start));
      expect(inQuietWindow(Date.parse(r.fire_at), NIGHT, TZ)).toBe(false);
    }
  });
});

describe('reminderText for a reminder on the day before', () => {
  const de: Record<string, string> = {
    'notif.calendar_reminder.in_minutes': '{title} in {minutes} Min.',
    'notif.calendar_reminder.in_hours': '{title} in {hours} Std.',
    'notif.calendar_reminder.now': '{title} — jetzt',
    'notif.calendar_reminder.tomorrow': 'Morgen um {time}: {title}',
  };
  const tr = (k: string, p: Record<string, string | number>) => de[k].replace(/\{(\w+)\}/g, (_, n) => String(p[n]));

  it('a reminder moved out of quiet hours reads "tomorrow at 06:30"', () => {
    const run = entry({ event_type: 'workout', title: 'Zone-2 run', start_time: '2026-10-06T04:30:00Z', end_time: null });
    const [d] = computeDesiredReminders([run], { now: NOW, tzOf, quietOf: () => NIGHT });
    expect(reminderText(run, d, tr)).toBe('Morgen um 06:30: 🏃 Zone-2 run');
  });

  it('a same-day reminder keeps its "in N" wording', () => {
    const [d] = computeDesiredReminders([entry({})], { now: NOW, tzOf });
    expect(reminderText(entry({}), d, tr)).toBe('🎉 Sunset walk in 10 Min.');
  });
});

describe('reconcile: quiet hours and text refresh', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; method: string; body: any }>;
  afterAll(() => { global.fetch = realFetch; });

  function run(entries: ReminderEntry[], existing: any[], prefs: any[] | 'fail' = []) {
    calls = [];
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      const u = String(url);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: u, method, body });
      const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
      if (u.includes('/calendar_events')) return json(u.includes('rrule=is.null') ? entries : []);
      if (u.includes('/user_notification_preferences')) return prefs === 'fail' ? json({ message: 'boom' }, 500) : json(prefs);
      if (u.includes('/reminders') && method === 'GET') return json(existing);
      if (u.includes('/user_tenants')) return json([{ user_id: 'u1', tenant_id: 't1', is_primary: true }]);
      if (u.includes('/reminders') && method === 'POST') return json(body);
      if (u.includes('/reminders') && method === 'PATCH') return json(existing.filter((r) => u.includes(r.id)));
      return json([]);
    }) as any;
    return reconcileCalendarReminders(NOW);
  }

  const earlyRun = () => entry({ event_type: 'workout', title: 'Zone-2 run', start_time: '2026-10-06T04:30:00Z', end_time: null });

  it('writes the reminder before quiet hours when the member has them on', async () => {
    const r = await run([earlyRun()], [], [{ user_id: 'u1', dnd_enabled: true, dnd_start_time: '22:00:00', dnd_end_time: '07:00:00' }]);
    expect(r).toMatchObject({ ok: true, created: 1 });
    const pref = calls.find((c) => c.url.includes('/user_notification_preferences'))!;
    expect(pref.url).toContain('dnd_enabled=is.true');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body[0]).toMatchObject({ next_fire_at: '2026-10-05T19:59:00.000Z', reminder_offset_minutes: 511 });
    expect(post.body[0].action_text).toContain('06:30');
  });

  it('a failed quiet-hours read keeps the usual time instead of failing the tick', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await run([earlyRun()], [], 'fail');
    expect(r).toMatchObject({ ok: true, created: 1 });
    expect(calls.find((c) => c.method === 'POST')!.body[0].next_fire_at).toBe('2026-10-06T04:00:00.000Z');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quiet-hours read failed 500'));
    warn.mockRestore();
  });

  it('a renamed entry gets its pending reminder text rewritten', async () => {
    const existing = [{
      id: 'r1', calendar_event_id: 'e1', calendar_occurrence_start: '2026-10-05T16:00:00Z', reminder_offset_minutes: 10,
      action_text: '🎉 Old name in 10 Min.',
    }];
    const r = await run([entry({})], existing);
    expect(r).toMatchObject({ ok: true, created: 0, cancelled: 0, refreshed: 1 });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('id=eq.r1');
    expect(patch.url).toContain('status=eq.pending');
    expect(patch.body).toMatchObject({ action_text: '🎉 Sunset walk in 10 Min.', spoken_message: '🎉 Sunset walk in 10 Min.' });
  });

  it('matching text is left alone', async () => {
    const existing = [{
      id: 'r1', calendar_event_id: 'e1', calendar_occurrence_start: '2026-10-05T16:00:00Z', reminder_offset_minutes: 10,
      action_text: '🎉 Sunset walk in 10 Min.',
    }];
    expect(await run([entry({})], existing)).toMatchObject({ refreshed: 0 });
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });
});
