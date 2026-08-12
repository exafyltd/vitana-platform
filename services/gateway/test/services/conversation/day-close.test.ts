/**
 * VTID-03604 — the ORB day-close.
 *
 * The two properties this file exists to hold:
 *
 *  1. NEVER the same wording. Enforced structurally: the block must carry a
 *     cross-domain shape example and must NOT carry a `Say exactly` directive,
 *     because that directive is the mechanism behind every repetition bug in
 *     this subsystem (VTID-03475, override_v2, VTID-03597).
 *  2. NEVER a promise Vitana cannot keep. `activate_autopilot_recommendations`
 *     only flips a status — so the block may offer to HOLD things overnight and
 *     must never offer to have them DONE.
 */
import {
  computeGreetingDecision,
  isDayCloseWindow,
  dayCloseNightKey,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';
import {
  selectDayCloseTheme,
  isHardDay,
  DAY_CLOSE_THEMES,
} from '../../../src/services/assistant-continuation/providers/day-close-themes';
import { buildDayCloseBlock } from '../../../src/services/assistant-continuation/providers/day-close-prompt';

function ctx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'de',
    greetLang: 'de',
    bucket: 'today',
    timeAgo: 'earlier today',
    wasFailure: false,
    firstName: 'Dragan',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-06-29',
    todayTz: '2026-06-30',
    localHour: 23,
    timezone: 'Europe/Berlin',
    timeOfDay: 'night',
    proactiveLine: null,
    newdayOverview: null,
    resumeOverview: null,
    rotationSeed: 42,
    recentNbaKeys: [],
    currentRoute: null,
    currentScreenTitle: null,
    menuPhrases: ['Schön, dass du da bist.', 'Lass uns weitermachen.'],
    openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
    guidedTopicNarrationContent: null,
    wakeBriefDecisionId: null,
    silenceOnSkipEnabled: true,
    wakeBriefHasSelectedContinuation: false,
    voiceWakeBriefReason: null,
    lastDayCloseDate: null,
    userId: 'user-abc',
    ...over,
  } as GreetingDecisionContext;
}

describe('VTID-03604 — the night window', () => {
  test('21:00 through 04:59 local is the day-close window', () => {
    for (const h of [21, 22, 23, 0, 1, 2, 3, 4]) expect(isDayCloseWindow(h)).toBe(true);
    for (const h of [5, 9, 12, 17, 20]) expect(isDayCloseWindow(h)).toBe(false);
  });

  test('the -1 placeholder hour is inert — it must not read as midnight', () => {
    // The synchronous greeting path builds its context before the timezone
    // helpers load. If the placeholder were 0, the close would fire all day.
    expect(isDayCloseWindow(-1)).toBe(false);
    expect(isDayCloseWindow(24)).toBe(false);
    expect(isDayCloseWindow(NaN)).toBe(false);
    expect(isDayCloseWindow(23.5)).toBe(false);
  });

  test('after midnight the night is keyed to the evening it started', () => {
    // 00:10 on the 30th still belongs to the evening of the 29th, so a user
    // said goodnight at 23:50 is not said goodnight to again ten minutes later.
    expect(dayCloseNightKey('2026-06-30', 0)).toBe('2026-06-29');
    expect(dayCloseNightKey('2026-06-30', 4)).toBe('2026-06-29');
    expect(dayCloseNightKey('2026-06-30', 23)).toBe('2026-06-30');
    expect(dayCloseNightKey('2026-03-01', 2)).toBe('2026-02-28');
  });
});

