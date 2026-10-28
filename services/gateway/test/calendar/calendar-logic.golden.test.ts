/**
 * VTID-04458 — calendar regression suite: the pure calendar logic, pinned.
 *
 * Each block runs fixed scenarios through the real functions (no mocks) and
 * compares the result with test/calendar/__golden__/calendar-logic.json.
 * These are the rules members feel directly: when a repeating habit
 * happens, which entries a role sees, when reminders fire and what they
 * say, what an entry becomes in Google / Outlook / iCloud / the .ics feed.
 *
 * A failure here means a change altered calendar behaviour. If that was the
 * intent, re-record (UPDATE_CALENDAR_GOLDEN=1) and commit the golden diff
 * so the change is visible in review; otherwise the change broke something.
 */
import { expectGolden } from './golden';
import { expandOccurrences, parseRRule, zonedTimeToEpoch, localParts } from '../../src/services/calendar-recurrence';
import { buildCalendarWindow, moveBlockReason, toSummary } from '../../src/services/calendar-service';
import {
  computeDesiredReminders,
  reminderRules,
  entryEmoji,
  reminderText,
  quietWindowFromPrefs,
  inQuietWindow,
  beforeQuietWindow,
  reminderKey,
  isCalendarRemindersEnabled,
  type ReminderEntry,
} from '../../src/services/calendar-reminders';
import { buildIcs, icsEscape, icsFold, icsUtc, isWellFormedToken, hashFeedToken } from '../../src/services/calendar-ics-feed';
import {
  planPush,
  toGoogleEvent,
  normalizeBusy,
  isPushable,
  googleSyncAvailability,
  type SyncEntry,
} from '../../src/services/calendar-google-sync';
import {
  planExternalPush,
  renderGraph,
  renderIcs,
  toGraphRecurrence,
  toIcs,
  calendarPushEnabled,
} from '../../src/services/connected-apps/calendar-push';
import {
  workLensesFor,
  deployItems,
  reviewItems,
  ticketItems,
  erpApprovalItems,
  inWindow,
  mergeWorkItems,
} from '../../src/services/calendar-work-lens';
import { isDayOver, nextSlot, isCalendarMaintenanceEnabled } from '../../src/services/calendar-rescheduler';
import { wideTodayWindow, pickFirstEventTodayPerUser } from '../../src/services/calendar-today';
import { diffEntry, seriesEntryRefId } from '../../src/services/calendar-producers';
import { getJourneyStage } from '../../src/services/journey-calendar-mapper';
import {
  getVisibleContexts,
  toWritableRoleContext,
  CreateCalendarEventSchema,
  UpdateCalendarEventSchema,
  ListCalendarEventsSchema,
  CompleteEventSchema,
  RRULE_PATTERN,
  CALENDAR_SOURCE_TYPES,
  CALENDAR_EVENT_TYPES,
  EVENT_TYPE_TO_DOMAIN,
  type CalendarEvent,
} from '../../src/types/calendar';

const G = 'calendar-logic';
const BERLIN = 'Europe/Berlin';
const NY = 'America/New_York';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function row(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    user_id: 'u1',
    title: over.id,
    description: null,
    start_time: '2026-10-05T07:30:00.000Z',
    end_time: '2026-10-05T08:00:00.000Z',
    location: null,
    event_type: 'personal',
    status: 'confirmed',
    priority: 'medium',
    is_recurring: false,
    recurring_pattern: null,
    attendees_count: 0,
    has_rewards: false,
    metadata: {},
    source_message_id: null,
    source_type: 'manual',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    role_context: 'community',
    source_ref_id: null,
    source_ref_type: null,
    activated_at: null,
    completed_at: null,
    completion_status: null,
    completion_notes: null,
    original_start_time: null,
    reschedule_count: 0,
    priority_score: 50,
    wellness_tags: [],
    pillar: null,
    contribution_vector: null,
    rrule: null,
    timezone: null,
    reminder_offsets: null,
    emoji: null,
    ...over,
  } as unknown as CalendarEvent;
}

function entry(over: Partial<ReminderEntry> & { id: string }): ReminderEntry {
  return {
    user_id: 'u1',
    title: 'Walk',
    start_time: '2026-10-05T16:00:00.000Z',
    end_time: '2026-10-05T16:30:00.000Z',
    event_type: 'personal',
    source_type: 'manual',
    status: 'confirmed',
    completed_at: null,
    ...over,
  } as ReminderEntry;
}

const tr = (key: string, params: Record<string, string | number>) => `${key} ${JSON.stringify(params)}`;

// -----------------------------------------------------------------------------
// Recurrence
// -----------------------------------------------------------------------------

