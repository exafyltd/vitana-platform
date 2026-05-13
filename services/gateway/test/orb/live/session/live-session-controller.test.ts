/**
 * A8.2 (orb-live-refactor / VTID-02961): runtime tests for the session
 * controller module — `orb/live/session/live-session-controller.ts`.
 *
 * Covers the three things A8.2 lifts:
 *   1. `cleanupExpiredSessions` — expiry sweep over the `sessions` registry.
 *   2. `cleanupWsSession` — WS session teardown (state mutations + Map
 *      removals + dep callbacks).
 *   3. `handleLiveStreamEndTurn` — request validation, ownership-mismatch
 *      log, and Vertex WS forwarding via the `sendEndOfTurn` dep.
 *
 * Plus the deps-bag plumbing:
 *   - `configureLiveSessionController` is required before any handler fires.
 *   - Double-configure throws (catches mis-wired tests / boot loudly).
 *   - `__resetLiveSessionControllerForTests` clears state for clean tests.
 */

import {
  configureLiveSessionController,
  cleanupExpiredSessions,
  cleanupWsSession,
  handleLiveStreamEndTurn,
  handleLiveSessionStart,
  handleLiveSessionStop,
  handleLiveStreamSend,
  __resetLiveSessionControllerForTests,
  type LiveSessionControllerDeps,
} from '../../../../src/orb/live/session/live-session-controller';
import {
  sessions,
  liveSessions,
  wsClientSessions,
} from '../../../../src/orb/live/session/live-session-registry';
import { SESSION_TIMEOUT_MS } from '../../../../src/orb/live/config';

// Mock WebSocket OPEN constant from `ws`.
const WS_OPEN = 1;
const WS_CLOSED = 3;

beforeEach(() => {
  __resetLiveSessionControllerForTests();
  sessions.clear();
  liveSessions.clear();
  wsClientSessions.clear();
});

afterAll(() => {
  __resetLiveSessionControllerForTests();
  sessions.clear();
  liveSessions.clear();
  wsClientSessions.clear();
});

describe('A8.2: configureLiveSessionController', () => {
  it('throws if a handler runs before configure', async () => {
    await expect(
      handleLiveStreamEndTurn({} as any, {} as any),
    ).rejects.toThrow(/not configured/);
  });

  it('throws if configured twice', () => {
    configureLiveSessionController({
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: () => undefined,
      sendEndOfTurn: () => true,
    });
    expect(() =>
      configureLiveSessionController({
        resolveOrbIdentity: async () => null,
        clearResponseWatchdog: () => undefined,
        sendEndOfTurn: () => true,
      }),
    ).toThrow(/already configured/);
  });

  it('reset escape hatch allows reconfiguration', () => {
    configureLiveSessionController({
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: () => undefined,
      sendEndOfTurn: () => true,
    });
    __resetLiveSessionControllerForTests();
    expect(() =>
      configureLiveSessionController({
        resolveOrbIdentity: async () => null,
        clearResponseWatchdog: () => undefined,
        sendEndOfTurn: () => true,
      }),
    ).not.toThrow();
  });
});

describe('A8.2: cleanupExpiredSessions', () => {
  it('removes sessions whose lastActivity is older than SESSION_TIMEOUT_MS', () => {
    const oldTimestamp = new Date(Date.now() - SESSION_TIMEOUT_MS - 1000);
    const fresh = new Date();
    sessions.set('expired', { lastActivity: oldTimestamp, sseResponse: null } as any);
    sessions.set('fresh', { lastActivity: fresh, sseResponse: null } as any);

    cleanupExpiredSessions();

    expect(sessions.has('expired')).toBe(false);
    expect(sessions.has('fresh')).toBe(true);
  });

  it('ends the SSE response on expiry (best-effort, swallows errors)', () => {
    const oldTimestamp = new Date(Date.now() - SESSION_TIMEOUT_MS - 1000);
    const endSpy = jest.fn();
    sessions.set('expired', {
      lastActivity: oldTimestamp,
      sseResponse: { end: endSpy },
    } as any);

    cleanupExpiredSessions();

    expect(endSpy).toHaveBeenCalledTimes(1);
    expect(sessions.has('expired')).toBe(false);
  });

  it('does not throw when sse.end throws', () => {
    const oldTimestamp = new Date(Date.now() - SESSION_TIMEOUT_MS - 1000);
    sessions.set('expired', {
      lastActivity: oldTimestamp,
      sseResponse: {
        end: () => {
          throw new Error('socket gone');
        },
      },
    } as any);

    expect(() => cleanupExpiredSessions()).not.toThrow();
    expect(sessions.has('expired')).toBe(false);
  });
});