describe('VTID-03604 — theme rotation', () => {
  test('cycles every theme before repeating, so none lands two nights running', () => {
    const seen: string[] = [];
    for (let d = 1; d <= DAY_CLOSE_THEMES.length; d++) {
      const iso = `2026-06-${String(d).padStart(2, '0')}`;
      seen.push(selectDayCloseTheme({ todayLocalIso: iso, userId: 'u1' }).key);
    }
    expect(new Set(seen).size).toBe(DAY_CLOSE_THEMES.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  test('deterministic — a reopen the same night cannot switch thought', () => {
    const a = selectDayCloseTheme({ todayLocalIso: '2026-06-30', userId: 'u1' });
    const b = selectDayCloseTheme({ todayLocalIso: '2026-06-30', userId: 'u1' });
    expect(a.key).toBe(b.key);
  });

  test('two users are not in lockstep on the same night', () => {
    const keys = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'].map(
      u => selectDayCloseTheme({ todayLocalIso: '2026-06-30', userId: u }).key,
    );
    expect(new Set(keys).size).toBeGreaterThan(1);
  });

  test('a missing user id still resolves (anonymous-safe, no throw)', () => {
    expect(selectDayCloseTheme({ todayLocalIso: '2026-06-30', userId: null }).key).toBeTruthy();
  });
});

describe('VTID-03604 — hard-day detection is conservative', () => {
  test('a real bad day: index dropped AND nothing logged', () => {
    expect(isHardDay({ indexTrend7d: -4, loggedAnythingToday: false })).toBe(true);
  });

  test('a merely quiet day is NOT a bad day', () => {
    // Mislabelling a calm day as bad is its own insult.
    expect(isHardDay({ indexTrend7d: 0, loggedAnythingToday: false })).toBe(false);
    expect(isHardDay({ indexTrend7d: -4, loggedAnythingToday: true })).toBe(false);
    expect(isHardDay({})).toBe(false);
  });
});

describe('VTID-03604 — the rung on the ladder', () => {
  test('fires at 23:00 with wake_opener day_close and a night stamp', () => {
    const d = computeGreetingDecision(ctx({ localHour: 23 }));
    expect(d.wakeOpener).toBe('day_close');
    expect(d.effects.stampDayCloseDate).toBe('2026-06-30');
    expect(d.directive).toBeTruthy();
  });

  test('OUTRANKS the morning briefing at 00:15 — no "Guten Morgen" past midnight', () => {
    // The calendar date has rolled, so briefingDue() thinks a new day is owed a
    // morning brief. It is not: you have not started a day, you failed to end one.
    const d = computeGreetingDecision(
      ctx({ localHour: 0, todayTz: '2026-07-01', lastFullBriefingDate: '2026-06-29' }),
    );
    expect(d.wakeOpener).toBe('day_close');
    expect(d.effects.stampDayCloseDate).toBe('2026-06-30');
  });

  test('does NOT fire at 14:00 — the ladder proceeds normally', () => {
    const d = computeGreetingDecision(ctx({ localHour: 14 }));
    expect(d.wakeOpener).not.toBe('day_close');
  });

  test('once per night — a reopen after the stamp does not repeat it', () => {
    const d = computeGreetingDecision(ctx({ localHour: 23, lastDayCloseDate: '2026-06-30' }));
    expect(d.wakeOpener).not.toBe('day_close');
  });

  test('the 23:50 → 00:10 reopen is the same night, not a second goodnight', () => {
    const d = computeGreetingDecision(
      ctx({ localHour: 0, todayTz: '2026-07-01', lastDayCloseDate: '2026-06-30' }),
    );
    expect(d.wakeOpener).not.toBe('day_close');
  });

  test('a silent reconnect still wins — a goodnight is loud', () => {
    const d = computeGreetingDecision(
      ctx({ localHour: 23, openDecision: { mode: 'silent', source: 'native_resume', line: null } }),
    );
    expect(d.wakeOpener).toBe('silent_reconnect');
    expect(d.directive).toBeNull();
  });

  test('anonymous sessions never get a day-close', () => {
    const d = computeGreetingDecision(ctx({ localHour: 23, isAnonymous: true }));
    expect(d.wakeOpener).not.toBe('day_close');
  });

  test('fires on the safe-fast ladder too — same evening either way', () => {
    const d = computeGreetingDecision(
      ctx({ localHour: 23, contextReadyResolved: false, safeFastGreetingLive: true }),
    );
    expect(d.wakeOpener).toBe('day_close');
  });
});

describe('VTID-03604 — the composed block', () => {
  const block = (over: Partial<Parameters<typeof buildDayCloseBlock>[0]> = {}) =>
    buildDayCloseBlock({
      lang: 'de',
      firstName: 'Dragan',
      localHour: 0,
      timezone: 'Europe/Berlin',
      theme: DAY_CLOSE_THEMES[0],
      hardDay: false,
      previousUtterance: null,
      sessionsToday: 2,
      pendingCheckpointTitle: null,
      ...over,
    });

  test('carries NO "Say exactly" directive — the repetition mechanism', () => {
    const b = block();
    expect(b).not.toMatch(/Say exactly/i);
    expect(b).not.toMatch(/Sag genau/i);
    expect(b).not.toMatch(/Reci tačno|Di exactamente|Dis exactement/i);
  });

  test('carries a cross-domain shape example and forbids copying its content', () => {
    const b = block();
    expect(b).toMatch(/IMITATE THE TEXTURE, NEVER THE CONTENT/i);
    expect(b).toMatch(/Tomas/); // sailing persona — no overlap with a Vitana user
  });

  test('forbids a recap — the summary is on-demand only', () => {
    const b = block();
    expect(b).toMatch(/THIS IS NOT A SUMMARY/);
    expect(b).toMatch(/Do NOT recap/i);
  });

  test('never promises work will be DONE overnight, only held', () => {
    // activate_autopilot_recommendations flips a status. Anything stronger is
    // a promise broken every morning.
    const b = block();
    expect(b).toMatch(/must NEVER promise/i);
    expect(b).toMatch(/HOLD it, CARRY it, have it READY/);
  });

  test('offers the prepared checkpoint by name when one genuinely exists', () => {
    expect(block({ pendingCheckpointTitle: 'Atem-Sequenz' })).toMatch(/Atem-Sequenz/);
    expect(block({ pendingCheckpointTitle: null })).not.toMatch(/already prepared their next step/);
  });

  test('hard day swaps optimism for warmth and drops the theme', () => {
    const hard = block({ hardDay: true });
    expect(hard).toMatch(/WARMTH, NOT CHEER/);
    expect(hard).not.toMatch(/ONE FORWARD THOUGHT/);
    const normal = block({ hardDay: false });
    expect(normal).toMatch(/ONE FORWARD THOUGHT/);
    expect(normal).toContain(DAY_CLOSE_THEMES[0].senseDe);
  });

  test('past midnight and late evening are different weather', () => {
    expect(block({ localHour: 0 })).toMatch(/AFTER MIDNIGHT/);
    expect(block({ localHour: 22 })).toMatch(/late in the evening/);
  });

  test('holds the length floor and the single-question rule', () => {
    const b = block();
    expect(b).toMatch(/Two to four sentences/);
    expect(b).toMatch(/At most ONE question/);
  });

  test('passes the previous utterance through as a negative example', () => {
    expect(block({ previousUtterance: 'Wird spät bei dir.' })).toMatch(/Wird spät bei dir\./);
  });

  test('English locale gets the English block, not German boilerplate', () => {
    const b = block({ lang: 'en', firstName: 'Sam' });
    expect(b).toMatch(/Speak like someone letting the day end/);
    expect(b).not.toMatch(/Sprich wie jemand/);
  });
});

// ---------------------------------------------------------------------------
// VTID-03604 wiring safety — orb-live.ts seeds the SYNC ladder context with a
// PLACEHOLDER (`todayTz: '', localHour: 0`) before the timezone helpers
// resolve, exactly mirroring the safe-fast side's `localHour: -1`. `0` reads
// as a normal midnight hour and is INSIDE the day-close window, so without an
// explicit guard this placeholder would make day_close fire at any hour, on
// any session that reaches the placeholder context (the async new-day
// branch's own error-recovery path, or any future caller that has not yet
// resolved a real clock reading).
// ---------------------------------------------------------------------------
describe('VTID-03604 — the todayTz placeholder cannot fire day-close', () => {
  test('an empty todayTz never fires day_close, even with an in-window localHour', () => {
    const d = computeGreetingDecision(ctx({ todayTz: '', localHour: 0 }));
    expect(d.wakeOpener).not.toBe('day_close');
  });

  test('the same placeholder with a real lastDayCloseDate still does not crash or fire', () => {
    const d = computeGreetingDecision(ctx({ todayTz: '', localHour: 0, lastDayCloseDate: '2026-06-29' }));
    expect(d.wakeOpener).not.toBe('day_close');
  });

  test('a real todayTz at the same hour fires normally — the guard is scoped to the placeholder, not the hour', () => {
    const d = computeGreetingDecision(ctx({ todayTz: '2026-06-30', localHour: 0 }));
    expect(d.wakeOpener).toBe('day_close');
  });
});