describe('recurrence', () => {
  const RULES = [
    'FREQ=DAILY',
    'FREQ=DAILY;INTERVAL=2;COUNT=5',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH',
    'FREQ=MONTHLY;COUNT=3',
    'FREQ=DAILY;UNTIL=20261010T000000Z',
    'FREQ=WEEKLY;BYDAY=SU,SA,MO,MO',
    'FREQ=YEARLY',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=DAILY;UNTIL=2026-10-10',
    'garbage',
  ];

  it('parses every rule shape the valid_rrule CHECK allows, and rejects the rest', () => {
    expectGolden(G, 'recurrence.parse', Object.fromEntries(RULES.map((r) => [r, parseRRule(r)])));
    expectGolden(G, 'recurrence.pattern', Object.fromEntries(RULES.map((r) => [r, RRULE_PATTERN.test(r)])));
  });

  const SCENARIOS: Array<{ name: string; event: Parameters<typeof expandOccurrences>[0]; window: { from: string; to: string }; tz?: string; limit?: number }> = [
    {
      // 07:30 Berlin every day across the 25 Oct 2026 DST change: stays 07:30 local.
      name: 'daily-across-dst-berlin',
      event: { start_time: '2026-10-22T05:30:00.000Z', end_time: '2026-10-22T06:00:00.000Z', rrule: 'FREQ=DAILY', timezone: BERLIN },
      window: { from: '2026-10-22T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' },
    },
    {
      name: 'daily-spring-forward-new-york',
      event: { start_time: '2026-03-06T13:00:00.000Z', end_time: '2026-03-06T14:00:00.000Z', rrule: 'FREQ=DAILY;COUNT=5', timezone: NY },
      window: { from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z' },
    },
    {
      // Monthly on the 31st skips months without one.
      name: 'monthly-on-the-31st',
      event: { start_time: '2026-01-31T09:00:00.000Z', end_time: null, rrule: 'FREQ=MONTHLY', timezone: 'UTC' },
      window: { from: '2026-01-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    },
    {
      name: 'weekly-byday-interval-2',
      event: { start_time: '2026-10-06T16:00:00.000Z', end_time: '2026-10-06T17:00:00.000Z', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', timezone: BERLIN },
      window: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z' },
    },
    {
      name: 'weekly-no-byday-uses-start-weekday',
      event: { start_time: '2026-10-07T18:00:00.000Z', end_time: '2026-10-07T19:00:00.000Z', rrule: 'FREQ=WEEKLY', timezone: BERLIN },
      window: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
    },
    {
      name: 'count-stops-series',
      event: { start_time: '2026-10-01T07:00:00.000Z', end_time: null, rrule: 'FREQ=DAILY;INTERVAL=2;COUNT=4', timezone: BERLIN },
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' },
    },
    {
      // Occurrences before the window still count toward COUNT: index keeps the series position.
      name: 'count-with-window-starting-mid-series',
      event: { start_time: '2026-10-01T07:00:00.000Z', end_time: null, rrule: 'FREQ=DAILY;COUNT=6', timezone: BERLIN },
      window: { from: '2026-10-04T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' },
    },
    {
      name: 'until-stops-series',
      event: { start_time: '2026-10-05T07:00:00.000Z', end_time: null, rrule: 'FREQ=DAILY;UNTIL=20261008T070000Z', timezone: BERLIN },
      window: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
    },
    {
      name: 'no-timezone-uses-fallback',
      event: { start_time: '2026-10-05T12:00:00.000Z', end_time: null, rrule: 'FREQ=DAILY;COUNT=3', timezone: null },
      window: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
      tz: NY,
    },
    {
      name: 'invalid-timezone-uses-fallback',
      event: { start_time: '2026-10-05T12:00:00.000Z', end_time: null, rrule: 'FREQ=DAILY;COUNT=2', timezone: 'Mars/Olympus' },
      window: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
    },
    {
      name: 'occurrence-overlapping-window-start-is-kept',
      event: { start_time: '2026-10-05T22:00:00.000Z', end_time: '2026-10-06T02:00:00.000Z', rrule: 'FREQ=DAILY;COUNT=3', timezone: 'UTC' },
      window: { from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z' },
    },
    {
      name: 'limit-caps-results',
      event: { start_time: '2026-10-01T07:00:00.000Z', end_time: null, rrule: 'FREQ=DAILY', timezone: BERLIN },
      window: { from: '2026-10-01T00:00:00.000Z', to: '2027-10-01T00:00:00.000Z' },
      limit: 3,
    },
    {
      name: 'bad-rule-or-window-gives-nothing',
      event: { start_time: '2026-10-01T07:00:00.000Z', end_time: null, rrule: 'FREQ=HOURLY', timezone: BERLIN },
      window: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
    },
  ];

  it.each(SCENARIOS.map((s) => [s.name, s]))('expands %s', (name, s) => {
    expectGolden(G, `recurrence.expand.${name}`, expandOccurrences(s.event, s.window, s.tz ?? BERLIN, s.limit));
  });

  it('converts wall-clock times in both directions, DST gaps resolving forward', () => {
    const cases = [
      [2026, 10, 25, 2, 30, 0, BERLIN], // ambiguous hour (fall back)
      [2026, 3, 29, 2, 30, 0, BERLIN], // missing hour (spring forward)
      [2026, 7, 1, 9, 0, 0, BERLIN],
      [2026, 12, 31, 23, 59, 59, NY],
      [2026, 6, 15, 12, 0, 0, 'Asia/Kolkata'],
    ] as const;
    expectGolden(
      G,
      'recurrence.zoned',
      cases.map((c) => {
        const epoch = zonedTimeToEpoch(c[0], c[1], c[2], c[3], c[4], c[5], c[6]);
        return { in: c, iso: new Date(epoch).toISOString(), back: localParts(epoch, c[6]) };
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// Window: lenses, busy blocks, cancelled, series
// -----------------------------------------------------------------------------

describe('calendar window', () => {
  const window = { from: '2026-10-05T00:00:00.000Z', to: '2026-10-12T00:00:00.000Z' };
  const rows = [
    row({ id: 'community-walk', title: 'Walk', role_context: 'community' }),
    row({ id: 'personal-doctor', title: 'Doctor', role_context: 'personal', start_time: '2026-10-06T09:00:00.000Z', end_time: '2026-10-06T10:00:00.000Z', location: 'Praxis' }),
    row({ id: 'dev-standup', title: 'Standup', role_context: 'developer', start_time: '2026-10-05T07:00:00.000Z', end_time: '2026-10-05T07:15:00.000Z' }),
    row({ id: 'admin-review', title: 'Review', role_context: 'admin', start_time: '2026-10-07T12:00:00.000Z', end_time: '2026-10-07T13:00:00.000Z' }),
    row({ id: 'pro-client', title: 'Client', role_context: 'professional', start_time: '2026-10-08T15:00:00.000Z', end_time: null }),
    row({ id: 'cancelled', title: 'Gone', status: 'cancelled' }),
    row({ id: 'outside', title: 'Later', start_time: '2026-10-20T07:00:00.000Z', end_time: '2026-10-20T08:00:00.000Z' }),
    row({ id: 'habit', title: 'Stretch', rrule: 'FREQ=DAILY;COUNT=10', timezone: BERLIN, start_time: '2026-10-03T05:30:00.000Z', end_time: '2026-10-03T05:45:00.000Z' }),
  ];
  const expand = (e: CalendarEvent) =>
    expandOccurrences({ start_time: e.start_time, end_time: e.end_time, rrule: e.rrule as string, timezone: e.timezone }, window, BERLIN);

  // Only what the member sees: id, time, busy flag and the title (null for busy blocks).
  const view = (items: ReturnType<typeof buildCalendarWindow>) =>
    items.map((i) => ({ id: i.id, start: i.start_time, end: i.end_time, busy: i.busy, idx: i.occurrence_index, title: i.event?.title ?? null, location: i.event?.location ?? null }));

  it.each([['community'], ['developer'], ['admin'], ['professional'], ['super_admin'], [null]])('role %s, busy blocks on', (role) => {
    expectGolden(G, `window.${role}.busy`, view(buildCalendarWindow(rows, role, window, { includeBusy: true, fallbackTz: BERLIN, expand })));
  });

  it('role community, busy blocks off', () => {
    expectGolden(G, 'window.community.nobusy', view(buildCalendarWindow(rows, 'community', window, { includeBusy: false, fallbackTz: BERLIN, expand })));
  });

  it('a busy block never carries anything identifying', () => {
    const items = buildCalendarWindow(rows, 'community', window, { includeBusy: true, fallbackTz: BERLIN, expand });
    for (const b of items.filter((i) => i.busy)) expect(Object.keys(b).sort()).toEqual(['busy', 'end_time', 'event', 'event_id', 'id', 'occurrence_index', 'start_time']);
    for (const b of items.filter((i) => i.busy)) expect(b.event).toBeNull();
  });

  it('role visibility and write context', () => {
    const roles = ['community', 'patient', 'professional', 'staff', 'admin', 'developer', 'infra', 'DEV', 'backoffice', 'super_admin', 'unknown', null];
    expectGolden(G, 'roles.visible', Object.fromEntries(roles.map((r) => [String(r), getVisibleContexts(r)])));
    expectGolden(G, 'roles.writable', Object.fromEntries([...roles, undefined].map((r) => [String(r), toWritableRoleContext(r as any)])));
  });

  it('summary shape the assistant reads', () => {
    expectGolden(G, 'summary', rows.slice(0, 3).map(toSummary));
  });
});

// -----------------------------------------------------------------------------
// Who may move an entry
// -----------------------------------------------------------------------------

describe('move rules', () => {
  it('pins which entries a member may move', () => {
    const cases: Record<string, Parameters<typeof moveBlockReason>[0]> = {
      manual: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'manual', source_ref_type: null },
      no_source: { status: 'confirmed', completed_at: null, rrule: null, source_type: null as any, source_ref_type: null },
      assistant: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'assistant', source_ref_type: null },
      autopilot_rec: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'autopilot', source_ref_type: 'autopilot_recommendation' },
      autopilot_no_ref: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'autopilot', source_ref_type: null },
      autopilot_other: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'autopilot', source_ref_type: 'something_else' },
      journey_task: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'journey', source_ref_type: 'journey_task' },
      journey_other: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'journey', source_ref_type: 'journey_wave' },
      appointment: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'appointment', source_ref_type: 'appointment' },
      lab_order: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'lab_order', source_ref_type: 'lab_order' },
      invite: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'invite', source_ref_type: null },
      live_room: { status: 'confirmed', completed_at: null, rrule: null, source_type: 'live_room', source_ref_type: null },
      recurring: { status: 'confirmed', completed_at: null, rrule: 'FREQ=DAILY', source_type: 'manual', source_ref_type: null },
      completed: { status: 'confirmed', completed_at: '2026-10-01T00:00:00Z', rrule: null, source_type: 'manual', source_ref_type: null },
      cancelled: { status: 'cancelled', completed_at: null, rrule: null, source_type: 'manual', source_ref_type: null },
    };
    expectGolden(G, 'move', Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, moveBlockReason(v)])));
  });
});