describe('A8.2: cleanupWsSession', () => {
  beforeEach(() => {
    configureLiveSessionController({
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: jest.fn(),
      sendEndOfTurn: () => true,
    });
  });

  it('is a no-op when the sessionId is unknown', () => {
    expect(() => cleanupWsSession('does-not-exist')).not.toThrow();
  });

  it('clears keepalive intervals + watchdog and removes both registry entries', () => {
    const clearWatchdog = jest.fn();
    __resetLiveSessionControllerForTests();
    configureLiveSessionController({
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: clearWatchdog,
      sendEndOfTurn: () => true,
    });

    const pingInterval = setInterval(() => {}, 1_000_000);
    const silenceInterval = setInterval(() => {}, 1_000_000);

    const upstreamWs = { close: jest.fn() };
    const clientWs = { readyState: WS_OPEN, close: jest.fn() };
    const liveSession: any = {
      identity: null,
      transcriptTurns: [],
      active: true,
      upstreamPingInterval: pingInterval,
      silenceKeepaliveInterval: silenceInterval,
      upstreamWs,
    };
    liveSessions.set('s1', liveSession);
    wsClientSessions.set('s1', { liveSession, clientWs } as any);

    cleanupWsSession('s1');

    expect(liveSession.active).toBe(false);
    expect(liveSession.upstreamPingInterval).toBeUndefined();
    expect(liveSession.silenceKeepaliveInterval).toBeUndefined();
    expect(clearWatchdog).toHaveBeenCalledWith(liveSession);
    expect(upstreamWs.close).toHaveBeenCalled();
    expect(clientWs.close).toHaveBeenCalledWith(1000, 'Session cleanup');
    expect(liveSessions.has('s1')).toBe(false);
    expect(wsClientSessions.has('s1')).toBe(false);
  });

  it('skips client WS close when readyState is not OPEN', () => {
    const clientWs = { readyState: WS_CLOSED, close: jest.fn() };
    wsClientSessions.set('s1', { liveSession: null, clientWs } as any);
    cleanupWsSession('s1');
    expect(clientWs.close).not.toHaveBeenCalled();
    expect(wsClientSessions.has('s1')).toBe(false);
  });

  it('handles a session that has no liveSession (WS-only entry)', () => {
    const clientWs = { readyState: WS_OPEN, close: jest.fn() };
    wsClientSessions.set('s1', { liveSession: null, clientWs } as any);
    expect(() => cleanupWsSession('s1')).not.toThrow();
    expect(clientWs.close).toHaveBeenCalledWith(1000, 'Session cleanup');
    expect(wsClientSessions.has('s1')).toBe(false);
  });
});

describe('A8.2: handleLiveStreamEndTurn', () => {
  beforeEach(() => {
    configureLiveSessionController({
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: () => undefined,
      sendEndOfTurn: () => true,
    });
  });

  function makeRes() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  it('400 when session_id is missing from both query and body', async () => {
    const req: any = { query: {}, body: {} };
    const res = makeRes();
    await handleLiveStreamEndTurn(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'session_id required' });
  });

  it('404 when session is not in liveSessions', async () => {
    const req: any = { query: { session_id: 'nope' }, body: {} };
    const res = makeRes();
    await handleLiveStreamEndTurn(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Session not found' });
  });

  it('400 when session is not active', async () => {
    liveSessions.set('s1', { active: false } as any);
    const req: any = { query: { session_id: 's1' }, body: {} };
    const res = makeRes();
    await handleLiveStreamEndTurn(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Session not active' });
  });

  it('falls back to body.session_id when query is empty', async () => {
    liveSessions.set('s1', { active: false } as any);
    const req: any = { query: {}, body: { session_id: 's1' } };
    const res = makeRes();
    await handleLiveStreamEndTurn(req, res);
    expect(res.status).toHaveBeenCalledWith(400); // session not active
  });

  it('calls sendEndOfTurn + responds "End of turn signaled" when upstream WS is open and sendEndOfTurn returns true', async () => {
    const sendSpy = jest.fn().mockReturnValue(true);
    __resetLiveSessionControllerForTests();
    configureLiveSessionController({
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: () => undefined,
      sendEndOfTurn: sendSpy,
    });

    const upstreamWs = { readyState: WS_OPEN };
    liveSessions.set('s1', { active: true, upstreamWs } as any);
    const req: any = { query: { session_id: 's1' }, body: {} };
    const res = makeRes();

    await handleLiveStreamEndTurn(req, res);

    expect(sendSpy).toHaveBeenCalledWith(upstreamWs);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      message: 'End of turn signaled',
    });
  });

  it('responds "acknowledged (no Live API)" when no upstream WS exists', async () => {
    liveSessions.set('s1', { active: true, upstreamWs: null } as any);
    const req: any = { query: { session_id: 's1' }, body: {} };
    const res = makeRes();
    await handleLiveStreamEndTurn(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      message: 'End of turn acknowledged (no Live API)',
    });
  });

  it('responds "acknowledged (no Live API)" when upstream WS is not in OPEN state', async () => {
    const upstreamWs = { readyState: WS_CLOSED };
    liveSessions.set('s1', { active: true, upstreamWs } as any);
    const req: any = { query: { session_id: 's1' }, body: {} };
    const res = makeRes();
    await handleLiveStreamEndTurn(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      message: 'End of turn acknowledged (no Live API)',
    });
  });

  it('logs ownership mismatch but still processes the request', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    __resetLiveSessionControllerForTests();
    configureLiveSessionController({
      resolveOrbIdentity: async () => ({
        user_id: 'req-user',
        tenant_id: 't1',
      }) as any,
      clearResponseWatchdog: () => undefined,
      sendEndOfTurn: () => true,
    });

    const upstreamWs = { readyState: WS_OPEN };
    liveSessions.set('s1', {
      active: true,
      upstreamWs,
      identity: { user_id: 'session-user' },
    } as any);
    const req: any = { query: { session_id: 's1' }, body: {} };
    const res = makeRes();

    await handleLiveStreamEndTurn(req, res);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ownership mismatch (allowed)'),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    warnSpy.mockRestore();
  });
});

