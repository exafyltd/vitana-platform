/**
 * VTID-04834: exactly one `vtid.live.session.start` and one
 * `vtid.live.session.stop` per ORB WebSocket session.
 *
 * Measured on prod oasis_events (48 h to 2026-10-02, read-only):
 *   - starts: 9 with transport 'ws' + 9 with transport 'websocket' — the same
 *     9 WS sessions twice. The shared controller (handleLiveSessionStart,
 *     reached via ws-start-adapter) emitted one, and handleWsStartMessage in
 *     routes/orb-live.ts emitted a second after the upstream connected.
 *   - stops: every `ws_stop_session` stop carried the `ws-<uuid>` SOCKET id
 *     (handleWsStopSession used clientSession.sessionId), and its
 *     `liveSessions.delete(socketId)` deleted nothing — so the idle sweep
 *     reaped the still-present live session ~2 min later and booked a second
 *     stop (`idle_no_engagement`) under the live id. The sweep, the supersede
 *     path and POST /live/session/stop never checked the VTID-03561
 *     `stopEventEmitted` latch.
 */

jest.mock('../src/services/voice-quota-guard', () => ({
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
jest.mock('../src/services/oasis-event-service', () => {
  const actual = jest.requireActual('../src/services/oasis-event-service');
  return {
    ...actual,
    emitOasisEvent: jest.fn(async (e: any) => {
      (global as any).__vtid04834Events?.push({ type: e.type, payload: e.payload });
      return { ok: true };
    }),
  };
});
jest.mock('../src/services/voice-session-facts', () => {
  const actual = jest.requireActual('../src/services/voice-session-facts');
  return { ...actual, recordLiveSessionEnd: jest.fn(), recordVoiceSessionStart: jest.fn() };
});
jest.mock('../src/services/voice-self-healing-adapter', () => {
  const actual = jest.requireActual('../src/services/voice-self-healing-adapter');
  return { ...actual, dispatchVoiceFailureFireAndForget: jest.fn() };
});

import * as fs from 'fs';
import * as path from 'path';
import {
  __handleWsStopSessionForTest,
  sweepIdleLiveSessions,
} from '../src/routes/orb-live';
import {
  configureLiveSessionController,
  cleanupWsSession,
  handleLiveSessionStop,
  oasisTransportLabel,
  __resetLiveSessionControllerForTests,
  type LiveSessionControllerDeps,
} from '../src/orb/live/session/live-session-controller';
import { startLiveSessionForWs } from '../src/orb/live/session/ws-start-adapter';
import { liveSessions, wsClientSessions } from '../src/orb/live/session/live-session-registry';
import { recordLiveSessionEnd } from '../src/services/voice-session-facts';

type Ev = { type: string; payload: any };
let events: Ev[];
const recordEnd = recordLiveSessionEnd as jest.Mock;

const starts = () => events.filter((e) => e.type === 'vtid.live.session.start');
const stops = () => events.filter((e) => e.type === 'vtid.live.session.stop');

function deps(overrides: Partial<LiveSessionControllerDeps> = {}): LiveSessionControllerDeps {
  return {
    resolveOrbIdentity: async (req: any) => req.identity ?? null,
    clearResponseWatchdog: () => undefined,
    sendEndOfTurn: () => true,
    validateOrigin: () => true,
    buildClientContext: async () => ({
      city: 'test', country: 'DE', localTime: '12:00', device: 'desktop', isMobile: false, lang: 'de', timezone: 'UTC',
    } as any),
    normalizeLang: (l) => l || 'en',
    getVoiceForLang: () => 'Aoede',
    getStoredLanguagePreference: async () => null,
    persistLanguagePreference: () => undefined,
    fetchLastSessionInfo: async () => null,
    fetchOnboardingCohortBlock: async () => '',
    buildBootstrapContextPack: async () => ({
      contextInstruction: '', contextPack: undefined, latencyMs: 0, skippedReason: undefined,
    }),
    resolveEffectiveRole: async () => 'community',
    terminateExistingSessionsForUser: () => 0,
    emitLiveSessionEvent: async (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    },
    describeTimeSince: () => ({ bucket: 'first_time', wasFailure: false }),
    sendAudioToLiveAPI: () => true,
    startResponseWatchdog: () => undefined,
    emitDiag: () => undefined,
    getGoogleAuthReady: () => true,
    ...overrides,
  } as LiveSessionControllerDeps;
}

const flush = () => new Promise((r) => setImmediate(r));

function makeLive(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'live-04834',
    identity: { user_id: 'u-1', tenant_id: 't-1' },
    transcriptTurns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }],
    active: true,
    createdAt: new Date(Date.now() - 60_000),
    lastActivity: new Date(Date.now() - 30_000),
    audioInChunks: 4,
    audioInForwarded: 4,
    audioOutChunks: 9,
    videoInFrames: 0,
    turn_count: 1,
    lang: 'de',
    upstreamWs: null,
    sseResponse: null,
    clientWs: { readyState: 1, send: jest.fn(), close: jest.fn() },
    assistantProfile: { surface: 'community', role: 'community' },
    ...over,
  };
}