// -----------------------------------------------------------------------------
// Reminders
// -----------------------------------------------------------------------------

describe('reminders', () => {
  const now = Date.parse('2026-10-05T06:00:00.000Z');
  const ENTRIES: ReminderEntry[] = [
    entry({ id: 'personal', event_type: 'personal' }),
    entry({ id: 'workout', event_type: 'workout', title: 'Run' }),
    entry({ id: 'nudge', event_type: 'wellness_nudge', title: 'Drink water' }),
    entry({ id: 'lab', event_type: 'health', source_type: 'lab_order', title: 'Blood test', start_time: '2026-10-06T06:30:00.000Z', end_time: null }),
    entry({ id: 'lab-ref', event_type: 'health', source_type: 'appointment', source_ref_type: 'lab_draw', title: 'Draw', start_time: '2026-10-06T06:30:00.000Z' }),
    entry({ id: 'explicit', event_type: 'personal', reminder_offsets: [0, 60, 60, 1440], start_time: '2026-10-06T08:00:00.000Z' }),
    entry({ id: 'none', event_type: 'personal', reminder_offsets: [] }),
    entry({ id: 'emoji', event_type: 'community', emoji: '🎸' }),
    entry({ id: 'daily', event_type: 'workout', rrule: 'FREQ=DAILY', timezone: BERLIN, start_time: '2026-10-01T05:30:00.000Z', end_time: null }),
    entry({ id: 'early', event_type: 'personal', start_time: '2026-10-06T05:00:00.000Z', title: 'Early flight' }),
    entry({ id: 'done', completed_at: '2026-10-05T00:00:00Z' }),
    entry({ id: 'cancelled', status: 'cancelled' }),
    entry({ id: 'other-user', user_id: 'u2', event_type: 'personal', start_time: '2026-10-05T23:30:00.000Z' }),
  ];

  it('default rules and emoji per entry kind', () => {
    expectGolden(G, 'reminders.rules', Object.fromEntries(ENTRIES.map((e) => [e.id, reminderRules(e)])));
    expectGolden(G, 'reminders.emoji', Object.fromEntries(ENTRIES.map((e) => [e.id, entryEmoji(e)])));
  });

  const tzOf = (u: string) => (u === 'u2' ? NY : BERLIN);

  it('what fires, without quiet hours', () => {
    expectGolden(G, 'reminders.desired.plain', computeDesiredReminders(ENTRIES, { now, tzOf }));
  });

  it('what fires, with quiet hours 22:00–07:00 (defaults move, explicit ones stay)', () => {
    const quiet = quietWindowFromPrefs({ dnd_enabled: true, dnd_start_time: '22:00', dnd_end_time: '07:00:00' });
    expectGolden(G, 'reminders.desired.quiet', computeDesiredReminders(ENTRIES, { now, tzOf, quietOf: () => quiet }));
  });

  it('the text each reminder says', () => {
    const quiet = quietWindowFromPrefs({ dnd_enabled: true, dnd_start_time: '22:00', dnd_end_time: '07:00' });
    const desired = computeDesiredReminders(ENTRIES, { now, tzOf, quietOf: () => quiet });
    const byId = new Map(ENTRIES.map((e) => [e.id, e]));
    expectGolden(G, 'reminders.text', desired.map((r) => ({ key: r.key, text: reminderText(byId.get(r.calendar_event_id)!, r, tr) })));
  });

  it('quiet-hours parsing and window math', () => {
    const prefs = [
      null,
      { dnd_enabled: false, dnd_start_time: '22:00', dnd_end_time: '07:00' },
      { dnd_enabled: true, dnd_start_time: '22:00', dnd_end_time: '07:00' },
      { dnd_enabled: true, dnd_start_time: '13:00', dnd_end_time: '15:30' },
      { dnd_enabled: true, dnd_start_time: '22:00', dnd_end_time: '22:00' },
      { dnd_enabled: true, dnd_start_time: '25:00', dnd_end_time: '07:00' },
      { dnd_enabled: true, dnd_start_time: null, dnd_end_time: '07:00' },
    ];
    expectGolden(G, 'reminders.quietPrefs', prefs.map(quietWindowFromPrefs));
    const w = { startMin: 22 * 60, endMin: 7 * 60 };
    const probes = ['2026-10-05T19:59:00Z', '2026-10-05T20:00:00Z', '2026-10-06T02:00:00Z', '2026-10-06T04:59:00Z', '2026-10-06T05:00:00Z', '2026-10-25T03:00:00Z'];
    expectGolden(
      G,
      'reminders.quietMath',
      probes.map((p) => {
        const ms = Date.parse(p);
        const inside = inQuietWindow(ms, w, BERLIN);
        return { p, inside, movedTo: inside ? new Date(beforeQuietWindow(ms, w, BERLIN)).toISOString() : null };
      }),
    );
  });

  it('reminder keys and the loop switch', () => {
    expectGolden(G, 'reminders.key', [reminderKey('e1', '2026-10-05T16:00:00Z', 10), reminderKey('e1', '2026-10-05T18:00:00+02:00', 0)]);
    expectGolden(G, 'reminders.enabled', [undefined, '', 'true', 'false', 'FALSE', '0'].map((v) => [String(v), isCalendarRemindersEnabled(v)]));
  });
});

