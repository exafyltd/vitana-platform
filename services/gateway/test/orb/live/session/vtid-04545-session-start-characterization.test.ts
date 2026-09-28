/**
 * VTID-04545 — characterization of `handleLiveSessionStart` for an
 * authenticated session, written against the behaviour on main BEFORE the
 * session-start latency work (quota ‖ identity ‖ client context, the
 * per-start read memo, the removed journey-greeting block computation, the
 * parallel journey-standing / onboarding-cohort tail).
 *
 * The contract: for the same inputs, every conversation-visible output is
 * identical — the response body, the system-instruction context, the
 * greeting facts copied onto the session, the wake-brief override block, the
 * language, the last-session info, the onboarding-cohort block, and the
 * `user_journey` write (`updateSessionEndState` / `ensureUserJourneyRow`).
 * Only WHEN and HOW OFTEN the reads run may change.
 *
 * Every external read is a fixture; nothing touches a network or a database.
 */

jest.mock('../../../../src/services/voice-quota-guard', () => ({
  reserveVoiceQuotaAtSessionStart: jest.fn(async () => ({
    feature: 'voice_live_minutes',
    paywall_action: 'allow',
    quota: 600,
    used: 10,
    remaining: 590,
    reset_at: null,
    start_on_standard_tier: false,
    deferred_for_vulnerability: false,
  })),
  recordVoiceMinute: jest.fn(async () => 0),
  triggerDowngrade: jest.fn(async () => undefined),
}));

const flagState: Record<string, boolean> = {};
jest.mock('../../../../src/services/feature-flags', () => {
  const actual = jest.requireActual('../../../../src/services/feature-flags');
  return {
    ...actual,
    isFeatureLive: (name: string) => !!flagState[name],
  };
});

