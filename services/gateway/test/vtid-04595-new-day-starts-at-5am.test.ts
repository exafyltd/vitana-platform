/**
 * VTID-04595 — a Vitana day starts at 05:00 local, not at midnight.
 *
 * Owner rule 2026-09-26: "New day greeting is always after 5am. So if user has
 * a break of 5 hours within the same day, no new day greeting."
 *
 * The reported case (staging + production, Europe/Berlin): a conversation at
 * 00:39 fired the new-day briefing and stamped user_journey with the NEW
 * calendar date (last_full_briefing_date and last_session_date = 2026-09-26),
 * so the member's real first conversation of the morning at ~08:00 counted as
 * a same-day repeat — no morning greeting, and an opener about what they had
 * "already achieved this morning".
 */
import {
  computeGreetingDecision,
  shouldAttemptNewdayOverview,
  isBeforeNewDayStartHour,
  BRIEFING_DAY_START_HOUR,
  type GreetingDecisionContext,
} from '../src/services/conversation/compute-greeting-decision';
import {
  isBeforeNewDayStart,
  logicalDayInTimezone,
  makeNewDayReturnProvider,
  NEW_DAY_RETURN_EXTRA_KEY,
  NEW_DAY_START_HOUR,
} from '../src/services/assistant-continuation/providers/new-day-return';
import { decideGreetingKind } from '../src/orb/live/instruction/journey-greeting';
import type { JourneyState } from '../src/services/journey/user-journey-service';

const TZ = 'Europe/Berlin'; // UTC+2 in September

function ctx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'de',
    greetLang: 'de',
    bucket: 'today',
    timeAgo: 'about 8 hours ago',
    wasFailure: false,
    firstName: 'Dragan',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-09-25',
    todayTz: '2026-09-26',
    localHour: 8,
    timezone: TZ,
    timeOfDay: 'morning',
    proactiveLine: null,
    newdayOverview: null,
    resumeOverview: null,
    rotationSeed: 42,
    recentNbaKeys: [],
    currentRoute: '/home',
    currentScreenTitle: null,
    menuPhrases: ['Schön, dass du da bist.'],
    openDecision: { mode: 'speak', source: 'wake_brief_selected', line: 'Ich würde vorschlagen, wir schauen auf deinen Tag.' },
    guidedTopicNarrationContent: null,
    wakeBriefDecisionId: 'd-1',
    silenceOnSkipEnabled: false,
    wakeBriefHasSelectedContinuation: true,
    voiceWakeBriefReason: null,
    lastDayCloseDate: null,
    userId: 'user-abc',
    ...over,
  } as GreetingDecisionContext;
}

function journey(over: Partial<JourneyState> = {}): JourneyState {
  return {
    user_id: 'u1',
    tenant_id: null,
    started_at: '2026-09-01T08:00:00.000Z',
    total_days: 90,
    plan_type: 'default',
    plan_summary: null,
    status: 'active',
    is_first_session: false,
    last_session_date: '2026-09-25',
    recent_greeting_openings: [],
    completed_milestone_ids: [],
    last_acknowledged_day: null,
    day_in_journey: 26,
    days_left: 64,
    is_past_total_days: false,
    current_wave: null,
    fallback_used: false,
    ...over,
  } as JourneyState;
}

describe('VTID-04595 — the Vitana day boundary', () => {
  test('the day starts at 05:00 and both copies of the rule agree on every hour', () => {
    expect(NEW_DAY_START_HOUR).toBe(5);
    expect(BRIEFING_DAY_START_HOUR).toBe(NEW_DAY_START_HOUR);
    for (let h = -1; h <= 23; h++) {
      expect(isBeforeNewDayStartHour(h)).toBe(isBeforeNewDayStart(h));
      expect(isBeforeNewDayStart(h)).toBe(h >= 0 && h < 5);
    }
    expect(isBeforeNewDayStart(Number.NaN)).toBe(false);
  });

  test('logicalDayInTimezone: 00:00–04:59 is still the previous day, 05:00 on is today', () => {
    expect(logicalDayInTimezone(new Date('2026-09-25T22:39:00Z'), TZ)).toBe('2026-09-25'); // 00:39
    expect(logicalDayInTimezone(new Date('2026-09-26T02:59:00Z'), TZ)).toBe('2026-09-25'); // 04:59
    expect(logicalDayInTimezone(new Date('2026-09-26T03:00:00Z'), TZ)).toBe('2026-09-26'); // 05:00
    expect(logicalDayInTimezone(new Date('2026-09-26T06:00:00Z'), TZ)).toBe('2026-09-26'); // 08:00
    expect(logicalDayInTimezone(new Date('2026-09-26T21:59:00Z'), TZ)).toBe('2026-09-26'); // 23:59
  });

  test('logicalDayInTimezone rolls back across month and year ends', () => {
    expect(logicalDayInTimezone(new Date('2026-01-01T01:00:00Z'), TZ)).toBe('2025-12-31'); // 02:00 CET
    expect(logicalDayInTimezone(new Date('2026-03-01T02:00:00Z'), TZ)).toBe('2026-02-28'); // 03:00 CET
  });
});

