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
  __resetLiveSessionControllerForTests,
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

  it('calls configureLiveSessionController exactly once at module init with the three deps', () => {
    const calls = source.match(/configureLiveSessionController\s*\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(source).toMatch(/resolveOrbIdentity\s*,/);
    expect(source).toMatch(/clearResponseWatchdog\s*,/);
    expect(source).toMatch(/sendEndOfTurn\s*,?\s*\}\)/);
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
    // Anti-regression: no inline `liveSessions.get(` inside this slice.
    expect(handlerSlice).not.toMatch(/liveSessions\.get\(/);
  });
});