// ---- fake Supabase: a chainable builder resolving per-table fixtures ------
type Q = { table: string; select: string | null; eqs: Array<[string, unknown]> };
const queryLog: Q[] = [];
function fixtureFor(q: Q): { data: unknown; error: null } {
  switch (q.table) {
    case 'memory_facts':
      return { data: { fact_value: 'Dragan' }, error: null };
    case 'app_users':
      return { data: { display_name: 'Dragan Stevanovic' }, error: null };
    case 'user_journey':
      return {
        data: {
          is_first_session: false,
          last_session_date: '2026-09-20',
          last_full_briefing_date: '2026-09-19',
          last_day_close_date: null,
          recent_nbas: ['nba_a', { key: 'nba_b' }],
        },
        error: null,
      };
    case 'user_guided_journey_state':
      return { data: { completed_topic_ids: ['T001'], onboarding_status: 'in_progress', mode: 'guided' }, error: null };
    default:
      return { data: null, error: null };
  }
}
function makeFakeSupabase(): any {
  return {
    from(table: string) {
      const q: Q = { table, select: null, eqs: [] };
      const settle = () => {
        queryLog.push({ ...q, eqs: [...q.eqs] });
        return Promise.resolve(fixtureFor(q));
      };
      const b: any = {
        select(cols: string) { q.select = cols; return b; },
        eq(k: string, v: unknown) { q.eqs.push([k, v]); return b; },
        in() { return b; }, order() { return b; }, limit() { return b; },
        gte() { return b; }, lte() { return b; }, neq() { return b; }, is() { return b; },
        insert() { return b; }, upsert() { return b; }, update() { return b; }, delete() { return b; },
        maybeSingle: settle,
        single: settle,
        then(res: any, rej: any) { return settle().then(res, rej); },
      };
      return b;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}
const fakeSupabase = makeFakeSupabase();
jest.mock('../../../../src/lib/supabase', () => ({
  getSupabase: () => fakeSupabase,
}));

jest.mock('../../../../src/services/system-controls-service', () => {
  const actual = jest.requireActual('../../../../src/services/system-controls-service');
  return { ...actual, isVitanaBrainOrbEnabled: jest.fn(async () => false) };
});

jest.mock('../../../../src/services/admin-scanners/briefing', () => {
  const actual = jest.requireActual('../../../../src/services/admin-scanners/briefing');
  return { ...actual, fetchAdminBriefingBlock: jest.fn(async () => null) };
});

jest.mock('../../../../src/routes/autopilot-recommendations', () => ({
  buildAutopilotOfferBlock: jest.fn(async () => '\n[AUTOPILOT OFFER]\n'),
}));

jest.mock('../../../../src/services/assistant-continuation/providers/login-briefing', () => ({
  computeFastProactiveOpener: jest.fn(async () => 'PROACTIVE-LINE'),
}));

jest.mock('../../../../src/services/assistant-continuation/providers/new-day-overview-payload', () => {
  const actual = jest.requireActual('../../../../src/services/assistant-continuation/providers/new-day-overview-payload');
  return {
    ...actual,
    fetchGuidedJourney: jest.fn(async () => ({ fixture: true })),
    buildGuidedJourneyStandingInstruction: jest.fn(() => '\n[JOURNEY STANDING]\n'),
  };
});

jest.mock('../../../../src/services/wake-cadence-signals', () => {
  const actual = jest.requireActual('../../../../src/services/wake-cadence-signals');
  return {
    ...actual,
    fetchWakeCadenceSignals: jest.fn(async () => ({ sessions_today_count: 1 })),
    recordWakeSessionStart: jest.fn(async () => undefined),
  };
});

jest.mock('../../../../src/orb/context/compile-assistant-decision-context', () => ({
  compileAssistantDecisionContext: jest.fn(async () => ({ pillar_momentum: { slipping: 'sleep' } })),
}));

jest.mock('../../../../src/services/wake-brief-wiring', () => ({
  decideWakeBriefForSession: jest.fn(async () => ({
    decisionId: 'decision-1',
    selectedContinuation: {
      kind: 'wake_brief',
      userFacingLine: 'A lead line for turn one.',
      dedupeKey: 'wake:fixture',
      evidence: [{ kind: 'source:fixture' }],
    },
    suppressionReason: null,
    sourceProviderResults: [],
  })),
}));

const journeyServiceMock = {
  getJourneyState: jest.fn(async () => ({
    is_first_session: false,
    last_session_date: '2026-09-01',
    day_in_journey: 7,
    total_days: 90,
    current_wave: { id: 'w1', name: 'Getting Started' },
    recent_greeting_openings: [],
    fallback_used: true,
    started_at: '2026-08-20T00:00:00Z',
  })),
  ensureUserJourneyRow: jest.fn(async () => undefined),
  updateSessionEndState: jest.fn(async () => undefined),
};
jest.mock('../../../../src/services/journey/user-journey-service', () => journeyServiceMock);

jest.mock('../../../../src/services/user-context-profiler', () => ({
  fetchLifeCompass: jest.fn(async () => ({ primary_goal: 'sleep better' })),
}));

jest.mock('../../../../src/services/journey-foundation/journey-foundation-state', () => ({
  buildJourneyFoundationSnapshot: jest.fn(async () => ({
    current_next_step: { title: 'Step', benefit: 'Benefit.' },
  })),
}));

const snapshotCalls: any[] = [];
jest.mock('../../../../src/orb/live/instruction/wake-decision-snapshot', () => {
  const actual = jest.requireActual('../../../../src/orb/live/instruction/wake-decision-snapshot');
  return { ...actual, logWakeDecisionSnapshot: (input: any) => { snapshotCalls.push(input); } };
});

jest.mock('../../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => undefined),
}));

jest.mock('../../../../src/routes/agents-registry', () => ({
  recordAgentHeartbeat: jest.fn(async () => undefined),
}));

import {
  configureLiveSessionController,
  handleLiveSessionStart,
  buildVertexWakeBriefBlock,
  __resetLiveSessionControllerForTests,
  type LiveSessionControllerDeps,
} from '../../../../src/orb/live/session/live-session-controller';
import { liveSessions, sessions, wsClientSessions } from '../../../../src/orb/live/session/live-session-registry';
import { composeSessionContext } from '../../../../src/orb/live/session/session-context-builder';
import { todayInTimezone } from '../../../../src/orb/live/instruction/journey-greeting';