describe('VTID-04595 — the new-day briefing', () => {
  test('the reported case: the 00:39 conversation gets no briefing, so nothing is stamped', () => {
    const night = ctx({ todayTz: '2026-09-26', localHour: 0, lastFullBriefingDate: '2026-09-25' });
    expect(shouldAttemptNewdayOverview(night)).toBe(false);
    const d = computeGreetingDecision({ ...night, newdayOverview: { journey: null } as any });
    expect(d.effects.stampBriefingDate).toBeUndefined();
  });

  test('the first conversation after 05:00 gets the briefing', () => {
    for (const h of [5, 8, 13, 22]) {
      expect(shouldAttemptNewdayOverview(ctx({ localHour: h }))).toBe(true);
    }
  });

  test('no briefing at any hour between 00:00 and 04:59, even when the member skipped yesterday', () => {
    for (const h of [0, 1, 2, 3, 4]) {
      expect(shouldAttemptNewdayOverview(ctx({ localHour: h, lastFullBriefingDate: '2026-09-20' }))).toBe(false);
    }
  });

  test('a long gap inside the same day never re-triggers it', () => {
    // Briefed at 07:00, back at 13:00 or 22:00 the same day.
    for (const h of [13, 22, 23]) {
      expect(shouldAttemptNewdayOverview(ctx({ localHour: h, lastFullBriefingDate: '2026-09-26' }))).toBe(false);
    }
  });

  test('an unknown hour (the -1 placeholder) keeps the date-only rule', () => {
    expect(shouldAttemptNewdayOverview(ctx({ localHour: -1 }))).toBe(true);
    expect(shouldAttemptNewdayOverview(ctx({ localHour: -1, lastFullBriefingDate: '2026-09-26' }))).toBe(false);
  });
});

describe('VTID-04595 — the journey daily_morning greeting (stamps last_session_date)', () => {
  test('no daily_morning before 05:00, so the stamp cannot swallow the morning', () => {
    for (const h of [0, 1, 4]) {
      expect(decideGreetingKind(journey(), '2026-09-26', h)).toBeNull();
    }
  });

  test('daily_morning from 05:00 on', () => {
    expect(decideGreetingKind(journey(), '2026-09-26', 5)).toBe('daily_morning');
    expect(decideGreetingKind(journey(), '2026-09-26', 8)).toBe('daily_morning');
  });

  test('the member already greeted today gets no second morning greeting', () => {
    expect(decideGreetingKind(journey({ last_session_date: '2026-09-26' }), '2026-09-26', 14)).toBeNull();
  });

  test('the one-time first-session welcome is not held back by the hour', () => {
    expect(decideGreetingKind(journey({ is_first_session: true }), '2026-09-26', 2)).toBe('first_session');
  });

  test('callers that pass no hour keep the date-only rule', () => {
    expect(decideGreetingKind(journey(), '2026-09-26')).toBe('daily_morning');
  });
});

describe('VTID-04595 — the new-day-return provider', () => {
  function fakeSupabase(row: { last_session_date: string | null; is_first_session: boolean }) {
    const captured: any = {};
    const sb = {
      from() {
        const b: any = {
          select() { return b; },
          eq() { return b; },
          async maybeSingle() { return { data: row, error: null }; },
          update(patch: any) {
            captured.updatePatch = patch;
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
        return b;
      },
    } as any;
    return { sb, captured };
  }
  function produceAt(iso: string, row = { last_session_date: '2026-09-24', is_first_session: false }) {
    const { sb, captured } = fakeSupabase(row);
    const p = makeNewDayReturnProvider({ now: () => Date.parse(iso), rng: () => 0 });
    return p
      .produce({
        surface: 'orb_wake',
        sessionId: 's1',
        userId: 'u1',
        tenantId: 't1',
        extra: {
          [NEW_DAY_RETURN_EXTRA_KEY]: { supabase: sb, userId: 'u1', tenantId: 't1', lang: 'de', firstName: 'Dragan', timezone: TZ },
        },
      } as any)
      .then((r) => ({ r, captured }));
  }

  test('suppressed at 02:00 and does not stamp last_session_date', async () => {
    const { r, captured } = await produceAt('2026-09-26T00:00:00Z');
    expect(r.status).toBe('suppressed');
    expect(r.reason).toBe('before_new_day_start');
    expect(captured.updatePatch).toBeUndefined();
  });

  test('fires at 08:00 and stamps the day', async () => {
    const { r, captured } = await produceAt('2026-09-26T06:00:00Z');
    expect(r.status).toBe('returned');
    await new Promise((res) => setImmediate(res));
    expect(captured.updatePatch).toEqual({ last_session_date: '2026-09-26' });
  });
});
