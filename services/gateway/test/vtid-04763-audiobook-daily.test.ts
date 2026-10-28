/**
 * VTID-04763 — Audiobook daily habit and measurement.
 *
 * Pins:
 *   - the four Audiobook metrics (listen-through, Season 0 completion,
 *     day-7 return, listening → first action);
 *   - "one episode a day" is kept per the member's own calendar day;
 *   - the daily reminder preference: validation, set, clear, and that a
 *     time change keeps the last-sent day (no second push the same day);
 *   - the reminder tick: delivery gate respected, localized text, a plain
 *     path deep link, and nothing for a member with no tenant;
 *   - the claim function's guarantees (the SQL itself was executed against
 *     PGlite — docs/validation/VTID-04763).
 */
import fs from 'fs';
import path from 'path';
import { computeAudiobookMetrics } from '../src/services/guided-journey/audiobook-metrics';
import {
  recordListenedSession,
  setAudiobookReminder,
  parseReminderPref,
  toJourneyState,
} from '../src/services/guided-journey/guided-journey-state';
import {
  runAudiobookReminderTick,
  isAudiobookReminderLoopEnabled,
  AUDIOBOOK_REMINDER_ROUTE,
} from '../src/services/guided-journey/audiobook-reminder-dispatch';

const ev = (event_name: string, user: string | null, iso: string, properties: Record<string, unknown> = {}) => ({
  event_name,
  user_id_hash: user,
  properties,
  occurred_at: iso,
});