const USER = 'user-aaaa-bbbb';
const TENANT = 'tenant-1111';
const TZ = 'Europe/Berlin';

function makeDeps(spies: Record<string, jest.Mock>): LiveSessionControllerDeps {
  return {
    resolveOrbIdentity: spies.resolveOrbIdentity as any,
    clearResponseWatchdog: () => undefined,
    sendEndOfTurn: () => true,
    validateOrigin: () => true,
    buildClientContext: spies.buildClientContext as any,
    normalizeLang: (l: string) => (l || 'en').slice(0, 2).toLowerCase(),
    getVoiceForLang: (l: string) => `voice-${l}`,
    getStoredLanguagePreference: spies.getStoredLanguagePreference as any,
    persistLanguagePreference: spies.persistLanguagePreference as any,
    fetchLastSessionInfo: spies.fetchLastSessionInfo as any,
    fetchOnboardingCohortBlock: spies.fetchOnboardingCohortBlock as any,
    buildBootstrapContextPack: spies.buildBootstrapContextPack as any,
    resolveEffectiveRole: spies.resolveEffectiveRole as any,
    terminateExistingSessionsForUser: () => 0,
    emitLiveSessionEvent: spies.emitLiveSessionEvent as any,
    describeTimeSince: (info: any) => ({ bucket: info ? 'yesterday' : 'first_time', wasFailure: !!info?.wasFailure }),
    sendAudioToLiveAPI: () => true,
    startResponseWatchdog: () => undefined,
    emitDiag: () => undefined,
    getGoogleAuthReady: () => true,
  };
}

function makeSpies(): Record<string, jest.Mock> {
  return {
    resolveOrbIdentity: jest.fn(async (req: any) =>
      req.identity ? { ...req.identity, tenant_id: req.identity.tenant_id || TENANT } : null),
    buildClientContext: jest.fn(async () => ({
      city: 'Cologne', country: 'DE', timezone: TZ, localTime: 'Friday afternoon, 15:00',
      timeOfDay: 'afternoon', device: 'Desktop', isMobile: false, lang: 'de',
    })),
    getStoredLanguagePreference: jest.fn(async () => 'de'),
    persistLanguagePreference: jest.fn(() => undefined),
    fetchLastSessionInfo: jest.fn(async () => ({ time: '2026-09-20T08:00:00Z', wasFailure: false })),
    fetchOnboardingCohortBlock: jest.fn(async () => '\n[ONBOARDING-COHORT RULE]\n'),
    buildBootstrapContextPack: jest.fn(async () => ({
      contextInstruction: 'BASE CONTEXT', contextPack: { pack: 1 }, latencyMs: 5, skippedReason: undefined,
    })),
    resolveEffectiveRole: jest.fn(async () => 'community'),
    emitLiveSessionEvent: jest.fn(async () => undefined),
  };
}

function makeReq(identity: any, body: any = {}) {
  return {
    identity,
    headers: { 'user-agent': 'jest-agent', origin: 'https://test.example' },
    body,
    query: {},
    get: () => undefined,
  } as any;
}

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const flush = () => new Promise((r) => setImmediate(r));

async function runStart(opts: { fastStart: boolean; safeFastGreeting: boolean; jwtTenant: string | null; body?: any }) {
  flagState.ORB_FAST_START = opts.fastStart;
  flagState.ORB_SAFE_FAST_GREETING = opts.safeFastGreeting;
  const spies = makeSpies();
  configureLiveSessionController(makeDeps(spies));
  const identity = { user_id: USER, tenant_id: opts.jwtTenant, email: 'dragan@example.com', exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null };
  const res = makeRes();
  await handleLiveSessionStart(makeReq(identity, opts.body ?? {}), res);
  const payload = res.json.mock.calls[0][0];
  const session: any = liveSessions.get(payload.session_id);
  if (session?.contextReadyPromise) await session.contextReadyPromise;
  if (session?.greetingFactsReady) await session.greetingFactsReady;
  for (let i = 0; i < 5; i++) await flush();
  return { res, payload, session, spies };
}

