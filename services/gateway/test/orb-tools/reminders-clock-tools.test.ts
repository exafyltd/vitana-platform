/**
 * Reminders lifecycle (VTID-02763) + Clock (VTID-02779) voice tools.
 *
 * Mocked SupabaseClient only — no network, no real DB. Each tool gets a
 * happy path (ok:true + speakable text with real content) and, where the
 * tool touches user data, the unauthenticated case.
 */

import {
  REMINDERS_CLOCK_TOOL_HANDLERS,
  REMINDERS_CLOCK_TOOL_DECLARATIONS,
  tool_snooze_reminder,
  tool_update_reminder,
  tool_acknowledge_reminder,
  tool_complete_reminder,
  tool_list_missed_reminders,
  tool_set_alarm,
  tool_list_alarms,
  tool_delete_alarm,
  tool_start_timer,
  tool_start_pomodoro,
  tool_list_active_timers,
  tool_get_world_time,
  computeNextAlarmFire,
} from '../../src/services/orb-tools/reminders-clock-tools';

const IDENT: any = { user_id: 'u-1', tenant_id: 't-1', role: null, lang: 'en' };
const ANON: any = { user_id: '', tenant_id: null, role: null };

const TOOL_NAMES = [
  'snooze_reminder',
  'update_reminder',
  'acknowledge_reminder',
  'complete_reminder',
  'list_missed_reminders',
  'set_alarm',
  'list_alarms',
  'delete_alarm',
  'start_timer',
  'start_pomodoro',
  'list_active_timers',
  'get_world_time',
];

// ---------------------------------------------------------------------------
// Chainable supabase mock. Every builder method returns the builder; awaiting
// the builder (or .single()/.maybeSingle()) resolves to the given result.
// sbWith(...) sequences one builder per .from() call.
// ---------------------------------------------------------------------------

function chain(result: { data?: unknown; error?: { message: string } | null }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null };
  const b: any = {};
  for (const m of ['select', 'eq', 'in', 'is', 'or', 'ilike', 'order', 'limit', 'update', 'insert']) {
    b[m] = jest.fn(() => b);
  }
  b.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  b.single = jest.fn(() => Promise.resolve(resolved));
  b.then = (res: any, rej: any) => Promise.resolve(resolved).then(res, rej);
  return b;
}

function sbWith(...chains: any[]) {
  const from = jest.fn();
  for (const c of chains) from.mockReturnValueOnce(c);
  return { from } as any;
}

function reminderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    user_id: 'u-1',
    tenant_id: 't-1',
    action_text: 'Take magnesium',
    spoken_message: 'Time to take your magnesium',
    description: null,
    next_fire_at: new Date(Date.now() + 3_600_000).toISOString(),
    user_tz: 'Europe/Berlin',
    status: 'pending',
    delivery_via: null,
    fired_at: null,
    acked_at: null,
    snooze_count: 0,
    tts_audio_b64: null,
    tts_voice: null,
    tts_lang: 'en',
    calendar_event_id: null,
    created_via: 'voice',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function clockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    tenant_id: 't-1',
    user_id: 'u-1',
    kind: 'alarm',
    label: null,
    fires_at: new Date(Date.now() + 3_600_000).toISOString(),
    recurrence: null,
    duration_seconds: null,
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Exports contract
// ---------------------------------------------------------------------------

describe('exports', () => {
  it.each(TOOL_NAMES)('%s is in REMINDERS_CLOCK_TOOL_HANDLERS', (name) => {
    expect(typeof REMINDERS_CLOCK_TOOL_HANDLERS[name]).toBe('function');
  });

  it.each(TOOL_NAMES)('%s is declared', (name) => {
    expect(REMINDERS_CLOCK_TOOL_DECLARATIONS.find((d) => d.name === name)).toBeDefined();
  });

  it('declarations avoid Vertex-fatal OpenAPI keys (default/minimum/maximum/format/examples)', () => {
    const forbidden = ['default', 'minimum', 'maximum', 'format', 'examples'];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        expect(forbidden).not.toContain(k);
        walk(v);
      }
    };
    for (const d of REMINDERS_CLOCK_TOOL_DECLARATIONS) walk(d.parameters);
  });
});

