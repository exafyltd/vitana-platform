/**
 * VTID-04575 — reopening a voice conversation continues it.
 *
 * A session the client restarted with the conversation's earlier turns
 * (resumedFromHistory) used to open with the reconnect recovery prompt: a
 * user-role block ("You are recovering from a brief connection blip…" plus a
 * stack of prohibitions). Nova's content filter rejected it on 44 of 61 such
 * starts in 14 days; the retry through the greeting ladder then spoke 43 of 44
 * times. Reopens now take the ladder directly, and its resume_thread rung
 * continues the earlier thread.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  computeGreetingDecision,
  setDayCloseRungEnabled,
  buildResumeThreadOpenTrigger,
  WAKE_OPENERS,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';
import { isVerbatimRecitationDirective, PHRASING_RULE } from '../../../src/services/conversation/phrasing-rule';
import { shouldOpenReopenThroughGreetingLadder } from '../../../src/routes/orb-live';

function ctx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'de',
    greetLang: 'de',
    bucket: 'reconnect',
    timeAgo: 'about 2 minutes ago',
    wasFailure: false,
    firstName: 'Dragan',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-09-25',
    todayTz: '2026-09-25',
    localHour: 18,
    timezone: 'Europe/Madrid',
    timeOfDay: 'evening',
    proactiveLine: null,
    newdayOverview: null,
    resumeOverview: null,
    rotationSeed: 42,
    recentNbaKeys: [],
    currentRoute: '/me/profile',
    currentScreenTitle: null,
    menuPhrases: ['Schön, dass du da bist.'],
    openDecision: { mode: 'speak', source: 'wake_brief_selected', line: 'Ich würde vorschlagen, wir ergänzen dein Profil.' },
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

afterEach(() => setDayCloseRungEnabled(false));

describe('VTID-04575 — resume_thread rung', () => {
  test('a reopen with history continues the thread on the normal ladder, above the wake-brief lead', () => {
    expect(computeGreetingDecision(ctx()).wakeOpener).toBe('override_v2');
    const d = computeGreetingDecision(ctx({ reopenedWithHistory: true }));
    expect(d.wakeOpener).toBe('resume_thread');
    expect(d.directive).toBe(buildResumeThreadOpenTrigger());
    expect(d.effects.markGreetingSent).toBe(true);
    expect(d.effects.armWatchdog).toBe(true);
  });

  test('same on the safe-fast ladder (context not yet resolved)', () => {
    const d = computeGreetingDecision(ctx({ reopenedWithHistory: true, contextReadyResolved: false, safeFastGreetingLive: true }));
    expect(d.wakeOpener).toBe('resume_thread');
  });

  test('outranks the day-close at night', () => {
    setDayCloseRungEnabled(true);
    const night = ctx({ localHour: 23, timeOfDay: 'night', lastDayCloseDate: null });
    expect(computeGreetingDecision({ ...night, reopenedWithHistory: true }).wakeOpener).toBe('resume_thread');
  });

  test('an explicit support report or tapped topic still wins', () => {
    expect(computeGreetingDecision(ctx({ reopenedWithHistory: true, supportReportOpen: true })).wakeOpener).toBe('support_report');
    expect(computeGreetingDecision(ctx({ reopenedWithHistory: true, guidedTopicNarrationContent: 'lesson' })).wakeOpener).toBe('override_v2');
  });

  test('never for anonymous sessions, nor without the flag', () => {
    expect(computeGreetingDecision(ctx({ reopenedWithHistory: true, isAnonymous: true })).wakeOpener).not.toBe('resume_thread');
    expect(computeGreetingDecision(ctx({ reopenedWithHistory: false })).wakeOpener).not.toBe('resume_thread');
  });

  test('the directive is a positive intent: no quoted sentence, no recitation, no prohibition stack', () => {
    const t = buildResumeThreadOpenTrigger();
    expect(t).not.toMatch(/"/);
    expect(isVerbatimRecitationDirective(t)).toBe(false);
    expect(t).not.toMatch(/\b(do not|don't|never|must not)\b/i);
    expect(t).not.toMatch(/connection|reconnect|blip/i);
    expect(t).toContain('conversation history');
    expect(t).toContain(PHRASING_RULE);
  });

  test('listed for the Command Hub Opening tab', () => {
    expect(WAKE_OPENERS).toContain('resume_thread');
  });
});

describe('VTID-04575 — routing', () => {
  test('a client restart with history at zero turns opens through the ladder', () => {
    expect(shouldOpenReopenThroughGreetingLadder({ resumedFromHistory: true, reconnectCount: 0, turnCount: 0 })).toBe(true);
  });

  test('a backend transparent reconnect, a later turn, or a fresh session do not', () => {
    expect(shouldOpenReopenThroughGreetingLadder({ resumedFromHistory: true, reconnectCount: 1, turnCount: 0 })).toBe(false);
    expect(shouldOpenReopenThroughGreetingLadder({ resumedFromHistory: true, reconnectCount: 0, turnCount: 2 })).toBe(false);
    expect(shouldOpenReopenThroughGreetingLadder({ resumedFromHistory: false, reconnectCount: 0, turnCount: 0 })).toBe(false);
  });

  const live = fs.readFileSync(path.join(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');

  test('the SSE dispatch sends a reopen to the greeting, not the recovery prompt', () => {
    const at = live.indexOf('const reopenOpensThroughLadder = shouldOpenReopenThroughGreetingLadder({');
    expect(at).toBeGreaterThan(0);
    const block = live.slice(at, at + 900);
    expect(block).toContain('const isReconnectGreetingSkip = !reopenOpensThroughLadder && (');
    expect(block).toContain('sendReconnectRecoveryPromptToLiveAPI(ws, session);');
  });

  test('the greeting sender marks the reopen (sticky) and forces a spoken open, for both transports', () => {
    const fn = live.indexOf('function sendGreetingPromptToLiveAPI(');
    const body = live.slice(fn, fn + 4000);
    expect(body).toContain('if (shouldOpenReopenThroughGreetingLadder({');
    expect(body).toContain('(session as any)._reopenedWithHistory = true;');
    expect(body).toContain('(session as any)._freshOpenAfterZeroTurnRecovery = true;');
  });

  test('both greeting ladders read it, gated on turn 0', () => {
    const matches = live.match(/reopenedWithHistory: \(session as any\)\._reopenedWithHistory === true && \(session\.turn_count \|\| 0\) === 0,/g);
    expect(matches).toHaveLength(2);
  });
});