/** The conversation-visible surface of a started session. */
function visible(session: any) {
  return {
    lang: session.lang,
    active_role: session.active_role,
    contextInstruction: session.contextInstruction,
    contextPack: session.contextPack,
    contextBootstrapSkippedReason: session.contextBootstrapSkippedReason,
    contextBuilder: session.contextBuilder,
    contextBrainRole: session.contextBrainRole,
    contextExtras: session.contextExtras,
    lastSessionInfo: session.lastSessionInfo,
    onboardingCohortBlock: session.onboardingCohortBlock,
    identity: session.identity,
    isAnonymous: session.isAnonymous,
    clientContext: session.clientContext,
    greetingFirstName: session.greetingFirstName,
    greetingProactiveLine: session.greetingProactiveLine,
    greetingIsFirstTime: session.greetingIsFirstTime,
    greetingNeedsOnboarding: session.greetingNeedsOnboarding,
    greetingHasPriorSession: session.greetingHasPriorSession,
    lastFullBriefingDate: session.lastFullBriefingDate,
    lastDayCloseDate: session.lastDayCloseDate,
    recentNbaKeys: session.recentNbaKeys,
    wakeBriefOverrideBlock: session.wakeBriefOverrideBlock,
    decisionContext: session.decisionContext,
    wakeBriefDecisionId: session.wakeBriefDecision?.decisionId ?? null,
  };
}

function expectedVisible(jwtTenant: string | null, safeFastGreeting: boolean) {
  const identity = { user_id: USER, tenant_id: jwtTenant || TENANT, email: 'dragan@example.com', exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null };
  return {
    lang: 'de',
    active_role: 'community',
    contextInstruction: composeSessionContext({
      base: 'BASE CONTEXT',
      role: 'community',
      isAdminRole: false,
      extras: { autopilotOffer: '\n[AUTOPILOT OFFER]\n', adminBriefing: null },
      journeyBlock: '\n[JOURNEY STANDING]\n',
    }).text,
    contextPack: { pack: 1 },
    contextBootstrapSkippedReason: undefined,
    contextBuilder: 'legacy',
    contextBrainRole: 'community',
    contextExtras: { autopilotOffer: '\n[AUTOPILOT OFFER]\n', adminBriefing: null },
    lastSessionInfo: { time: '2026-09-20T08:00:00Z', wasFailure: false },
    onboardingCohortBlock: '\n[ONBOARDING-COHORT RULE]\n',
    identity,
    isAnonymous: false,
    clientContext: {
      city: 'Cologne', country: 'DE', timezone: TZ, localTime: 'Friday afternoon, 15:00',
      timeOfDay: 'afternoon', device: 'Desktop', isMobile: false, lang: 'de',
    },
    greetingFirstName: safeFastGreeting ? 'Dragan' : undefined,
    greetingProactiveLine: safeFastGreeting ? 'PROACTIVE-LINE' : undefined,
    greetingIsFirstTime: safeFastGreeting ? false : undefined,
    greetingNeedsOnboarding: safeFastGreeting ? false : undefined,
    greetingHasPriorSession: safeFastGreeting ? true : undefined,
    lastFullBriefingDate: safeFastGreeting ? '2026-09-19' : undefined,
    lastDayCloseDate: safeFastGreeting ? null : undefined,
    recentNbaKeys: safeFastGreeting ? ['nba_a', 'nba_b'] : undefined,
    wakeBriefOverrideBlock: buildVertexWakeBriefBlock('A lead line for turn one.', 'en', 'wake:fixture'),
    decisionContext: { pillar_momentum: { slipping: 'sleep' } },
    wakeBriefDecisionId: 'decision-1',
  };
}

beforeEach(() => {
  __resetLiveSessionControllerForTests();
  liveSessions.clear();
  sessions.clear();
  wsClientSessions.clear();
  queryLog.length = 0;
  snapshotCalls.length = 0;
  journeyServiceMock.updateSessionEndState.mockClear();
  journeyServiceMock.ensureUserJourneyRow.mockClear();
  journeyServiceMock.getJourneyState.mockClear();
});