describe('computeAudiobookMetrics', () => {
  const d = (day: number, h = 9) => new Date(Date.UTC(2026, 9, 1 + day, h)).toISOString();

  it('computes listen-through, Season 0 completion, day-7 return and listening → action', () => {
    const events = [
      // a: plays day 0, finishes the whole Prolog, tries something, returns on day 8
      ev('audiobook_play_started', 'a', d(0)),
      ...[1, 2, 3, 4, 5, 6].flatMap((n) => [
        ev('audiobook_track_started', 'a', d(0, 9 + n)),
        ev('audiobook_track_completed', 'a', d(0, 9 + n)),
        ev('audiobook_episode_completed', 'a', d(0, 9 + n), { episode: n, chapter_id: 'prolog' }),
      ]),
      ev('audiobook_try_it_now', 'a', d(0, 18)),
      ev('audiobook_play_started', 'a', d(8)),
      // b: plays day 0, abandons the first track, never comes back
      ev('audiobook_play_started', 'b', d(0)),
      ev('audiobook_track_started', 'b', d(0)),
      // c: plays day 5 (too recent for the day-7 cohort), finishes episode 1, asks Vitana BEFORE finishing
      ev('audiobook_play_started', 'c', d(5)),
      ev('audiobook_ask_vitana', 'c', d(5, 8)),
      ev('audiobook_track_started', 'c', d(5, 10)),
      ev('audiobook_track_completed', 'c', d(5, 10)),
      ev('audiobook_episode_completed', 'c', d(5, 10), { episode: 1, chapter_id: 'prolog' }),
    ];
    const m = computeAudiobookMetrics(events, new Date(d(10)));
    expect(m.listeners).toBe(3);
    expect(m.tracks_started).toBe(8);
    expect(m.tracks_completed).toBe(7);
    expect(m.listen_through_rate).toBe(0.875);
    expect(m.season0_completed_listeners).toBe(1);
    expect(m.season0_completion).toBe(0.3333);
    expect(m.day7_cohort).toBe(2); // a and b; c started too recently
    expect(m.day7_returned).toBe(1);
    expect(m.day7_return_rate).toBe(0.5);
    expect(m.finished_an_episode).toBe(2); // a and c
    expect(m.took_first_action).toBe(1); // a (c asked before finishing)
    expect(m.listen_to_action_rate).toBe(0.5);
    expect(m.top_episodes[0]).toEqual({ episode: 1, completions: 2 });
  });

  it('is all zeros, not NaN, without events', () => {
    const m = computeAudiobookMetrics([]);
    expect(m.listeners).toBe(0);
    expect(m.listen_through_rate).toBe(0);
    expect(m.day7_return_rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// state: daily listen + reminder preference
// ---------------------------------------------------------------------------
function fakeStateClient(row: Record<string, any>) {
  const updates: Record<string, any>[] = [];
  const client = {
    from() {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: row, error: null }),
        single: async () => ({ data: { ...row, ...updates[updates.length - 1] }, error: null }),
        update: (patch: Record<string, any>) => {
          updates.push(patch);
          return b;
        },
      };
      return b;
    },
  } as any;
  return { client, updates };
}

const baseRow = {
  user_id: 'u-1',
  mode: 'guided',
  onboarding_status: 'in_progress',
  current_session: 3,
  completed_topic_ids: [],
  completed_practice_count: 0,
  qualification_threshold: 60,
  qualified_at: null,
  skipped_onboarding_at: null,
  entered_full_mode_at: null,
  returned_to_guided_at: null,
  last_opened_topic_id: null,
  metadata: {} as Record<string, unknown>,
  created_at: '',
  updated_at: '',
};

describe('one episode a day, per the member\'s own calendar day', () => {
  it('starts a new day record and accumulates distinct episodes on the same day', async () => {
    const { client, updates } = fakeStateClient({ ...baseRow, metadata: { daily_listen: { date: '2026-09-30', sessions: [1, 2] } } });
    await recordListenedSession(client, 'u-1', 3, 'now', '2026-10-01');
    expect(updates[0].metadata.daily_listen).toEqual({ date: '2026-10-01', sessions: [3] });

    const same = fakeStateClient({ ...baseRow, current_session: 5, metadata: { daily_listen: { date: '2026-10-01', sessions: [3] } } });
    await recordListenedSession(same.client, 'u-1', 4, 'now', '2026-10-01');
    expect(same.updates[0].metadata.daily_listen).toEqual({ date: '2026-10-01', sessions: [3, 4] });
  });

  it('an episode already counted today writes nothing', async () => {
    const { client, updates } = fakeStateClient({ ...baseRow, current_session: 5, metadata: { daily_listen: { date: '2026-10-01', sessions: [3] } } });
    await recordListenedSession(client, 'u-1', 3, 'now', '2026-10-01');
    expect(updates).toHaveLength(0);
  });

  it('a malformed local date is ignored, progress still advances', async () => {
    const { client, updates } = fakeStateClient({ ...baseRow });
    await recordListenedSession(client, 'u-1', 3, 'now', '01/10/2026');
    expect(updates[0].metadata).toBeUndefined();
    expect(updates[0].current_session).toBe(4);
  });

  it('the state exposes the day record and the reminder', () => {
    const s = toJourneyState({
      ...baseRow,
      metadata: { daily_listen: { date: '2026-10-01', sessions: [3] }, audiobook_reminder: { time: '08:00', tz: 'Europe/Berlin' } },
    } as any);
    expect(s.dailyListen).toEqual({ date: '2026-10-01', sessions: [3] });
    expect(s.audiobookReminder).toEqual({ time: '08:00', tz: 'Europe/Berlin' });
  });
});

describe('daily reminder preference', () => {
  it('accepts HH:MM before 22:00 in a real time zone only', () => {
    expect(parseReminderPref({ time: '08:00', tz: 'Europe/Berlin' })).toEqual({ time: '08:00', tz: 'Europe/Berlin' });
    expect(parseReminderPref({ time: '21:59', tz: 'UTC' })).not.toBeNull();
    expect(parseReminderPref({ time: '22:00', tz: 'UTC' })).toBeNull();
    expect(parseReminderPref({ time: '8:00', tz: 'UTC' })).toBeNull();
    expect(parseReminderPref({ time: '08:00', tz: 'Mars/Olympus' })).toBeNull();
    expect(parseReminderPref(null)).toBeNull();
  });

  it('a time change keeps the last-sent day, so it can never fire twice in one day', async () => {
    const { client, updates } = fakeStateClient({
      ...baseRow,
      metadata: { audiobook_reminder: { time: '08:00', tz: 'UTC', last_sent_local_date: '2026-10-01' }, other: 1 },
    });
    await setAudiobookReminder(client, 'u-1', { time: '18:00', tz: 'UTC' });
    expect(updates[0].metadata).toEqual({
      audiobook_reminder: { time: '18:00', tz: 'UTC', last_sent_local_date: '2026-10-01' },
      other: 1,
    });
  });

  it('switching off removes only the reminder', async () => {
    const { client, updates } = fakeStateClient({ ...baseRow, metadata: { audiobook_reminder: { time: '08:00', tz: 'UTC' }, other: 1 } });
    await setAudiobookReminder(client, 'u-1', null);
    expect(updates[0].metadata).toEqual({ other: 1 });
  });
});

// ---------------------------------------------------------------------------
// reminder tick
// ---------------------------------------------------------------------------
describe('runAudiobookReminderTick', () => {
  const claimed = [
    { user_id: 'user-1-xxxxxxxx', tenant_id: 't-1', local_date: '2026-10-01' },
    { user_id: 'user-2-xxxxxxxx', tenant_id: 't-1', local_date: '2026-10-01' },
    { user_id: 'user-3-xxxxxxxx', tenant_id: null, local_date: '2026-10-01' },
  ];
  const supa = { rpc: jest.fn(async () => ({ data: claimed, error: null })) };

  it('pushes the localized "episode for today" with a plain-path deep link, through the delivery gate', async () => {
    const decide = jest.fn(async (_s: any, i: any) => ({ send: i.userId !== 'user-2-xxxxxxxx', reason: 'quiet_hours' as any }));
    const send = jest.fn(async () => 1);
    const r = await runAudiobookReminderTick(supa, {
      decide: decide as any,
      send: send as any,
      getLocale: (async () => 'de') as any,
    });
    expect(supa.rpc).toHaveBeenCalledWith('claim_due_audiobook_reminders', { p_limit: 200 });
    expect(r).toEqual({ ok: true, claimed: 3, sent: 1 });
    expect(decide).toHaveBeenCalledTimes(2); // the tenant-less member never reaches the gate
    expect(decide.mock.calls[0][1]).toMatchObject({ type: 'reminder_due', tenantId: 't-1' });
    expect(send).toHaveBeenCalledTimes(1); // user-2 held by quiet hours
    const payload = (send.mock.calls[0] as any[])[2];
    expect(payload.title).toBe('🎧 Deine Folge für heute');
    expect(payload.data).toEqual({ type: 'audiobook.daily', url: AUDIOBOOK_REMINDER_ROUTE });
    expect(AUDIOBOOK_REMINDER_ROUTE).not.toContain('?');
  });

  it('reports a claim error without throwing', async () => {
    const r = await runAudiobookReminderTick({ rpc: async () => ({ data: null, error: { message: 'boom' } }) });
    expect(r).toEqual({ ok: false, claimed: 0, sent: 0, error: 'boom' });
  });

  it('runs only where reminders are dispatched, with its own kill switch', () => {
    expect(isAudiobookReminderLoopEnabled({ REMINDERS_INPROCESS_DISPATCH_ENABLED: 'true' } as any)).toBe(true);
    expect(isAudiobookReminderLoopEnabled({} as any)).toBe(false);
    expect(
      isAudiobookReminderLoopEnabled({ REMINDERS_INPROCESS_DISPATCH_ENABLED: 'true', AUDIOBOOK_REMINDERS_DISABLED: 'true' } as any),
    ).toBe(false);
  });
});

describe('claim_due_audiobook_reminders (SQL guarantees)', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../../supabase/migrations/20261001130000_VTID_04763_audiobook_daily_reminder_claim.sql'),
    'utf8',
  );
  it('claims atomically and once per local day', () => {
    expect(sql).toContain('FOR UPDATE OF s SKIP LOCKED');
    expect(sql).toContain("'{audiobook_reminder,last_sent_local_date}'");
    expect(sql).toContain("COALESCE(s.metadata->'audiobook_reminder'->>'last_sent_local_date', '') <> c.local_ts::date::text");
  });
  it('skips members who already listened today and never fails the batch on a bad zone', () => {
    expect(sql).toContain("COALESCE(s.metadata->'daily_listen'->>'date', '') <> c.local_ts::date::text");
    expect(sql).toContain('CASE WHEN r.tz IN (SELECT name FROM zones) THEN now() AT TIME ZONE r.tz END');
  });
  it('is callable by the gateway service role only', () => {
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });
});