// ---------------------------------------------------------------------------
// snooze_reminder
// ---------------------------------------------------------------------------

describe('tool_snooze_reminder', () => {
  it('snoozes by reminder_id and speaks the new time', async () => {
    const row = reminderRow({ status: 'fired', snooze_count: 1 });
    const resolveChain = chain({ data: row });
    const updateChain = chain({ data: { ...row, snooze_count: 2, status: 'pending' } });
    const sb = sbWith(resolveChain, updateChain);

    const res = await tool_snooze_reminder({ reminder_id: 'r-1', minutes: 15 }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Take magnesium');
    expect((res as any).text).toContain('15 minutes');
    // status machine reset matches the REST snooze route
    const payload = updateChain.update.mock.calls[0][0];
    expect(payload.status).toBe('pending');
    expect(payload.fired_at).toBeNull();
    expect(payload.acked_at).toBeNull();
    expect(payload.snooze_count).toBe(2);
  });

  it('asks to disambiguate when text_query matches several reminders', async () => {
    const rows = [reminderRow(), reminderRow({ id: 'r-2', action_text: 'Take vitamin D' })];
    const sb = sbWith(chain({ data: rows }));
    const res = await tool_snooze_reminder({ text_query: 'take' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('2 matching reminders');
    expect((res as any).text).toContain('r-1');
    expect((res as any).text).toContain('Take vitamin D');
    expect((res as any).text).toContain('reminder_id');
  });

  it('errors when nothing matches', async () => {
    const sb = sbWith(chain({ data: [] }));
    const res = await tool_snooze_reminder({ text_query: 'nope' }, IDENT, sb);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('nope');
  });

  it('requires reminder_id or text_query', async () => {
    const res = await tool_snooze_reminder({}, IDENT, sbWith());
    expect(res.ok).toBe(false);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_snooze_reminder({ reminder_id: 'r-1' }, ANON, sbWith());
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('authenticated');
  });
});

// ---------------------------------------------------------------------------
// update_reminder
// ---------------------------------------------------------------------------

describe('tool_update_reminder', () => {
  it('updates text + time, resets delivery state, drops stale TTS', async () => {
    const row = reminderRow();
    const newIso = new Date(Date.now() + 7_200_000).toISOString();
    const updateChain = chain({ data: { ...row, action_text: 'Take zinc', next_fire_at: newIso } });
    const sb = sbWith(chain({ data: row }), updateChain);

    const res = await tool_update_reminder(
      { reminder_id: 'r-1', new_text: 'Take zinc', new_time: newIso },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Take zinc');
    const payload = updateChain.update.mock.calls[0][0];
    expect(payload.action_text).toBe('Take zinc');
    expect(payload.spoken_message).toBe('Take zinc');
    expect(payload.tts_audio_b64).toBeNull();
    expect(payload.status).toBe('pending');
    expect(payload.next_fire_at).toBe(newIso);
  });

  it('rejects a new_time in the past', async () => {
    const sb = sbWith(chain({ data: reminderRow() }));
    const res = await tool_update_reminder(
      { reminder_id: 'r-1', new_time: new Date(Date.now() - 1000).toISOString() },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('60 seconds');
  });

  it('requires new_text or new_time', async () => {
    const res = await tool_update_reminder({ reminder_id: 'r-1' }, IDENT, sbWith());
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('new_text');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_update_reminder({ reminder_id: 'r-1', new_text: 'x' }, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// acknowledge_reminder / complete_reminder
// ---------------------------------------------------------------------------

describe('tool_acknowledge_reminder', () => {
  it('acks a fired reminder', async () => {
    const row = reminderRow({ status: 'fired' });
    const updateChain = chain({ data: { id: 'r-1', acked_at: new Date().toISOString(), delivery_via: 'manual' } });
    const sb = sbWith(chain({ data: row }), updateChain);

    const res = await tool_acknowledge_reminder({ reminder_id: 'r-1' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Acknowledged');
    expect((res as any).text).toContain('Take magnesium');
    expect(updateChain.update.mock.calls[0][0].delivery_via).toBe('manual');
    expect(updateChain.update.mock.calls[0][0].acked_at).toBeTruthy();
  });

  it('requires an authenticated user', async () => {
    const res = await tool_acknowledge_reminder({ reminder_id: 'r-1' }, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

describe('tool_complete_reminder', () => {
  it('marks the reminder completed', async () => {
    const row = reminderRow({ status: 'fired' });
    const updateChain = chain({ data: { ...row, status: 'completed' } });
    const sb = sbWith(chain({ data: row }), updateChain);

    const res = await tool_complete_reminder({ reminder_id: 'r-1' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Take magnesium');
    expect((res as any).text).toContain('completed');
    expect(updateChain.update.mock.calls[0][0].status).toBe('completed');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_complete_reminder({ reminder_id: 'r-1' }, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list_missed_reminders
// ---------------------------------------------------------------------------

describe('tool_list_missed_reminders', () => {
  it('lists fired-but-unacked reminders with their content', async () => {
    const rows = [
      reminderRow({ status: 'fired', fired_at: new Date(Date.now() - 3_600_000).toISOString() }),
      reminderRow({
        id: 'r-2',
        action_text: 'Call the doctor',
        status: 'fired',
        fired_at: new Date(Date.now() - 7_200_000).toISOString(),
      }),
    ];
    const sb = sbWith(chain({ data: rows }));
    const res = await tool_list_missed_reminders({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('2 missed reminder(s)');
    expect((res as any).text).toContain('Take magnesium');
    expect((res as any).text).toContain('Call the doctor');
  });

  it('answers plainly when there are none', async () => {
    const sb = sbWith(chain({ data: [] }));
    const res = await tool_list_missed_reminders({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('no missed reminders');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_list_missed_reminders({}, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeNextAlarmFire (pure)
// ---------------------------------------------------------------------------

describe('computeNextAlarmFire', () => {
  it('returns a future instant whose wall clock in tz matches HH:MM', () => {
    const out = computeNextAlarmFire('07:30', 'Europe/Berlin', null);
    expect(out.fires_at).toBeDefined();
    expect(out.fires_at!.getTime()).toBeGreaterThan(Date.now());
    const wall = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(out.fires_at!);
    expect(wall).toBe('07:30');
    // next occurrence is within 24h
    expect(out.fires_at!.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('weekdays recurrence never lands on a weekend', () => {
    const out = computeNextAlarmFire('06:00', 'Europe/Berlin', 'weekdays');
    expect(out.fires_at).toBeDefined();
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      weekday: 'short',
    }).format(out.fires_at!);
    expect(['Sat', 'Sun']).not.toContain(weekday);
  });

  it('accepts a future ISO timestamp as-is', () => {
    const iso = new Date(Date.now() + 86_400_000).toISOString();
    const out = computeNextAlarmFire(iso, 'UTC', null);
    expect(out.fires_at!.toISOString()).toBe(iso);
  });

  it('rejects garbage and past ISO times', () => {
    expect(computeNextAlarmFire('25:99', 'UTC', null).error).toBeDefined();
    expect(computeNextAlarmFire('not a time', 'UTC', null).error).toBeDefined();
    expect(
      computeNextAlarmFire(new Date(Date.now() - 60_000).toISOString(), 'UTC', null).error,
    ).toContain('past');
  });
});

// ---------------------------------------------------------------------------
// set_alarm / list_alarms / delete_alarm
// ---------------------------------------------------------------------------

describe('tool_set_alarm', () => {
  it('creates a daily alarm and speaks the local time', async () => {
    const insertChain = chain({ data: clockRow({ label: 'Gym', recurrence: 'daily' }) });
    const sb = sbWith(insertChain);
    const res = await tool_set_alarm(
      { time: '07:00', label: 'Gym', recurrence: 'daily', timezone: 'Europe/Berlin' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Gym');
    expect((res as any).text).toContain('repeating daily');
    const payload = insertChain.insert.mock.calls[0][0];
    expect(payload.kind).toBe('alarm');
    expect(payload.user_id).toBe('u-1');
    expect(payload.recurrence).toBe('daily');
    expect(new Date(payload.fires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an unsupported recurrence', async () => {
    const res = await tool_set_alarm({ time: '07:00', recurrence: 'monthly' }, IDENT, sbWith());
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('monthly');
  });

  it('rejects an invalid timezone', async () => {
    const res = await tool_set_alarm({ time: '07:00', timezone: 'Mars/Olympus' }, IDENT, sbWith());
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('Mars/Olympus');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_set_alarm({ time: '07:00' }, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

describe('tool_list_alarms', () => {
  it('lists active alarms speakably', async () => {
    const rows = [
      clockRow({ label: 'Gym', recurrence: 'weekdays' }),
      clockRow({ id: 'c-2', label: null, fires_at: new Date(Date.now() + 7_200_000).toISOString() }),
    ];
    const sb = sbWith(chain({ data: rows }));
    const res = await tool_list_alarms({ timezone: 'Europe/Berlin' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('2 active alarm(s)');
    expect((res as any).text).toContain('Gym');
    expect((res as any).text).toContain('weekdays');
  });

  it('answers plainly when there are none', async () => {
    const sb = sbWith(chain({ data: [] }));
    const res = await tool_list_alarms({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('no active alarms');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_list_alarms({}, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

describe('tool_delete_alarm', () => {
  it('asks for confirmation before deleting', async () => {
    const sb = sbWith(chain({ data: [clockRow({ label: 'Gym' })] }));
    const res = await tool_delete_alarm({ label: 'gym' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).result.needs_confirmation).toBe(true);
    expect((res as any).text).toContain('Gym');
    expect((res as any).text).toContain('confirm=true');
    expect((res as any).text).toContain('c-1');
  });

  it('cancels after confirm=true', async () => {
    const listChain = chain({ data: [clockRow({ label: 'Gym' })] });
    const cancelChain = chain({ data: { id: 'c-1' } });
    const sb = sbWith(listChain, cancelChain);
    const res = await tool_delete_alarm({ alarm_id: 'c-1', confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Deleted the alarm');
    expect(cancelChain.update.mock.calls[0][0].status).toBe('cancelled');
  });

  it('asks to disambiguate when several alarms match', async () => {
    const sb = sbWith(
      chain({ data: [clockRow({ label: 'Gym' }), clockRow({ id: 'c-2', label: 'Gym session' })] }),
    );
    const res = await tool_delete_alarm({ label: 'gym' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('2 matching alarms');
  });

  it('errors when nothing matches', async () => {
    const sb = sbWith(chain({ data: [] }));
    const res = await tool_delete_alarm({ label: 'nope' }, IDENT, sb);
    expect(res.ok).toBe(false);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_delete_alarm({ alarm_id: 'c-1' }, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// start_timer / start_pomodoro / list_active_timers
// ---------------------------------------------------------------------------

describe('tool_start_timer', () => {
  it('starts a countdown with label', async () => {
    const insertChain = chain({
      data: clockRow({ kind: 'timer', label: 'Pasta', duration_seconds: 600 }),
    });
    const sb = sbWith(insertChain);
    const res = await tool_start_timer({ duration_minutes: 10, label: 'Pasta' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('10 minutes');
    expect((res as any).text).toContain('Pasta');
    const payload = insertChain.insert.mock.calls[0][0];
    expect(payload.kind).toBe('timer');
    expect(payload.duration_seconds).toBe(600);
  });

  it('rejects out-of-range durations', async () => {
    expect((await tool_start_timer({ duration_minutes: 0 }, IDENT, sbWith())).ok).toBe(false);
    expect((await tool_start_timer({ duration_minutes: 2000 }, IDENT, sbWith())).ok).toBe(false);
    expect((await tool_start_timer({}, IDENT, sbWith())).ok).toBe(false);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_start_timer({ duration_minutes: 10 }, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

describe('tool_start_pomodoro', () => {
  it('defaults to 25 minutes', async () => {
    const insertChain = chain({
      data: clockRow({ kind: 'pomodoro', duration_seconds: 1500 }),
    });
    const sb = sbWith(insertChain);
    const res = await tool_start_pomodoro({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('25 minutes');
    const payload = insertChain.insert.mock.calls[0][0];
    expect(payload.kind).toBe('pomodoro');
    expect(payload.duration_seconds).toBe(1500);
  });

  it('rejects durations outside 5-90', async () => {
    expect((await tool_start_pomodoro({ duration_minutes: 3 }, IDENT, sbWith())).ok).toBe(false);
    expect((await tool_start_pomodoro({ duration_minutes: 120 }, IDENT, sbWith())).ok).toBe(false);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_start_pomodoro({}, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

describe('tool_list_active_timers', () => {
  it('speaks remaining time per timer/pomodoro', async () => {
    const rows = [
      clockRow({
        kind: 'pomodoro',
        label: 'Deep work',
        fires_at: new Date(Date.now() + 18 * 60_000).toISOString(),
      }),
      clockRow({
        id: 'c-2',
        kind: 'timer',
        label: 'Tea',
        fires_at: new Date(Date.now() + 2 * 60_000 + 500).toISOString(),
      }),
    ];
    const sb = sbWith(chain({ data: rows }));
    const res = await tool_list_active_timers({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Pomodoro "Deep work"');
    expect((res as any).text).toContain('Timer "Tea"');
    expect((res as any).text).toContain('18 minutes remaining');
  });

  it('marks overdue items as finished', async () => {
    const rows = [
      clockRow({ kind: 'timer', label: 'Tea', fires_at: new Date(Date.now() - 60_000).toISOString() }),
    ];
    const sb = sbWith(chain({ data: rows }));
    const res = await tool_list_active_timers({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('finished');
  });

  it('answers plainly when nothing is running', async () => {
    const sb = sbWith(chain({ data: [] }));
    const res = await tool_list_active_timers({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('no running timers');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_list_active_timers({}, ANON, sbWith());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_world_time
// ---------------------------------------------------------------------------

describe('tool_get_world_time', () => {
  it('maps a known city (case/diacritic insensitive) to its IANA zone', async () => {
    const res = await tool_get_world_time({ location: 'Berlin' }, IDENT, sbWith());
    expect(res.ok).toBe(true);
    expect((res as any).result.timezone).toBe('Europe/Berlin');
    expect((res as any).text).toContain('Berlin');
    expect((res as any).text).toMatch(/\d/); // contains an actual time
  });

  it('accepts a raw IANA timezone', async () => {
    const res = await tool_get_world_time({ location: 'Europe/Belgrade' }, IDENT, sbWith());
    expect(res.ok).toBe(true);
    expect((res as any).result.timezone).toBe('Europe/Belgrade');
  });

  it('gives a helpful error for unknown input', async () => {
    const res = await tool_get_world_time({ location: 'Atlantis' }, IDENT, sbWith());
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('Atlantis');
    expect((res as any).error).toContain('Europe/Berlin');
  });

  it('requires a location', async () => {
    const res = await tool_get_world_time({}, IDENT, sbWith());
    expect(res.ok).toBe(false);
  });
});