// -----------------------------------------------------------------------------
// External calendars: Google, Outlook, iCloud, .ics feed
// -----------------------------------------------------------------------------

describe('external calendars', () => {
  const SYNC: SyncEntry[] = [
    { id: 'e-single', title: 'Dentist', description: 'Bring card', start_time: '2026-10-05T08:00:00.000Z', end_time: '2026-10-05T09:00:00.000Z', status: 'confirmed', role_context: 'community', emoji: '🦷' },
    { id: 'e-noend', title: 'Call', start_time: '2026-10-05T10:00:00.000Z', end_time: null, status: 'confirmed', role_context: 'personal' },
    { id: 'e-habit', title: 'Stretch', start_time: '2026-10-01T05:30:00.000Z', end_time: '2026-10-01T05:45:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', timezone: BERLIN, status: 'confirmed', role_context: 'community' },
    { id: 'e-monthly', title: 'Budget', start_time: '2026-10-31T17:00:00.000Z', end_time: null, rrule: 'RRULE:FREQ=MONTHLY;UNTIL=20270301T000000Z', timezone: NY, status: 'confirmed', role_context: 'community' },
    { id: 'e-dev', title: 'Deploy', start_time: '2026-10-05T12:00:00.000Z', end_time: null, status: 'confirmed', role_context: 'developer' },
    { id: 'e-cancel', title: 'Gone', start_time: '2026-10-05T12:00:00.000Z', end_time: null, status: 'cancelled', role_context: 'community' },
    { id: 'e-badrule', title: 'Odd', start_time: '2026-10-05T12:00:00.000Z', end_time: null, rrule: 'FREQ=YEARLY', status: 'confirmed', role_context: 'community' },
    { id: 'e-long', title: 'Ein sehr langer Titel mit Umlauten ÄÖÜ, Kommas; Semikolons und \\ Backslashes, der gefaltet werden muss', start_time: '2026-10-05T14:00:00.000Z', end_time: '2026-10-05T13:00:00.000Z', status: 'confirmed', role_context: 'community' },
  ];

  it('which entries leave Vitanaland at all', () => {
    expectGolden(G, 'external.pushable', Object.fromEntries(SYNC.map((e) => [e.id, isPushable(e)])));
    expectGolden(G, 'external.pushSwitch', [undefined, 'true', 'false'].map((v) => calendarPushEnabled({ CONNECTED_APPS_CALENDAR_PUSH: v } as any)));
    expectGolden(G, 'external.googleAvailability', [
      googleSyncAvailability({} as any),
      googleSyncAvailability({ CALENDAR_GOOGLE_SYNC_ENABLED: 'true' } as any),
      googleSyncAvailability({ CALENDAR_GOOGLE_SYNC_ENABLED: 'true', GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'y' } as any),
    ]);
  });

  it('Google event bodies', () => {
    expectGolden(G, 'external.google', SYNC.map((e) => toGoogleEvent(e, BERLIN)));
  });

  it('Google push plan: create, update, delete, orphan', () => {
    const current = toGoogleEvent(SYNC[0], BERLIN);
    const { pushHash } = jest.requireActual('../../src/services/calendar-google-sync');
    const links = [
      { id: 'l1', calendar_event_id: 'e-single', google_event_id: 'g1', pushed_hash: pushHash(current) },
      { id: 'l2', calendar_event_id: 'e-noend', google_event_id: 'g2', pushed_hash: 'stale' },
      { id: 'l3', calendar_event_id: 'e-cancel', google_event_id: 'g3', pushed_hash: 'x' },
      { id: 'l4', calendar_event_id: null, google_event_id: 'g4', pushed_hash: 'x' },
      { id: 'l5', calendar_event_id: 'e-dev', google_event_id: 'g5', pushed_hash: 'x' },
    ];
    expectGolden(G, 'external.googlePlan', planPush(SYNC, links, BERLIN).map((o) => ({ ...o, body: undefined })));
  });

  it('Google free/busy is cleaned and merged', () => {
    expectGolden(G, 'external.busy', normalizeBusy([
      { start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z' },
      { start: '2026-10-05T10:30:00Z', end: '2026-10-05T12:00:00Z' },
      { start: '2026-10-05T12:00:00Z', end: '2026-10-05T12:30:00Z' },
      { start: '2026-10-05T08:00:00Z', end: '2026-10-05T09:00:00Z' },
      { start: '2026-10-05T09:00:00Z', end: '2026-10-05T08:00:00Z' },
      { start: 'nope', end: '2026-10-05T08:00:00Z' },
      {},
    ]));
  });

  it('Outlook (Graph) event bodies and repeat rules', () => {
    expectGolden(G, 'external.graph', SYNC.map((e) => renderGraph(e, BERLIN)?.body ?? null));
    const start = Date.parse('2026-10-05T05:30:00.000Z');
    const rules = ['FREQ=DAILY', 'FREQ=DAILY;INTERVAL=3;COUNT=10', 'FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SA', 'FREQ=MONTHLY;UNTIL=20270105T000000Z', 'RRULE:FREQ=MONTHLY', 'FREQ=YEARLY'];
    expectGolden(G, 'external.graphRecurrence', Object.fromEntries(rules.map((r) => [r, toGraphRecurrence(r, start, BERLIN)])));
  });

  it('iCloud iCalendar objects', () => {
    expectGolden(G, 'external.icloud', SYNC.map((e) => toIcs(e, BERLIN, '20261001T000000Z')));
    const a = renderIcs(SYNC[0], BERLIN, Date.parse('2026-10-01T00:00:00Z'));
    const b = renderIcs(SYNC[0], BERLIN, Date.parse('2026-10-02T00:00:00Z'));
    // DTSTAMP changes each push; the hash must not, or every entry is rewritten every tick.
    expect(a!.hash).toBe(b!.hash);
    expect(a!.body).not.toBe(b!.body);
  });

  it('shared push plan for Outlook and iCloud', () => {
    const render = (e: SyncEntry) => renderGraph(e, BERLIN);
    const cur = render(SYNC[0])!;
    const links = [
      { id: 'l1', calendar_event_id: 'e-single', remote_id: 'r1', pushed_hash: cur.hash },
      { id: 'l2', calendar_event_id: 'e-habit', remote_id: 'r2', pushed_hash: 'stale' },
      { id: 'l3', calendar_event_id: 'e-badrule', remote_id: 'r3', pushed_hash: 'x' },
      { id: 'l4', calendar_event_id: null, remote_id: 'r4', pushed_hash: 'x' },
    ];
    expectGolden(G, 'external.pushPlan', planExternalPush(SYNC, links, render).map((o) => ({ ...o, body: undefined })));
  });

  it('subscription (.ics) feed', () => {
    const feed = buildIcs(
      [
        { uid: 'a@vitanaland', title: 'Walk, then; coffee\nwith Ana', start: '2026-10-05T07:30:00.000Z', end: '2026-10-05T08:00:00.000Z', location: 'Park', status: 'confirmed', updated: '2026-10-01T10:00:00Z' },
        { uid: 'b@vitanaland', title: 'Pending', start: '2026-10-06T07:30:00.000Z', end: null, location: null, status: 'pending', updated: null },
        { uid: 'c@vitanaland', title: 'Bad', start: 'not-a-date', end: null, location: null, status: null, updated: null },
        { uid: 'd@vitanaland', title: 'Ünïcödé '.repeat(12), start: '2026-10-07T07:30:00.000Z', end: '2026-10-07T07:00:00.000Z', location: null, status: null, updated: 'nope' },
      ],
      new Date('2026-10-01T12:00:00Z'),
    );
    expectGolden(G, 'external.feed', feed.split('\r\n'));
    expectGolden(G, 'external.icsHelpers', {
      utc: icsUtc('2026-10-05T07:30:15.123Z'),
      escape: icsEscape('a\\b;c,d\r\ne'),
      fold: icsFold('X'.repeat(80) + 'ä'.repeat(40)).split('\r\n'),
      tokenOk: [isWellFormedToken('a'.repeat(43)), isWellFormedToken('short'), isWellFormedToken('a'.repeat(42) + '!')],
      hash: hashFeedToken('fixed-token'),
    });
  });
});

// -----------------------------------------------------------------------------
// Work lenses (developer / admin)
// -----------------------------------------------------------------------------

describe('work lenses', () => {
  it('who gets which lens', () => {
    const roles = ['developer', 'infra', 'dev', 'DEV', 'admin', 'staff', 'backoffice', 'super_admin', 'community', null];
    expectGolden(G, 'work.lenses', Object.fromEntries(roles.flatMap((r) => [[`${r}/staff`, workLensesFor(r, true)], [`${r}/member`, workLensesFor(r, false)]])));
  });

  it('source rows become read-only entries', () => {
    const deploy = deployItems('u1', [
      { id: 'd1', topic: 'prod.deploy.completed', service: 'gateway-awsdr', created_at: '2026-10-05T10:00:00Z', metadata: { git_commit: 'abcdef1234' } },
      { id: 'd2', topic: 'staging.deploy.completed', service: 'community-app-aws', created_at: '2026-10-05T11:00:00Z' },
    ]);
    const review = reviewItems('u1', [
      { id: '12345678-aaaa', updated_at: '2026-10-05T12:00:00Z', metadata: { pending_approval: { staged_at: '2026-10-05T11:30:00Z', pr_title: 'Fix it', branch: 'b1' } } },
      { id: '87654321-bbbb', updated_at: '2026-10-05T12:00:00Z' },
    ]);
    const tickets = ticketItems('u1', [
      { id: 't1', ticket_number: 'FB-1', status: 'open', priority: 'high', kind: 'bug', sla_due_at: '2026-10-06T09:00:00Z' },
      { id: 't2', ticket_number: 'FB-2', status: 'resolved', sla_due_at: '2026-10-06T09:00:00Z' },
      { id: 't3-long-id', status: 'wont_fix', sla_due_at: '2026-10-06T09:00:00Z' },
      { id: 't4-long-id', status: 'in_progress', sla_due_at: '2026-10-06T10:00:00Z' },
    ]);
    const erp = erpApprovalItems('u1', [{ id: 'x1-long-id', approve_capability: 'finance.payment', created_at: '2026-10-05T13:00:00Z' }, { id: 'x2-long-id', created_at: '2026-10-05T14:00:00Z' }]);
    const all = [...deploy, ...review, ...tickets, ...erp];
    expectGolden(G, 'work.items', all.map((i) => ({
      id: i.id, start: i.start_time, end: i.end_time, work: i.work,
      title: i.event?.title, type: i.event?.event_type, role: i.event?.role_context, priority: i.event?.priority, source: i.event?.source_type, emoji: i.event?.emoji,
    })));
    const win = inWindow(all, { from: '2026-10-05T10:30:00Z', to: '2026-10-05T13:30:00Z' });
    expectGolden(G, 'work.window', win.map((i) => i.id));
    expectGolden(G, 'work.merge', mergeWorkItems([{ start_time: '2026-10-05T12:00:00Z', id: 'a' }], [{ start_time: '2026-10-05T09:00:00Z', id: 'w' }]));
  });
});

// -----------------------------------------------------------------------------
// Maintenance, today, producers, journey
// -----------------------------------------------------------------------------

describe('maintenance and helpers', () => {
  it('rescheduler: is the day over, and the next slot', () => {
    const now = Date.parse('2026-10-26T10:00:00Z'); // Monday after the DST change
    const cands = [
      { start_time: '2026-10-24T05:30:00Z', end_time: '2026-10-24T06:00:00Z' },
      { start_time: '2026-10-25T21:30:00Z', end_time: '2026-10-25T22:30:00Z' }, // 22:30–23:30 Berlin, Sunday
      { start_time: '2026-10-25T23:30:00Z', end_time: null }, // 00:30 Berlin Monday = today
      { start_time: '2026-10-26T09:00:00Z', end_time: '2026-10-26T09:30:00Z' },
      { start_time: '2026-10-27T09:00:00Z', end_time: null },
    ];
    expectGolden(G, 'maintenance.reschedule', cands.map((c) => ({ c, over: isDayOver(c, BERLIN, now), next: nextSlot(c, BERLIN, now), nextNY: nextSlot(c, NY, now) })));
    expectGolden(G, 'maintenance.enabled', [undefined, 'true', 'false'].map((v) => isCalendarMaintenanceEnabled(v)));
  });

  it("today is the user's local today", () => {
    const now = new Date('2026-10-05T22:30:00Z'); // 00:30 Tuesday in Berlin, 18:30 Monday in New York
    expectGolden(G, 'today.window', wideTodayWindow(now));
    const events = [
      { id: 'a', user_id: 'berlin', start_time: '2026-10-05T21:00:00Z' },
      { id: 'b', user_id: 'berlin', start_time: '2026-10-06T06:00:00Z' },
      { id: 'c', user_id: 'berlin', start_time: '2026-10-06T05:00:00Z' },
      { id: 'd', user_id: 'ny', start_time: '2026-10-06T03:00:00Z' },
      { id: 'e', user_id: 'ny', start_time: '2026-10-05T23:00:00Z' },
      { id: 'f', user_id: 'tokyo', start_time: '2026-10-07T01:00:00Z' },
    ];
    const tz: Record<string, string> = { berlin: BERLIN, ny: NY, tokyo: 'Asia/Tokyo' };
    expectGolden(G, 'today.pick', pickFirstEventTodayPerUser(events, (u) => tz[u], now).map((p) => ({ id: p.event.id, time: p.localTime, tz: p.timezone })));
  });

  it('producers only rewrite what changed', () => {
    const existing = {
      title: 'Lab', start_time: '2026-10-05T07:30:00+00:00', end_time: null, reminder_offsets: [60], metadata: { a: 1 }, rrule: null, emoji: null, priority_score: 50,
    };
    const cases = {
      same_instant_other_format: { title: 'Lab', start_time: '2026-10-05T07:30:00.000Z' },
      title_changed: { title: 'Lab (fasting)' },
      moved: { start_time: '2026-10-05T08:00:00Z' },
      metadata_changed: { metadata: { a: 2 } },
      offsets_same: { reminder_offsets: [60] },
      not_compared_field: { status: 'cancelled', user_id: 'x' },
      null_vs_missing: { end_time: null, emoji: null },
    };
    expectGolden(G, 'producers.diff', Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, diffEntry(existing, v)])));
    expectGolden(G, 'producers.seriesRef', seriesEntryRefId('plan-1', '2026-10-05'));
  });

  it('90-day journey stage by day', () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-05T12:00:00Z'));
    try {
      const days = [-1, 0, 1, 7, 14, 21, 30, 45, 60, 75, 89, 90, 91];
      expectGolden(G, 'journey.stage', Object.fromEntries(days.map((d) => [d, getJourneyStage(new Date(Date.parse('2026-10-05T12:00:00Z') - d * 86_400_000))])));
    } finally {
      spy.mockRestore();
    }
  });
});

