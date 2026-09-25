/**
 * VTID-04542 — ORB latency P0 wiring (measurement only).
 *
 * Behavioural (real controller code):
 *   - SSE audio that passes every drop gate starts the per-turn latency
 *     tracker through the same helper the WS path uses; dropped audio does
 *     not.
 *   - POST /live/session/start records its step timing and the latency
 *     context (entry / surface / authenticated) on the session — for the
 *     SSE route and the WS adapter alike (both call this handler).
 *
 * Source contracts on routes/orb-live.ts (the route file is too large and
 * stateful to boot here — same approach as the establishment-latency
 * characterization suite):
 *   - greeting_dispatched is marked AFTER the awaited facts / gather / ledger
 *     waits and right after the real send, on both the safe-fast and the
 *     ladder paths;
 *   - the turn-0 tracker gets its context right after construction and its
 *     provider/meta right before finalize, on both transports;
 *   - the per-turn provider label no longer defaults to vertex/<stale>;
 *   - SSE gets startVoiceTurnLatency through the controller deps;
 *   - hand-off timing and prewarm outcome hooks are in place.
 */

jest.mock('../../../../src/services/voice-quota-guard', () => ({
  reserveVoiceQuotaAtSessionStart: jest.fn(async () => ({
    feature: 'voice_live_minutes',
    paywall_action: 'allow',
    quota: 600,
    used: 0,
    remaining: 600,
    reset_at: null,
    start_on_standard_tier: false,
    deferred_for_vulnerability: false,
  })),
  recordVoiceMinute: jest.fn(async () => 0),
  triggerDowngrade: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  configureLiveSessionController,
  handleLiveSessionStart,
  handleLiveStreamSend,
  __resetLiveSessionControllerForTests,
  type LiveSessionControllerDeps,
} from '../../../../src/orb/live/session/live-session-controller';
import { liveSessions } from '../../../../src/orb/live/session/live-session-registry';
import { startLiveSessionForWs } from '../../../../src/orb/live/session/ws-start-adapter';

const WS_OPEN = 1;

function baseDeps(overrides: Partial<LiveSessionControllerDeps> = {}): LiveSessionControllerDeps {
  return {
    resolveOrbIdentity: async () => null,
    clearResponseWatchdog: () => undefined,
    sendEndOfTurn: () => true,
    validateOrigin: () => true,
    buildClientContext: async () => ({
      city: 'test', country: 'US', localTime: '12:00', device: 'desktop',
      isMobile: false, lang: 'en', timezone: 'UTC',
    } as any),
    normalizeLang: (l) => l || 'en',
    getVoiceForLang: () => 'Aoede',
    getStoredLanguagePreference: async () => null,
    persistLanguagePreference: () => undefined,
    fetchLastSessionInfo: async () => null,
    fetchOnboardingCohortBlock: async () => '',
    buildBootstrapContextPack: async () => ({} as any),
    resolveEffectiveRole: async () => 'community',
    terminateExistingSessionsForUser: () => 0,
    emitLiveSessionEvent: async () => undefined,
    describeTimeSince: () => ({ bucket: 'first_time', wasFailure: false }),
    sendAudioToLiveAPI: () => true,
    startResponseWatchdog: () => undefined,
    emitDiag: () => undefined,
    getGoogleAuthReady: () => true,
    ...overrides,
  };
}

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeSession(overrides: Partial<any> = {}): any {
  return {
    sessionId: 's-send',
    active: true,
    isAnonymous: false,
    isModelSpeaking: false,
    navigationDispatched: false,
    turnCompleteAt: 0,
    audioInChunks: 0,
    audioInForwarded: 0,
    videoInFrames: 0,
    turn_count: 0,
    transportHasShownLife: true,
    modelRespondedThisTurn: true,
    lastActivity: new Date(),
    lastTelemetryEmitTime: 0,
    lastAudioForwardedTime: 0,
    upstreamWs: { readyState: WS_OPEN },
    sseResponse: null,
    outputTranscriptBuffer: '',
    transcriptTurns: [],
    identity: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetLiveSessionControllerForTests();
  liveSessions.clear();
});
afterAll(() => {
  __resetLiveSessionControllerForTests();
  liveSessions.clear();
});

describe('VTID-04542 SSE per-turn latency tracking', () => {
  it('a forwarded SSE audio chunk starts the per-turn tracker (the WS helper, via deps)', async () => {
    const startVoiceTurnLatency = jest.fn();
    configureLiveSessionController(baseDeps({ startVoiceTurnLatency }));
    const session = makeSession();
    liveSessions.set('s1', session);
    const res = makeRes();
    await handleLiveStreamSend({ query: { session_id: 's1' }, body: { type: 'audio', data_b64: 'AAAA' } } as any, res);
    expect(startVoiceTurnLatency).toHaveBeenCalledTimes(1);
    expect(startVoiceTurnLatency).toHaveBeenCalledWith(session);
    expect(session.audioInForwarded).toBe(1);
  });

  it('audio dropped while the model speaks does not start a turn', async () => {
    const startVoiceTurnLatency = jest.fn();
    configureLiveSessionController(baseDeps({ startVoiceTurnLatency }));
    liveSessions.set('s1', makeSession({ isModelSpeaking: true }));
    await handleLiveStreamSend({ query: { session_id: 's1' }, body: { type: 'audio', data_b64: 'AAAA' } } as any, makeRes());
    expect(startVoiceTurnLatency).not.toHaveBeenCalled();
  });

  it('a throwing tracker never breaks the audio forward', async () => {
    const send = jest.fn(() => true);
    configureLiveSessionController(baseDeps({
      sendAudioToLiveAPI: send,
      startVoiceTurnLatency: () => { throw new Error('telemetry boom'); },
    }));
    liveSessions.set('s1', makeSession());
    const res = makeRes();
    await handleLiveStreamSend({ query: { session_id: 's1' }, body: { type: 'audio', data_b64: 'AAAA' } } as any, res);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('deps without startVoiceTurnLatency (older wiring) still forward audio', async () => {
    const send = jest.fn(() => true);
    configureLiveSessionController(baseDeps({ sendAudioToLiveAPI: send }));
    liveSessions.set('s1', makeSession());
    await handleLiveStreamSend({ query: { session_id: 's1' }, body: { type: 'audio', data_b64: 'AAAA' } } as any, makeRes());
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('VTID-04542 session-start timing + latency context', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';

  it('SSE route: records steps + total, and derives entry from headers', async () => {
    configureLiveSessionController(baseDeps());
    const res = makeRes();
    await handleLiveSessionStart({
      identity: undefined,
      headers: { origin: 'https://vitanaland.com', 'user-agent': IPHONE },
      body: { current_route: '/home' },
      query: {},
    } as any, res);
    const sessionId = res.json.mock.calls[0][0].session_id;
    const session: any = liveSessions.get(sessionId);
    expect(session.sessionStartTiming).toBeDefined();
    expect(session.sessionStartTiming.total_ms).toBeGreaterThanOrEqual(0);
    const steps = session.sessionStartTiming.steps.map((s: any) => s.step);
    expect(steps).toEqual(expect.arrayContaining(['resolve_identity', 'build_client_context', 'context_kickoff']));
    // anonymous: no quota gate ran
    expect(steps).not.toContain('quota_gate');
    for (const st of session.sessionStartTiming.steps) {
      expect(st.ms).toBeGreaterThanOrEqual(0);
      expect(st.offset_ms).toBeGreaterThanOrEqual(0);
    }
    expect(session.latencyContext).toEqual(expect.objectContaining({
      entry: 'mobile',
      authenticated: false,
    }));
    expect(typeof session.latencyContext.surface).toBe('string');
  });

  it('WS adapter: the same timing/context lands on the session (command hub origin)', async () => {
    configureLiveSessionController(baseDeps());
    const result = await startLiveSessionForWs({
      startMessage: { type: 'start', lang: 'en' },
      upgradeHeaders: { origin: 'https://gateway.vitanaland.com', 'user-agent': 'Mozilla/5.0 (Macintosh)' },
    });
    expect(result.status).toBe(200);
    const session: any = liveSessions.get(result.body.session_id as string);
    expect(session.latencyContext.entry).toBe('command_hub');
    expect(session.sessionStartTiming.steps.length).toBeGreaterThan(0);
  });

  it('the start response body is unchanged by the instrumentation', async () => {
    configureLiveSessionController(baseDeps());
    const res = makeRes();
    await handleLiveSessionStart({ headers: {}, body: {}, query: {} } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['conversation_id', 'meta', 'ok', 'session_id']);
    expect(payload.meta).not.toHaveProperty('session_start');
  });
});

describe('VTID-04542 orb-live.ts wiring (source contracts)', () => {
  let src: string;
  let handlerSrc: string;
  beforeAll(() => {
    src = fs.readFileSync(path.resolve(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
    handlerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/orb/live/session/upstream-message-handler.ts'),
      'utf8',
    );
  });

  function greetingFn(): string {
    const start = src.indexOf('function sendGreetingPromptToLiveAPI(');
    const end = src.indexOf('function sendGuidedTopicNarrationAudioBridge(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  // VTID-04544 made the greeting reads concurrent (gatherSafeFastGreetingPayloads /
  // gatherNewdayGreetingPayload); the wait marks now ride on the gather and
  // ledger callbacks (timeBoundedGreetingRead / withLedgerWaitMark), so they
  // are written when each read settles — still before the send.
  it('safe-fast path: facts mark, then the concurrent gather (gather+ledger marks), THEN the send, THEN greeting_dispatched', () => {
    const fn = greetingFn();
    const facts = fn.indexOf("mark('greeting_facts_awaited', { ..._factsProbeSF(), path: 'safe_fast' })");
    const gatherCall = fn.indexOf('await gatherSafeFastGreetingPayloads({');
    const gatherMark = fn.indexOf("mark('greeting_gather_awaited', { kind, ...w, path: 'safe_fast' })");
    const ledgerMark = fn.indexOf("mark('greeting_ledger_awaited', { ...w, path: 'safe_fast' })");
    const send = fn.indexOf('client_content: { turns: [{ role: \'user\', parts: [{ text: _sfDecision.directive }] }], turn_complete: true }');
    const dispatched = fn.indexOf("path: 'safe_fast',\n              });");
    for (const i of [facts, gatherCall, gatherMark, ledgerMark, send, dispatched]) expect(i).toBeGreaterThan(-1);
    expect(gatherCall).toBeGreaterThan(facts);
    expect(gatherMark).toBeGreaterThan(gatherCall);
    expect(ledgerMark).toBeGreaterThan(gatherMark);
    expect(send).toBeGreaterThan(ledgerMark);
    expect(dispatched).toBeGreaterThan(send);
    expect(fn.slice(gatherCall, send)).toContain('timeBoundedGreetingRead(');
    expect(fn.slice(gatherCall, send)).toContain('withLedgerWaitMark(');
  });

  it('ladder path: every render goes through _renderSync, which marks dispatch right after ws.send', () => {
    const fn = greetingFn();
    const render = fn.indexOf('const _renderSync = (decision');
    const send = fn.indexOf('ws.send(_greetingClientContentMsg);', render);
    const dispatched = fn.indexOf('markGreetingDispatched(session, {', send);
    expect(render).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(render);
    expect(dispatched).toBeGreaterThan(send);
    expect(fn.slice(send, dispatched)).not.toMatch(/await /);
    // The async new-day ladder awaits facts, then the concurrent gather + ledger, before rendering.
    const factsNS = fn.indexOf("mark('greeting_facts_awaited', { ..._factsProbeNS(), path: 'ladder' })");
    const gatherCallNS = fn.indexOf('await gatherNewdayGreetingPayload({');
    const gatherNS = fn.indexOf("mark('greeting_gather_awaited', { kind, ...w, path: 'ladder' })");
    const ledgerNS = fn.indexOf("mark('greeting_ledger_awaited', { ...w, path: 'ladder' })");
    const renderNS = fn.indexOf('_renderSync(_decisionNS);');
    expect(gatherCallNS).toBeGreaterThan(factsNS);
    expect(gatherNS).toBeGreaterThan(gatherCallNS);
    expect(ledgerNS).toBeGreaterThan(gatherNS);
    expect(renderNS).toBeGreaterThan(ledgerNS);
  });

  it('the awaited races are unchanged in bound: the same env budgets are still raced', () => {
    const fn = greetingFn();
    expect((fn.match(/ORB_GREETING_FACTS_WAIT_MS \|\| 700/g) || []).length).toBeGreaterThanOrEqual(3);
    expect((fn.match(/ORB_NEWDAY_OVERVIEW_WAIT_MS \|\| 3000/g) || []).length).toBe(2);
    expect((fn.match(/ORB_RESUME_OVERVIEW_WAIT_MS \|\| 1800/g) || []).length).toBe(1);
    expect((fn.match(/startSpeculativeGreetingLedgerRead\(\{[^}]*\}, 800\)/g) || []).length).toBe(2);
  });

  it('greeting_sent stays marked before the greeting function is entered (dashboards)', () => {
    expect(src).toMatch(/establishLatency\?\.mark\('greeting_sent'/);
  });

  it('turn-0 tracker: context attached right after construction, on both transports', () => {
    const sse = src.indexOf("transport: 'sse',\n    });\n    // VTID-04542");
    const ws = src.indexOf("transport: 'websocket',\n    });\n    // VTID-04542");
    expect(sse).toBeGreaterThan(-1);
    expect(ws).toBeGreaterThan(-1);
    expect(src.slice(sse, sse + 200)).toMatch(/attachEstablishLatencyContext\(session\)/);
    expect(src.slice(ws, ws + 200)).toMatch(/attachEstablishLatencyContext\(liveSession\)/);
  });

  it('turn-0 tracker: provider/meta prepared right before the first-audio finalize, on both transports', () => {
    const marks = [...src.matchAll(/establishLatency\.mark\('audio_out_first_chunk', \{ source: 'greeting' \}\)/g)];
    expect(marks.length).toBe(2);
    for (const m of marks) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
      expect(before).toMatch(/prepareEstablishLatencyFinalize\((session|liveSession)\);\s*(session|liveSession)\.$/);
    }
    // The Nova-only correction is gone (it left cascade labelled vertex/…).
    expect(src).not.toMatch(/establishLatency\.setProvider\(`nova_sonic\//);
  });

  it('per-turn provider label comes from the shared resolver, not vertex/<stale constant>', () => {
    const fn = src.slice(src.indexOf('function startVoiceTurnLatency('), src.indexOf('function markVoiceLatency('));
    expect(fn).toMatch(/const provider = resolveLatencyProviderLabel\(session\);/);
    expect(fn).not.toMatch(/`vertex\/\$\{GEMINI_MODEL\}`/);
  });

  it('SSE: orb-live passes startVoiceTurnLatency into the controller deps', () => {
    const cfg = src.slice(src.indexOf('configureLiveSessionController({'));
    const block = cfg.slice(0, cfg.indexOf('});'));
    expect(block).toMatch(/\bstartVoiceTurnLatency,/);
  });

  it('hand-off timing: request at every swap site, drain in the handler, connect in the reconnect, first audio on the shared mark', () => {
    expect((src.match(/notePersonaSwapRequested\(session, /g) || []).length).toBe(3);
    expect((handlerSrc.match(/notePersonaSwapDrained\(session, 'reconnect'\)/g) || []).length).toBe(2);
    expect(handlerSrc).toMatch(/notePersonaSwapDrained\(session, 'in_process'\)/);
    const rec = src.slice(src.indexOf('async function attemptTransparentReconnect('));
    expect(rec).toMatch(/if \(isPersonaSwap\) notePersonaSwapConnectStarted\(session\);/);
    expect(rec).toMatch(/if \(isPersonaSwap\) notePersonaSwapConnected\(session\);/);
    const mark = src.slice(src.indexOf('function markVoiceLatency('), src.indexOf('function finalizeVoiceTurnLatency('));
    expect(mark).toMatch(/notePersonaSwapFirstAudio\(session, resolveLatencyProviderLabel\(session\)\)/);
  });

  it('prewarm outcome: claimed / missed diag with a reason, after the claim decision', () => {
    const claim = src.indexOf('const reusedWarmNova = !!prewarmedNova;');
    expect(src.slice(claim, claim + 400)).toMatch(
      /emitNovaPrewarmOutcome\(session, \{ claimedAt: prewarmedNova\?\.createdAt \?\? null, workSurface: isWorkSurface\(sessionSurface\), personaIsVitana: _prewarmPersonaIsVitana \}\)/,
    );
    const fn = src.slice(src.indexOf('function emitNovaPrewarmOutcome('), src.indexOf('function markVoiceLatency('));
    expect(fn).toMatch(/emitDiag\(session, 'nova_prewarm_claimed'/);
    expect(fn).toMatch(/emitDiag\(session, 'nova_prewarm_missed'/);
    expect(fn).toMatch(/'work_surface'/);
    expect(fn).toMatch(/'persona'/);
    expect(fn).toMatch(/describePrewarmMiss\(userId\)/);
    expect(fn).toMatch(/latencyContext\.prewarm_claimed = claimed/);
  });
});
