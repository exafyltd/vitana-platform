/**
 * VTID-04395 — Support "report by voice": turn 1 is a support intake, not a
 * briefing, on both greeting ladders; composed by the model (an intent, never
 * a finished sentence); never re-opened after the first turn.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  computeGreetingDecision,
  setDayCloseRungEnabled,
  buildSupportReportOpenTrigger,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';

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

afterEach(() => setDayCloseRungEnabled(false));

describe('support-report rung', () => {
  test('opens as a support intake on the normal ladder', () => {
    const d = computeGreetingDecision(ctx({ supportReportOpen: true }));
    expect(d.wakeOpener).toBe('support_report');
    expect(d.directive).toBe(buildSupportReportOpenTrigger());
    expect(d.effects.markGreetingSent).toBe(true);
  });

  test('outranks the day-close at night', () => {
    setDayCloseRungEnabled(true);
    const night = ctx({ localHour: 23, lastDayCloseDate: null });
    expect(computeGreetingDecision(night).wakeOpener).toBe('day_close');
    expect(computeGreetingDecision({ ...night, supportReportOpen: true }).wakeOpener).toBe('support_report');
  });

  test('opens as a support intake on the safe-fast ladder too', () => {
    const d = computeGreetingDecision(ctx({ supportReportOpen: true, safeFastGreetingLive: true }));
    expect(d.wakeOpener).toBe('support_report');
  });

  test('never for an anonymous session, and not when the flag is off', () => {
    expect(computeGreetingDecision(ctx({ supportReportOpen: true, isAnonymous: true })).wakeOpener).not.toBe('support_report');
    expect(computeGreetingDecision(ctx({ supportReportOpen: false })).wakeOpener).not.toBe('support_report');
  });

  test('is an English intent with no quoted spoken sentence (NEVER-rule 41)', () => {
    const t = buildSupportReportOpenTrigger();
    expect(t).not.toMatch(/"/);
    expect(t).not.toMatch(/Say exactly/i);
    expect(t).toContain('report_to_specialist');
    expect(t).toContain("in the member's own language");
  });
});

describe('wiring', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../../..', p), 'utf8');
  test('session start stores support_report from the start body', () => {
    expect(read('src/orb/live/session/live-session-controller.ts')).toContain(
      'support_report: (body as any).support_report === true,',
    );
  });
  test('both greeting sites gate it on turn 0', () => {
    const live = read('src/routes/orb-live.ts');
    expect(live.match(/supportReportOpen: \(session as any\)\.support_report === true && \(session\.turn_count \|\| 0\) === 0,/g)).toHaveLength(2);
  });
  test('the widget exposes startSupportReport and sends the flag one-shot', () => {
    const w = read('src/frontend/command-hub/orb-widget.js');
    expect(w).toContain('startSupportReport: function ()');
    expect(w).toContain('startPayload.support_report = true;\n        _s.supportReport = false;');
  });
  test('the Command Hub orb-widget cache-bust is this change or later', () => {
    const m = read('src/frontend/command-hub/index.html').match(/orb-widget\.js\?v=(\d{8})-vtid-(\d{4,5})/);
    expect(m).not.toBeNull();
    expect(m![1] >= '20260923').toBe(true);
  });
});