// -----------------------------------------------------------------------------
// Request contracts
// -----------------------------------------------------------------------------

describe('request contracts', () => {
  const outcome = (r: { success: boolean; data?: unknown; error?: { issues: Array<{ path: unknown; code: string }> } }) =>
    r.success ? { ok: true, data: r.data } : { ok: false, issues: r.error!.issues.map((i) => ({ path: i.path, code: i.code })) };

  it('create', () => {
    const cases: Record<string, unknown> = {
      minimal: { title: 'Walk', start_time: '2026-10-05T07:30:00Z' },
      full_recurring: { title: 'Stretch', start_time: '2026-10-05T07:30:00Z', end_time: '2026-10-05T07:45:00Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE', timezone: BERLIN, reminder_offsets: [0, 10], emoji: '🧘', event_type: 'workout', role_context: 'personal', pillar: 'exercise' },
      bad_rrule: { title: 'x', start_time: '2026-10-05T07:30:00Z', rrule: 'FREQ=YEARLY' },
      too_many_offsets: { title: 'x', start_time: '2026-10-05T07:30:00Z', reminder_offsets: [1, 2, 3, 4, 5, 6] },
      offset_too_far: { title: 'x', start_time: '2026-10-05T07:30:00Z', reminder_offsets: [40321] },
      bad_event_type: { title: 'x', start_time: '2026-10-05T07:30:00Z', event_type: 'party' },
      bad_source: { title: 'x', start_time: '2026-10-05T07:30:00Z', source_type: 'email' },
      no_title: { title: '', start_time: '2026-10-05T07:30:00Z' },
      local_time_without_zone: { title: 'x', start_time: '2026-10-05T07:30:00' },
    };
    expectGolden(G, 'contract.create', Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, outcome(CreateCalendarEventSchema.safeParse(v) as any)])));
  });

  it('update, list and complete', () => {
    expectGolden(G, 'contract.update', [
      outcome(UpdateCalendarEventSchema.safeParse({ title: 'New' }) as any),
      outcome(UpdateCalendarEventSchema.safeParse({ rrule: null, reminder_offsets: null }) as any),
      outcome(UpdateCalendarEventSchema.safeParse({ status: 'done' }) as any),
    ]);
    expectGolden(G, 'contract.list', [
      outcome(ListCalendarEventsSchema.safeParse({}) as any),
      outcome(ListCalendarEventsSchema.safeParse({ limit: '500' }) as any),
      outcome(ListCalendarEventsSchema.safeParse({ limit: '20', offset: '40', from: '2026-10-01T00:00:00Z' }) as any),
    ]);
    expectGolden(G, 'contract.complete', [
      outcome(CompleteEventSchema.safeParse({}) as any),
      outcome(CompleteEventSchema.safeParse({ completion_status: 'skipped', completion_notes: 'rain' }) as any),
      outcome(CompleteEventSchema.safeParse({ completion_status: 'maybe' }) as any),
    ]);
  });

  it('allowed values match the database CHECK lists', () => {
    expectGolden(G, 'contract.enums', { source: CALENDAR_SOURCE_TYPES, event: CALENDAR_EVENT_TYPES, domain: EVENT_TYPE_TO_DOMAIN });
  });
});