afterAll(() => {
  __resetLiveSessionControllerForTests();
  liveSessions.clear();
});

const SCENARIOS = [
  { name: 'inline wake, fast greeting on, tenant in JWT', fastStart: false, safeFastGreeting: true, jwtTenant: TENANT },
  { name: 'inline wake, fast greeting on, tenant resolved', fastStart: false, safeFastGreeting: true, jwtTenant: null },
  { name: 'deferred wake (fast start), fast greeting on', fastStart: true, safeFastGreeting: true, jwtTenant: TENANT },
  { name: 'inline wake, fast greeting off', fastStart: false, safeFastGreeting: false, jwtTenant: TENANT },
];

describe('VTID-04545 characterization: authenticated handleLiveSessionStart', () => {
  it.each(SCENARIOS)('$name — conversation-visible session fields', async (sc) => {
    const { session } = await runStart(sc);
    expect(session).toBeDefined();
    // The wake-brief override is built with the session lang at decision time
    // ('en' — no client lang, the stored 'de' lands via the context/greeting
    // path). Expected value computed the same way.
    expect(visible(session)).toEqual(expectedVisible(sc.jwtTenant, sc.safeFastGreeting));
  });

  it.each(SCENARIOS)('$name — response body', async (sc) => {
    const { res, payload } = await runStart(sc);
    expect(res.status).toHaveBeenCalledWith(200);
    const { session_id, conversation_id, ...rest } = payload;
    expect(session_id).toMatch(/^live-/);
    expect(conversation_id).toBeTruthy();
    expect(rest).toEqual({
      ok: true,
      meta: {
        lang: 'en',
        voice: 'voice-en',
        modalities: ['audio', 'text'],
        model: expect.any(String),
        voice_quota: sc.jwtTenant
          ? {
              tier: 'live', quota: 600, used: 10, remaining: 590, reset_at: null,
              deferred_for_vulnerability: false, paywall_action: 'allow',
            }
          : null,
        context_bootstrap: { latency_ms: null, context_chars: null, skipped_reason: null, deferred: true },
        context_status: sc.fastStart ? 'pending' : 'ready',
        wake_brief: sc.fastStart
          ? null
          : {
              decision_id: 'decision-1',
              selected_kind: 'wake_brief',
              user_facing_line: 'A lead line for turn one.',
              suppression_reason: null,
            },
      },
    });
  });

  it.each(SCENARIOS)('$name — user_journey writes are unchanged', async (sc) => {
    await runStart(sc);
    const today = todayInTimezone(new Date(), TZ);
    // fallback_used → the row is seeded exactly once with the same fields.
    expect(journeyServiceMock.ensureUserJourneyRow).toHaveBeenCalledTimes(1);
    expect(journeyServiceMock.ensureUserJourneyRow).toHaveBeenCalledWith(fakeSupabase, USER, {
      tenant_id: sc.jwtTenant || TENANT,
      started_at: '2026-08-20T00:00:00Z',
      is_first_session: false,
    });
    // last_session_date 2026-09-01 < today → daily_morning → the stamp lands.
    expect(journeyServiceMock.updateSessionEndState).toHaveBeenCalledTimes(1);
    expect(journeyServiceMock.updateSessionEndState).toHaveBeenCalledWith(fakeSupabase, USER, {
      last_session_date: today,
      clear_first_session: false,
    });
  });

  it.each(SCENARIOS)('$name — turn-1 wake snapshot blocks are unchanged', async (sc) => {
    await runStart(sc);
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0].blocks).toEqual({
      wakeBriefOverride: true,
      teacherModeContent: false,
      journeyGreeting: true,
    });
    expect(snapshotCalls[0].firstName).toEqual({ value: 'Dragan', source: 'memory_facts' });
  });

  it('first-session journey clears the first-session flag exactly as before', async () => {
    journeyServiceMock.getJourneyState.mockResolvedValueOnce({
      is_first_session: true,
      last_session_date: null,
      day_in_journey: 1,
      total_days: 90,
      current_wave: null,
      recent_greeting_openings: [],
      fallback_used: false,
      started_at: '2026-09-25T00:00:00Z',
    } as any);
    await runStart({ fastStart: false, safeFastGreeting: true, jwtTenant: TENANT });
    expect(journeyServiceMock.ensureUserJourneyRow).not.toHaveBeenCalled();
    expect(journeyServiceMock.updateSessionEndState).toHaveBeenCalledWith(fakeSupabase, USER, {
      last_session_date: todayInTimezone(new Date(), TZ),
      clear_first_session: true,
    });
    expect(snapshotCalls[0].blocks.journeyGreeting).toBe(true);
  });

  it('same-day journey writes nothing and reports no journey greeting', async () => {
    journeyServiceMock.getJourneyState.mockResolvedValueOnce({
      is_first_session: false,
      last_session_date: todayInTimezone(new Date(), TZ),
      day_in_journey: 3,
      total_days: 90,
      current_wave: null,
      recent_greeting_openings: [],
      fallback_used: false,
      started_at: '2026-09-22T00:00:00Z',
    } as any);
    await runStart({ fastStart: false, safeFastGreeting: true, jwtTenant: TENANT });
    expect(journeyServiceMock.updateSessionEndState).not.toHaveBeenCalled();
    expect(snapshotCalls[0].blocks.journeyGreeting).toBe(false);
  });

  it('quota-denied (hard_block) still answers 402 with the same body and creates no session', async () => {
    const quota = require('../../../../src/services/voice-quota-guard');
    (quota.reserveVoiceQuotaAtSessionStart as jest.Mock).mockResolvedValueOnce({
      feature: 'voice_live_minutes',
      paywall_action: 'hard_block',
      quota: 15,
      used: 15,
      remaining: 0,
      reset_at: '2026-10-01T00:00:00Z',
      start_on_standard_tier: true,
      deferred_for_vulnerability: false,
    });
    flagState.ORB_FAST_START = false;
    flagState.ORB_SAFE_FAST_GREETING = true;
    const spies = makeSpies();
    configureLiveSessionController(makeDeps(spies));
    const res = makeRes();
    await handleLiveSessionStart(
      makeReq({ user_id: USER, tenant_id: TENANT, email: null, exafy_admin: false, role: null, aud: null, exp: null, iat: null }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: 'payment_required',
      paywall: {
        feature: 'voice_live_minutes',
        tier: 'unknown',
        quota: 15,
        used: 15,
        remaining: 0,
        reset_at: '2026-10-01T00:00:00Z',
        credit_cost_per_unit: 0,
        user_credit_balance: 0,
        allowed_burn_buckets: ['purchased_credits'],
        credit_option: null,
        upgrade_url: '/api/v1/billing/checkout/subscription',
        paywall_action: 'hard_block',
      },
      vtid: 'VTID-03107',
    });
    expect(liveSessions.size).toBe(0);
    expect(spies.emitLiveSessionEvent).not.toHaveBeenCalled();
    expect(spies.buildBootstrapContextPack).not.toHaveBeenCalled();
  });

  it('quota reservation throwing still fails open to a normal 200 start', async () => {
    const quota = require('../../../../src/services/voice-quota-guard');
    (quota.reserveVoiceQuotaAtSessionStart as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    const { res, payload } = await runStart({ fastStart: false, safeFastGreeting: true, jwtTenant: TENANT });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload.meta.voice_quota).toBeNull();
  });
});