function bindWs(ls: any, socketId = 'ws-socket-04834'): any {
  const cs: any = { sessionId: socketId, clientWs: ls.clientWs, liveSession: ls, identity: ls.identity };
  wsClientSessions.set(socketId, cs);
  liveSessions.set(ls.sessionId, ls);
  return cs;
}

beforeEach(() => {
  events = [];
  (global as any).__vtid04834Events = events;
  recordEnd.mockClear();
  __resetLiveSessionControllerForTests();
  configureLiveSessionController(deps());
  liveSessions.clear();
  wsClientSessions.clear();
});
afterAll(() => {
  liveSessions.clear();
  wsClientSessions.clear();
  __resetLiveSessionControllerForTests();
  delete (global as any).__vtid04834Events;
});

describe('VTID-04834: one vtid.live.session.start per WS session', () => {
  it('a WS start (via the adapter) emits exactly one start, labelled websocket, with the merged fields', async () => {
    const result = await startLiveSessionForWs({
      startMessage: { type: 'start', lang: 'de', response_modalities: ['audio'] },
      identity: undefined,
      upgradeHeaders: { origin: 'https://vitanaland.com', 'user-agent': 'jest' },
    });
    await flush();
    expect(result.status).toBe(200);
    expect(starts()).toHaveLength(1);
    const p = starts()[0].payload;
    expect(p).toMatchObject({
      session_id: result.body.session_id,
      transport: 'websocket',
      lang: 'de',
      modalities: ['audio'],
      response_modalities: ['audio'],
      voice: 'Aoede',
      authenticated: false,
      origin: 'https://vitanaland.com',
      user_agent: 'jest',
    });
    // Fields that only the deleted WS emit used to carry.
    expect(typeof p.nova_voice).toBe('string');
    expect(typeof p.nova_language_supported).toBe('boolean');
    expect(typeof p.live_api_voice).toBe('string');
    expect(p.context_bootstrap).toMatchObject({
      included: false,
      skipped_reason: 'anonymous_session',
      memory_hits: 0,
      knowledge_hits: 0,
      tools_enabled: false,
    });
  });

  it('an SSE start keeps transport sse', async () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    const { handleLiveSessionStart } = require('../src/orb/live/session/live-session-controller');
    await handleLiveSessionStart({ identity: undefined, headers: {}, body: { lang: 'en' }, query: {} } as any, res);
    await flush();
    expect(starts()).toHaveLength(1);
    expect(starts()[0].payload.transport).toBe('sse');
  });

  it('orb-live.ts has no start emit of its own; the controller has exactly one', () => {
    const orbLive = fs.readFileSync(path.join(__dirname, '../src/routes/orb-live.ts'), 'utf8');
    const controller = fs.readFileSync(
      path.join(__dirname, '../src/orb/live/session/live-session-controller.ts'),
      'utf8',
    );
    expect(orbLive).not.toMatch(/emitLiveSessionEvent\(\s*'vtid\.live\.session\.start'/);
    expect(controller.match(/emitLiveSessionEvent\(\s*'vtid\.live\.session\.start'/g) ?? []).toHaveLength(1);
  });

  it('canonical OASIS transport vocabulary is websocket | sse', () => {
    expect(oasisTransportLabel('ws')).toBe('websocket');
    expect(oasisTransportLabel('websocket')).toBe('websocket');
    expect(oasisTransportLabel('sse')).toBe('sse');
    expect(oasisTransportLabel(undefined)).toBe('sse');
  });
});

describe('VTID-04834: one vtid.live.session.stop per WS session', () => {
  it('stop_session frame reports the LIVE id (not the ws- socket id) and removes the live session', () => {
    const ls = makeLive();
    const cs = bindWs(ls);
    __handleWsStopSessionForTest(cs);

    expect(stops()).toHaveLength(1);
    expect(stops()[0].payload).toMatchObject({
      session_id: 'live-04834',
      transport: 'websocket',
      reason: 'ws_stop_session',
      user_id: 'u-1',
    });
    expect(recordEnd).toHaveBeenCalledTimes(1);
    expect(recordEnd).toHaveBeenCalledWith(ls, 'live-04834', 'ws_stop_session');
    expect(liveSessions.has('live-04834')).toBe(false); // was left behind before
  });

  it('stop_session then socket close then idle sweep then POST stop: still exactly one stop (the prod sequence)', async () => {
    const ls = makeLive();
    const cs = bindWs(ls);
    __handleWsStopSessionForTest(cs);
    cleanupWsSession('ws-socket-04834', 'client_disconnect');
    // Even if the session had lingered in the map (the old bug), the sweep
    // must not book it again.
    liveSessions.set('live-04834', ls);
    sweepIdleLiveSessions(Date.now() + 60 * 60 * 1000);
    liveSessions.set('live-04834', ls);
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    await handleLiveSessionStop({ body: { session_id: 'live-04834' }, headers: {}, identity: undefined } as any, res);
    await flush();

    expect(stops()).toHaveLength(1);
    expect(recordEnd).toHaveBeenCalledTimes(1);
  });

  it('socket close alone emits one stop (cleanupWsSession), and a later sweep adds none', () => {
    const ls = makeLive();
    bindWs(ls);
    cleanupWsSession('ws-socket-04834', 'client_disconnect');
    liveSessions.set('live-04834', ls);
    sweepIdleLiveSessions(Date.now() + 60 * 60 * 1000);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].payload).toMatchObject({ session_id: 'live-04834', reason: 'client_disconnect' });
  });

  it('the idle sweep still reports a session nobody reported, exactly once', () => {
    const ls = makeLive({ sessionId: 'live-idle', turn_count: 0, audioInChunks: 0 });
    liveSessions.set('live-idle', ls);
    sweepIdleLiveSessions(Date.now() + 60 * 60 * 1000);
    sweepIdleLiveSessions(Date.now() + 60 * 60 * 1000);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].payload).toMatchObject({ session_id: 'live-idle', transport: 'websocket' });
    expect(liveSessions.has('live-idle')).toBe(false);
  });

  it('POST /live/session/stop reports transport and does not re-report a latched session', async () => {
    const ls = makeLive({ clientWs: null });
    liveSessions.set('live-04834', ls);
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    await handleLiveSessionStop({ body: { session_id: 'live-04834' }, headers: {}, identity: undefined } as any, res);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].payload).toMatchObject({ transport: 'sse', reason: 'client_stop' });

    const ls2 = makeLive({ sessionId: 'live-latched', stopEventEmitted: true });
    liveSessions.set('live-latched', ls2);
    await handleLiveSessionStop({ body: { session_id: 'live-latched' }, headers: {}, identity: undefined } as any, res);
    expect(stops()).toHaveLength(1);
    expect(recordEnd).toHaveBeenCalledTimes(1);
  });
});