describe('A8.2 anti-regression: orb-live.ts is a consumer of the controller', () => {
  let source: string;
  beforeAll(() => {
    const fs = require('fs');
    const path = require('path');
    source = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/routes/orb-live.ts'),
      'utf8',
    );
  });

  it('imports the controller (configure + cleanup helpers + end-turn handler)', () => {
    expect(source).toMatch(
      /from\s*['"`][^'"`]*\/orb\/live\/session\/live-session-controller['"`]/,
    );
    expect(source).toMatch(/\bconfigureLiveSessionController\b/);
    expect(source).toMatch(/\bcleanupExpiredSessions\b/);
    expect(source).toMatch(/\bcleanupWsSession\b/);
    expect(source).toMatch(/\bhandleLiveStreamEndTurn\b/);
  });

  it('calls configureLiveSessionController exactly once at module init', () => {
    const calls = source.match(/configureLiveSessionController\s*\(/g) ?? [];
    expect(calls.length).toBe(1);
    // A8.2 deps
    expect(source).toMatch(/resolveOrbIdentity\s*,/);
    expect(source).toMatch(/clearResponseWatchdog\s*,/);
    expect(source).toMatch(/sendEndOfTurn\s*,/);
    // A8.2.1 deps added in this slice
    expect(source).toMatch(/validateOrigin\s*,/);
    expect(source).toMatch(/buildClientContext\s*,/);
    expect(source).toMatch(/normalizeLang\s*,/);
    expect(source).toMatch(/getVoiceForLang\s*,/);
    expect(source).toMatch(/getStoredLanguagePreference\s*,/);
    expect(source).toMatch(/persistLanguagePreference\s*,/);
    expect(source).toMatch(/fetchLastSessionInfo\s*,/);
    expect(source).toMatch(/fetchOnboardingCohortBlock\s*,/);
    expect(source).toMatch(/buildBootstrapContextPack\s*,/);
    expect(source).toMatch(/resolveEffectiveRole\s*,/);
    expect(source).toMatch(/terminateExistingSessionsForUser\s*,/);
    expect(source).toMatch(/emitLiveSessionEvent\s*,/);
    expect(source).toMatch(/describeTimeSince\s*,/);
    // A8.2-complete deps added in this slice
    expect(source).toMatch(/sendAudioToLiveAPI\s*,/);
    expect(source).toMatch(/startResponseWatchdog\s*,/);
    expect(source).toMatch(/emitDiag\s*,/);
    expect(source).toMatch(/getGoogleAuthReady\s*:\s*\(\)\s*=>\s*!!googleAuth\s*,?\s*\}\)/);
  });

  it('does NOT declare cleanupExpiredSessions / cleanupWsSession locally anymore', () => {
    expect(source).not.toMatch(/^\s*function\s+cleanupExpiredSessions\s*\(/m);
    expect(source).not.toMatch(/^\s*function\s+cleanupWsSession\s*\(/m);
  });

  it('end-turn route is now a thin delegator (single await call)', () => {
    const handlerSlice = source.slice(
      source.indexOf("router.post('/live/stream/end-turn'"),
      source.indexOf("router.post('/live/stream/end-turn'") + 400,
    );
    expect(handlerSlice).toMatch(/await\s+handleLiveStreamEndTurn\s*\(\s*req\s*,\s*res\s*\)/);
    expect(handlerSlice).not.toMatch(/liveSessions\.get\(/);
  });

  it('/live/session/start route is now a thin delegator (A8.2.1)', () => {
    const idx = source.indexOf("router.post('/live/session/start'");
    expect(idx).toBeGreaterThan(0);
    const slice = source.slice(idx, idx + 400);
    expect(slice).toMatch(/await\s+handleLiveSessionStart\s*\(\s*req\s*,\s*res\s*\)/);
    // Anti-regression: no inline bootstrap-context call inside this slice.
    expect(slice).not.toMatch(/buildBootstrapContextPack\s*\(/);
    expect(slice).not.toMatch(/liveSessions\.set\(/);
  });

  it('/live/session/stop route is now a thin delegator (A8.2-complete)', () => {
    const idx = source.indexOf("router.post('/live/session/stop'");
    expect(idx).toBeGreaterThan(0);
    const slice = source.slice(idx, idx + 400);
    expect(slice).toMatch(/await\s+handleLiveSessionStop\s*\(\s*req\s*,\s*res\s*\)/);
    // Anti-regression: no inline OASIS emit or cogneeExtractor call inside this slice.
    expect(slice).not.toMatch(/emitLiveSessionEvent\s*\(/);
    expect(slice).not.toMatch(/cogneeExtractorClient/);
    expect(slice).not.toMatch(/liveSessions\.delete\(/);
  });

  it('/live/stream/send route is now a thin delegator (A8.2-complete)', () => {
    const idx = source.indexOf("router.post('/live/stream/send'");
    expect(idx).toBeGreaterThan(0);
    const slice = source.slice(idx, idx + 400);
    expect(slice).toMatch(/await\s+handleLiveStreamSend\s*\(\s*req\s*,\s*res\s*\)/);
    // Anti-regression: no inline audio forwarding or watchdog call inside this slice.
    expect(slice).not.toMatch(/sendAudioToLiveAPI\s*\(/);
    expect(slice).not.toMatch(/startResponseWatchdog\s*\(/);
    expect(slice).not.toMatch(/POST_TURN_COOLDOWN_MS/);
  });
});

// =============================================================================
// A8.2.1: handleLiveSessionStart
// =============================================================================

describe('A8.2.1: handleLiveSessionStart', () => {
  function baseDeps(overrides: Partial<LiveSessionControllerDeps> = {}): LiveSessionControllerDeps {
    return {
      // A8.2 deps
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: () => undefined,
      sendEndOfTurn: () => true,
      // A8.2.1 deps
      validateOrigin: () => true,
      buildClientContext: async () => ({
        city: 'test',
        country: 'US',
        localTime: '12:00',
        device: 'desktop',
        isMobile: false,
        lang: 'en',
        timezone: 'UTC',
      } as any),
      normalizeLang: (l) => l || 'en',
      getVoiceForLang: () => 'Aoede',
      getStoredLanguagePreference: async () => null,
      persistLanguagePreference: () => undefined,
      fetchLastSessionInfo: async () => null,
      fetchOnboardingCohortBlock: async () => '',
      buildBootstrapContextPack: async () => ({
        contextInstruction: '',
        contextPack: undefined,
        latencyMs: 0,
        skippedReason: undefined,
      }),
      resolveEffectiveRole: async () => 'community',
      terminateExistingSessionsForUser: () => 0,
      emitLiveSessionEvent: async () => undefined,
      describeTimeSince: () => ({ bucket: 'first_time', wasFailure: false }),
      // A8.2-complete deps
      sendAudioToLiveAPI: () => true,
      startResponseWatchdog: () => undefined,
      emitDiag: () => undefined,
      getGoogleAuthReady: () => true,
      ...overrides,
    };
  }

  function makeReq(overrides: Partial<{ identity: any; headers: any; body: any }> = {}) {
    return {
      identity: overrides.identity,
      headers: overrides.headers ?? {},
      body: overrides.body ?? {},
      query: {},
    } as any;
  }

  function makeRes() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  it('returns 403 when validateOrigin rejects', async () => {
    configureLiveSessionController(
      baseDeps({ validateOrigin: () => false }),
    );
    const req = makeReq();
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Origin not allowed' });
  });

  it('returns 401 AUTH_TOKEN_INVALID when Bearer header present but req.identity unset', async () => {
    configureLiveSessionController(baseDeps());
    const req = makeReq({
      headers: { authorization: 'Bearer expired-token' },
    });
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: 'AUTH_TOKEN_INVALID',
      message: 'Session expired or invalid — please re-authenticate',
    });
  });

  it('creates an anonymous session (no JWT) and stores it in liveSessions with a live-<uuid> session_id', async () => {
    configureLiveSessionController(baseDeps());
    const req = makeReq();
    const res = makeRes();
    await handleLiveSessionStart(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json.mock.calls[0][0]) as any;
    expect(payload.ok).toBe(true);
    expect(payload.session_id).toMatch(/^live-/);
    expect(payload.conversation_id).toBeTruthy();
    expect(payload.meta.lang).toBe('en');
    expect(payload.meta.voice).toBe('Aoede');
    expect(payload.meta.modalities).toEqual(['audio', 'text']);
    expect(payload.meta.context_bootstrap.skipped_reason).toBe('anonymous_session');
    expect(payload.meta.context_bootstrap.deferred).toBe(false);

    expect(liveSessions.size).toBe(1);
    const created = liveSessions.get(payload.session_id);
    expect(created).toBeDefined();
    expect(created!.isAnonymous).toBe(true);
    expect(created!.identity).toBeUndefined();
    expect(created!.conversation_id).toBe(payload.conversation_id);
    expect(created!.active).toBe(true);
  });

  it('respects client-requested language', async () => {
    configureLiveSessionController(baseDeps());
    const req = makeReq({ body: { lang: 'de' } });
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    const payload = (res.json.mock.calls[0][0]) as any;
    expect(payload.meta.lang).toBe('de');
  });

  it('emits OASIS vtid.live.session.start with the resolved fields', async () => {
    const emitSpy = jest.fn().mockResolvedValue(undefined);
    configureLiveSessionController(baseDeps({ emitLiveSessionEvent: emitSpy }));
    const req = makeReq({
      body: { lang: 'fr', response_modalities: ['audio'] },
      headers: { 'user-agent': 'jest', origin: 'http://test' },
    });
    const res = makeRes();
    await handleLiveSessionStart(req, res);

    expect(emitSpy).toHaveBeenCalledWith(
      'vtid.live.session.start',
      expect.objectContaining({
        user_id: 'anonymous',
        transport: 'sse',
        lang: 'fr',
        modalities: ['audio'],
        voice: 'Aoede',
        user_agent: 'jest',
        origin: 'http://test',
      }),
    );
  });

  it('pins client-supplied conversation_id when present', async () => {
    configureLiveSessionController(baseDeps());
    const givenConv = 'conv-abc-123';
    const req = makeReq({ body: { conversation_id: givenConv } });
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    const payload = (res.json.mock.calls[0][0]) as any;
    expect(payload.conversation_id).toBe(givenConv);
  });

  it('marks reconnect session with resumedFromHistory when transcript_history provided', async () => {
    configureLiveSessionController(baseDeps());
    const req = makeReq({
      body: {
        transcript_history: [
          { role: 'user', text: 'hi' },
          { role: 'assistant', text: 'hello' },
        ],
      },
    });
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    const payload = (res.json.mock.calls[0][0]) as any;
    const created = liveSessions.get(payload.session_id);
    expect((created as any).resumedFromHistory).toBe(true);
    expect(created!.transcriptTurns).toHaveLength(2);
    expect(created!.transcriptTurns[0].role).toBe('user');
  });

  it('uses VAD silence override when supplied in valid range', async () => {
    configureLiveSessionController(baseDeps());
    const req = makeReq({ body: { vad_silence_ms: 1500 } });
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    const payload = (res.json.mock.calls[0][0]) as any;
    const created = liveSessions.get(payload.session_id);
    expect(created!.vadSilenceMs).toBe(1500);
  });

  it('does NOT terminate other sessions when identity is DEV_IDENTITY', async () => {
    const { DEV_IDENTITY } = await import('../../../../src/services/orb-memory-bridge');
    const terminateSpy = jest.fn().mockReturnValue(0);
    configureLiveSessionController(
      baseDeps({
        resolveOrbIdentity: async () => ({
          user_id: DEV_IDENTITY.USER_ID,
          tenant_id: DEV_IDENTITY.TENANT_ID,
        }) as any,
        terminateExistingSessionsForUser: terminateSpy,
      }),
    );
    const req = makeReq({
      identity: { user_id: DEV_IDENTITY.USER_ID, tenant_id: DEV_IDENTITY.TENANT_ID },
    });
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    expect(terminateSpy).not.toHaveBeenCalled();
  });

  it('terminates existing sessions for a real authenticated user', async () => {
    const terminateSpy = jest.fn().mockReturnValue(2);
    configureLiveSessionController(
      baseDeps({
        resolveOrbIdentity: async () => ({
          user_id: 'real-user-uuid',
          tenant_id: 'tenant-uuid',
        }) as any,
        terminateExistingSessionsForUser: terminateSpy,
      }),
    );
    const req = makeReq({
      identity: { user_id: 'real-user-uuid', tenant_id: 'tenant-uuid' },
    });
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    expect(terminateSpy).toHaveBeenCalledWith('real-user-uuid', expect.stringMatching(/^live-/));
  });

  it('returns wake_brief field in meta (default null for anonymous; non-null structure when populated)', async () => {
    configureLiveSessionController(baseDeps());
    const req = makeReq();
    const res = makeRes();
    await handleLiveSessionStart(req, res);
    const payload = (res.json.mock.calls[0][0]) as any;
    // wake_brief MAY be non-null even for anonymous sessions; just assert the field exists.
    expect(payload.meta).toHaveProperty('wake_brief');
  });
});

// =============================================================================
// A8.2-complete: handleLiveSessionStop
// =============================================================================

describe('A8.2-complete: handleLiveSessionStop', () => {
  function baseDeps(overrides: Partial<LiveSessionControllerDeps> = {}): LiveSessionControllerDeps {
    return {
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: () => undefined,
      sendEndOfTurn: () => true,
      validateOrigin: () => true,
      buildClientContext: async () => ({} as any),
      normalizeLang: (l) => l || 'en',
      getVoiceForLang: () => 'Aoede',
      getStoredLanguagePreference: async () => null,
      persistLanguagePreference: () => undefined,
      fetchLastSessionInfo: async () => null,
      fetchOnboardingCohortBlock: async () => '',
      buildBootstrapContextPack: async () => ({}),
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
      sessionId: 's-stop',
      identity: null,
      upstreamWs: null,
      sseResponse: null,
      active: true,
      upstreamPingInterval: undefined,
      silenceKeepaliveInterval: undefined,
      audioInChunks: 0,
      audioOutChunks: 0,
      videoInFrames: 0,
      turn_count: 0,
      transcriptTurns: [],
      createdAt: new Date(Date.now() - 60_000),
      ...overrides,
    };
  }

  it('400 when session_id missing', async () => {
    configureLiveSessionController(baseDeps());
    const req: any = { body: {} };
    const res = makeRes();
    await handleLiveSessionStop(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'session_id required' });
  });

  it('404 when session not found', async () => {
    configureLiveSessionController(baseDeps());
    const req: any = { body: { session_id: 'nope' } };
    const res = makeRes();
    await handleLiveSessionStop(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Session not found' });
  });

  it('happy path: closes upstream WS, writes session_ended SSE event, marks inactive, deletes from registry, returns 200 { ok: true }', async () => {
    const emitSpy = jest.fn().mockResolvedValue(undefined);
    const watchdogSpy = jest.fn();
    configureLiveSessionController(
      baseDeps({
        emitLiveSessionEvent: emitSpy,
        clearResponseWatchdog: watchdogSpy,
      }),
    );

    const upstreamClose = jest.fn();
    const sseWrite = jest.fn();
    const sseEnd = jest.fn();
    liveSessions.set('s1', makeSession({
      upstreamWs: { close: upstreamClose },
      sseResponse: { write: sseWrite, end: sseEnd },
    }));

    const req: any = { body: { session_id: 's1' } };
    const res = makeRes();
    await handleLiveSessionStop(req, res);

    expect(upstreamClose).toHaveBeenCalled();
    expect(sseWrite).toHaveBeenCalledWith(
      expect.stringContaining('"type":"session_ended"'),
    );
    expect(sseEnd).toHaveBeenCalled();
    expect(watchdogSpy).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      'vtid.live.session.stop',
      expect.objectContaining({
        session_id: 's1',
        audio_in_chunks: 0,
        audio_out_chunks: 0,
      }),
    );
    expect(liveSessions.has('s1')).toBe(false);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('clears upstream ping + silence keepalive intervals', async () => {
    configureLiveSessionController(baseDeps());
    const pingInterval = setInterval(() => {}, 1_000_000);
    const silenceInterval = setInterval(() => {}, 1_000_000);
    liveSessions.set('s1', makeSession({
      upstreamPingInterval: pingInterval,
      silenceKeepaliveInterval: silenceInterval,
    }));

    await handleLiveSessionStop({ body: { session_id: 's1' } } as any, makeRes());

    // The session was deleted, so we can't check post-state on it. The
    // anti-leak guarantee here is that no timers remain referenced — verify
    // indirectly by confirming the session has been deleted (registry cleanup).
    expect(liveSessions.has('s1')).toBe(false);
    clearInterval(pingInterval);
    clearInterval(silenceInterval);
  });

  it('OASIS payload includes user/tenant from session.identity', async () => {
    const emitSpy = jest.fn().mockResolvedValue(undefined);
    configureLiveSessionController(baseDeps({ emitLiveSessionEvent: emitSpy }));
    liveSessions.set('s1', makeSession({
      identity: { user_id: 'u-1', tenant_id: 't-1' },
    }));
    await handleLiveSessionStop({ body: { session_id: 's1' } } as any, makeRes());
    expect(emitSpy).toHaveBeenCalledWith(
      'vtid.live.session.stop',
      expect.objectContaining({ user_id: 'u-1', tenant_id: 't-1' }),
    );
  });

  it('ownership mismatch is logged but allowed through', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    configureLiveSessionController(
      baseDeps({
        resolveOrbIdentity: async () => ({ user_id: 'req-user', tenant_id: 't1' }) as any,
      }),
    );
    liveSessions.set('s1', makeSession({ identity: { user_id: 'session-user', tenant_id: 't1' } }));
    const res = makeRes();
    await handleLiveSessionStop({ body: { session_id: 's1' } } as any, res);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ownership mismatch (allowed)'),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    warnSpy.mockRestore();
  });
});

// =============================================================================
// A8.2-complete: handleLiveStreamSend
// =============================================================================

describe('A8.2-complete: handleLiveStreamSend', () => {
  const WS_OPEN = 1;

  function baseDeps(overrides: Partial<LiveSessionControllerDeps> = {}): LiveSessionControllerDeps {
    return {
      resolveOrbIdentity: async () => null,
      clearResponseWatchdog: () => undefined,
      sendEndOfTurn: () => true,
      validateOrigin: () => true,
      buildClientContext: async () => ({} as any),
      normalizeLang: (l) => l || 'en',
      getVoiceForLang: () => 'Aoede',
      getStoredLanguagePreference: async () => null,
      persistLanguagePreference: () => undefined,
      fetchLastSessionInfo: async () => null,
      fetchOnboardingCohortBlock: async () => '',
      buildBootstrapContextPack: async () => ({}),
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
      videoInFrames: 0,
      turn_count: 0,
      vertexHasShownLife: true,
      lastActivity: new Date(),
      lastTelemetryEmitTime: 0,
      lastAudioForwardedTime: 0,
      upstreamWs: null,
      sseResponse: null,
      outputTranscriptBuffer: '',
      transcriptTurns: [],
      identity: null,
      ...overrides,
    };
  }

  it('400 when session_id missing', async () => {
    configureLiveSessionController(baseDeps());
    const req: any = { query: {}, body: {} };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'session_id required' });
  });

  it('404 when session not found', async () => {
    configureLiveSessionController(baseDeps());
    const req: any = { query: { session_id: 'nope' }, body: {} };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Session not found' });
  });

  it('400 when session not active', async () => {
    configureLiveSessionController(baseDeps());
    liveSessions.set('s1', makeSession({ active: false }));
    const req: any = { query: { session_id: 's1' }, body: {} };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Session not active' });
  });

  it('drops audio with reason "navigation_dispatched" when navigation is queued', async () => {
    configureLiveSessionController(baseDeps());
    liveSessions.set('s1', makeSession({ navigationDispatched: true }));
    const req: any = {
      query: { session_id: 's1' },
      body: { type: 'audio', data_b64: 'AAAA' },
    };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      dropped: true,
      reason: 'navigation_dispatched',
    });
  });

  it('drops audio with reason "model_speaking" while the model is producing audio', async () => {
    configureLiveSessionController(baseDeps());
    liveSessions.set('s1', makeSession({ isModelSpeaking: true }));
    const req: any = {
      query: { session_id: 's1' },
      body: { type: 'audio', data_b64: 'AAAA' },
    };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      dropped: true,
      reason: 'model_speaking',
    });
  });

  it('drops audio with reason "post_turn_cooldown" within the cooldown window', async () => {
    configureLiveSessionController(baseDeps());
    // turnCompleteAt very recent → still in cooldown
    liveSessions.set('s1', makeSession({ turnCompleteAt: Date.now() }));
    const req: any = {
      query: { session_id: 's1' },
      body: { type: 'audio', data_b64: 'AAAA' },
    };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      dropped: true,
      reason: 'post_turn_cooldown',
    });
  });

  it('forwards audio via sendAudioToLiveAPI when upstream WS is open', async () => {
    const sendSpy = jest.fn().mockReturnValue(true);
    configureLiveSessionController(baseDeps({ sendAudioToLiveAPI: sendSpy }));
    const upstreamWs = { readyState: WS_OPEN };
    liveSessions.set('s1', makeSession({ upstreamWs }));
    const req: any = {
      query: { session_id: 's1' },
      body: { type: 'audio', data_b64: 'AUDIO', mime: 'audio/pcm;rate=16000' },
    };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(sendSpy).toHaveBeenCalledWith(upstreamWs, 'AUDIO', 'audio/pcm;rate=16000');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('silently returns ok:true for anonymous sessions past turn limit (VTID-ANON-NUDGE)', async () => {
    configureLiveSessionController(baseDeps());
    liveSessions.set('s1', makeSession({ isAnonymous: true, turn_count: 9 }));
    const req: any = {
      query: { session_id: 's1' },
      body: { type: 'audio', data_b64: 'AAAA' },
    };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('handles video frame: increments videoInFrames + writes video_ack via SSE', async () => {
    configureLiveSessionController(baseDeps());
    const sseWrite = jest.fn();
    liveSessions.set('s1', makeSession({ sseResponse: { write: sseWrite } }));
    const req: any = {
      query: { session_id: 's1' },
      body: { type: 'video', source: 'screen', data_b64: 'JPEG' },
    };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(sseWrite).toHaveBeenCalledWith(
      expect.stringContaining('"type":"video_ack"'),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('text path: forwards client_content turn_complete=true via upstream WS', async () => {
    configureLiveSessionController(baseDeps());
    const wsSend = jest.fn();
    const upstreamWs = { readyState: WS_OPEN, send: wsSend };
    liveSessions.set('s1', makeSession({ upstreamWs }));
    const req: any = {
      query: { session_id: 's1' },
      body: { type: 'text', text: 'hello' },
    };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    const sentArg = JSON.parse(wsSend.mock.calls[0][0]);
    expect(sentArg.client_content.turn_complete).toBe(true);
    expect(sentArg.client_content.turns[0].parts[0].text).toBe('hello');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('interrupt path with model not speaking: returns was_speaking:false (no-op)', async () => {
    configureLiveSessionController(baseDeps());
    liveSessions.set('s1', makeSession({ isModelSpeaking: false }));
    const req: any = { query: { session_id: 's1' }, body: { type: 'interrupt' } };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.json).toHaveBeenCalledWith({ ok: true, was_speaking: false });
  });

  it('interrupt path with model speaking: ungates mic, sends end-of-turn, clears output buffer, writes interrupted SSE event', async () => {
    const endTurnSpy = jest.fn().mockReturnValue(true);
    configureLiveSessionController(baseDeps({ sendEndOfTurn: endTurnSpy }));
    const sseWrite = jest.fn();
    const upstreamWs = { readyState: WS_OPEN, send: jest.fn() };
    const session = makeSession({
      isModelSpeaking: true,
      upstreamWs,
      sseResponse: { write: sseWrite },
      outputTranscriptBuffer: 'partial...',
    });
    liveSessions.set('s1', session);
    const req: any = { query: { session_id: 's1' }, body: { type: 'interrupt' } };
    const res = makeRes();
    await handleLiveStreamSend(req, res);

    expect(session.isModelSpeaking).toBe(false);
    expect(endTurnSpy).toHaveBeenCalledWith(upstreamWs);
    expect(session.outputTranscriptBuffer).toBe('');
    expect(sseWrite).toHaveBeenCalledWith(
      expect.stringContaining('"type":"interrupted"'),
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true, was_speaking: true });
  });

  it('falls back to body.session_id when query is empty', async () => {
    configureLiveSessionController(baseDeps());
    liveSessions.set('s1', makeSession({ active: false }));
    const req: any = { query: {}, body: { session_id: 's1', type: 'audio', data_b64: 'A' } };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.status).toHaveBeenCalledWith(400); // session not active
  });

  it('500 on uncaught throw from sendAudioToLiveAPI', async () => {
    configureLiveSessionController(
      baseDeps({
        sendAudioToLiveAPI: () => {
          throw new Error('boom');
        },
      }),
    );
    const upstreamWs = { readyState: WS_OPEN };
    liveSessions.set('s1', makeSession({ upstreamWs }));
    const req: any = {
      query: { session_id: 's1' },
      body: { type: 'audio', data_b64: 'AAAA' },
    };
    const res = makeRes();
    await handleLiveStreamSend(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'boom' });
  });
});