// =============================================================================
// VTID-04545 — what changed: WHEN / HOW OFTEN the start-path work runs.
// (The characterization above pins that WHAT is produced did not change.)
// =============================================================================

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('VTID-04545: session start critical path', () => {
  it('quota gate, identity resolution and client context run concurrently', async () => {
    flagState.ORB_FAST_START = false;
    flagState.ORB_SAFE_FAST_GREETING = false;
    const events: string[] = [];
    const quota = require('../../../../src/services/voice-quota-guard');
    (quota.reserveVoiceQuotaAtSessionStart as jest.Mock).mockImplementationOnce(async () => {
      events.push('quota:start');
      await delay(60);
      events.push('quota:end');
      return {
        feature: 'voice_live_minutes', paywall_action: 'allow', quota: 600, used: 10, remaining: 590,
        reset_at: null, start_on_standard_tier: false, deferred_for_vulnerability: false,
      };
    });
    const spies = makeSpies();
    const baseResolve = spies.resolveOrbIdentity.getMockImplementation()!;
    spies.resolveOrbIdentity.mockImplementation(async (req: any) => {
      events.push('identity:start');
      await delay(60);
      events.push('identity:end');
      return baseResolve(req);
    });
    const baseCtx = spies.buildClientContext.getMockImplementation()!;
    spies.buildClientContext.mockImplementation(async (req: any) => {
      events.push('ctx:start');
      await delay(60);
      events.push('ctx:end');
      return baseCtx(req);
    });
    configureLiveSessionController(makeDeps(spies));
    const t0 = Date.now();
    const res = makeRes();
    await handleLiveSessionStart(
      makeReq({ user_id: USER, tenant_id: TENANT, email: 'dragan@example.com', exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    // All three started before any of them finished.
    const firstEnd = events.findIndex((e) => e.endsWith(':end'));
    expect(events.slice(0, firstEnd).sort()).toEqual(['ctx:start', 'identity:start', 'quota:start']);
    // Serial would be >= 180 ms for these three alone.
    expect(Date.now() - t0).toBeLessThan(170);
  });

  it('shared reads run once per session start (fast greeting on)', async () => {
    const { spies, session } = await runStart({ fastStart: false, safeFastGreeting: true, jwtTenant: TENANT });
    expect(session).toBeDefined();
    expect(spies.fetchLastSessionInfo).toHaveBeenCalledTimes(1);
    expect(spies.fetchLastSessionInfo).toHaveBeenCalledWith(USER, TZ);
    expect(spies.getStoredLanguagePreference).toHaveBeenCalledTimes(1);
    expect(spies.getStoredLanguagePreference).toHaveBeenCalledWith(TENANT, USER);
    const count = (table: string) => queryLog.filter((q) => q.table === table).length;
    expect(count('memory_facts')).toBe(1);
    expect(count('app_users')).toBe(1);
    expect(count('user_journey')).toBe(1);
    expect(count('user_guided_journey_state')).toBe(1);
  });

  it('shared reads run once per session start (fast greeting off, deferred wake)', async () => {
    const { spies } = await runStart({ fastStart: true, safeFastGreeting: false, jwtTenant: TENANT });
    expect(spies.fetchLastSessionInfo).toHaveBeenCalledTimes(1);
    expect(spies.getStoredLanguagePreference).toHaveBeenCalledTimes(1);
    expect(queryLog.filter((q) => q.table === 'memory_facts')).toHaveLength(1);
    expect(queryLog.filter((q) => q.table === 'app_users')).toHaveLength(1);
  });

  it('the unused journey-greeting text is no longer built: no life_compass / foundation-snapshot reads', async () => {
    const profiler = require('../../../../src/services/user-context-profiler');
    const foundation = require('../../../../src/services/journey-foundation/journey-foundation-state');
    (profiler.fetchLifeCompass as jest.Mock).mockClear();
    (foundation.buildJourneyFoundationSnapshot as jest.Mock).mockClear();
    const { session } = await runStart({ fastStart: false, safeFastGreeting: true, jwtTenant: TENANT });
    expect(profiler.fetchLifeCompass).not.toHaveBeenCalled();
    expect(foundation.buildJourneyFoundationSnapshot).not.toHaveBeenCalled();
    expect(session.journeyGreetingBlock).toBeUndefined();
    expect(session.journeyGreetingMeta).toEqual({ kind: 'daily_morning', today_date_iso: todayInTimezone(new Date(), TZ) });
    // The write still lands with the same arguments.
    expect(journeyServiceMock.updateSessionEndState).toHaveBeenCalledWith(fakeSupabase, USER, {
      last_session_date: todayInTimezone(new Date(), TZ),
      clear_first_session: false,
    });
  });

  it('journey standing block and onboarding-cohort block are fetched in parallel, composed in the same order', async () => {
    const events: string[] = [];
    const nd = require('../../../../src/services/assistant-continuation/providers/new-day-overview-payload');
    (nd.fetchGuidedJourney as jest.Mock).mockImplementationOnce(async () => {
      events.push('journey:start');
      await delay(40);
      events.push('journey:end');
      return { fixture: true };
    });
    flagState.ORB_FAST_START = false;
    flagState.ORB_SAFE_FAST_GREETING = false;
    const spies = makeSpies();
    spies.fetchOnboardingCohortBlock.mockImplementation(async () => {
      events.push('cohort:start');
      await delay(40);
      events.push('cohort:end');
      return '\n[ONBOARDING-COHORT RULE]\n';
    });
    configureLiveSessionController(makeDeps(spies));
    const res = makeRes();
    await handleLiveSessionStart(
      makeReq({ user_id: USER, tenant_id: TENANT, email: 'dragan@example.com', exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null }),
      res,
    );
    const session: any = liveSessions.get(res.json.mock.calls[0][0].session_id);
    await session.contextReadyPromise;
    const firstEnd = events.findIndex((e) => e.endsWith(':end'));
    expect(events.slice(0, firstEnd).sort()).toEqual(['cohort:start', 'journey:start']);
    expect(session.onboardingCohortBlock).toBe('\n[ONBOARDING-COHORT RULE]\n');
    expect(visible(session).contextInstruction).toBe(expectedVisible(TENANT, false).contextInstruction);
  });

  it('a rejecting onboarding-cohort fetch still leaves the field untouched and the context intact', async () => {
    flagState.ORB_FAST_START = false;
    flagState.ORB_SAFE_FAST_GREETING = false;
    const spies = makeSpies();
    spies.fetchOnboardingCohortBlock.mockRejectedValue(new Error('rpc down'));
    configureLiveSessionController(makeDeps(spies));
    const res = makeRes();
    await handleLiveSessionStart(
      makeReq({ user_id: USER, tenant_id: TENANT, email: 'dragan@example.com', exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null }),
      res,
    );
    const session: any = liveSessions.get(res.json.mock.calls[0][0].session_id);
    await session.contextReadyPromise;
    expect('onboardingCohortBlock' in session).toBe(false);
    expect(session.contextInstruction).toBe(expectedVisible(TENANT, false).contextInstruction);
  });

  it('quota-denied with a failing identity resolver: still 402, no unhandled rejection', async () => {
    const quota = require('../../../../src/services/voice-quota-guard');
    (quota.reserveVoiceQuotaAtSessionStart as jest.Mock).mockResolvedValueOnce({
      feature: 'voice_live_minutes', paywall_action: 'paywall', quota: 15, used: 15, remaining: 0,
      reset_at: null, start_on_standard_tier: true, deferred_for_vulnerability: false,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const spies = makeSpies();
      spies.resolveOrbIdentity.mockRejectedValue(new Error('identity boom'));
      spies.buildClientContext.mockRejectedValue(new Error('geo boom'));
      configureLiveSessionController(makeDeps(spies));
      const res = makeRes();
      await handleLiveSessionStart(
        makeReq({ user_id: USER, tenant_id: TENANT, email: null, exafy_admin: false, role: null, aud: null, exp: null, iat: null }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(402);
      await flush();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('an identity resolver failure on a normal start still rejects the handler with that error', async () => {
    const spies = makeSpies();
    spies.resolveOrbIdentity.mockRejectedValue(new Error('identity boom'));
    configureLiveSessionController(makeDeps(spies));
    await expect(
      handleLiveSessionStart(
        makeReq({ user_id: USER, tenant_id: TENANT, email: null, exafy_admin: false, role: null, aud: null, exp: null, iat: null }),
        makeRes(),
      ),
    ).rejects.toThrow('identity boom');
    expect(liveSessions.size).toBe(0);
  });
});
