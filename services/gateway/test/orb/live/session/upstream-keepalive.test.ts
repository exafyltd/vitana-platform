/**
 * VTID-03234 (report finding #3) — upstream keepalive tests.
 *
 * Locks the regression the report asked for: after connect, BOTH
 * `upstreamPingInterval` and `silenceKeepaliveInterval` must be armed, and a
 * quiet pause must produce a silence frame (so Vertex doesn't idle-close).
 */

import {
  armUpstreamKeepalive,
  clearUpstreamKeepalive,
  type KeepaliveSession,
} from '../../../../src/orb/live/session/upstream-keepalive';

const WS_OPEN = 1; // WebSocket.OPEN

function makeWs(readyState = WS_OPEN) {
  return { readyState, ping: jest.fn() } as any;
}

function makeSession(over: Partial<KeepaliveSession> = {}): KeepaliveSession {
  return { sessionId: 's1', active: true, ...over };
}

describe('armUpstreamKeepalive', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('arms BOTH ping and silence keepalive intervals after connect', () => {
    const ws = makeWs();
    const session = makeSession();
    armUpstreamKeepalive(ws, session, { sendAudioToLiveAPI: jest.fn(() => true) });
    expect(session.upstreamPingInterval).toBeDefined();
    expect(session.silenceKeepaliveInterval).toBeDefined();
  });

  it('pings the upstream WS on the ping cadence', () => {
    const ws = makeWs();
    const session = makeSession();
    armUpstreamKeepalive(ws, session, { sendAudioToLiveAPI: jest.fn(() => true), pingIntervalMs: 25_000 });
    jest.advanceTimersByTime(25_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(25_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
  });

  it('feeds a silence frame during a quiet pause (idle past threshold, model not speaking)', () => {
    const ws = makeWs();
    const send = jest.fn(() => true);
    // lastAudioForwardedTime well in the past → idle exceeds the 3s threshold.
    const session = makeSession({ lastAudioForwardedTime: Date.now() - 10_000, isModelSpeaking: false });
    armUpstreamKeepalive(ws, session, { sendAudioToLiveAPI: send });
    jest.advanceTimersByTime(3_000);
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls[0][2]).toBe('audio/pcm;rate=16000');
  });

  it('does NOT feed silence while the model is speaking', () => {
    const ws = makeWs();
    const send = jest.fn(() => true);
    const session = makeSession({ lastAudioForwardedTime: Date.now() - 10_000, isModelSpeaking: true });
    armUpstreamKeepalive(ws, session, { sendAudioToLiveAPI: send });
    jest.advanceTimersByTime(6_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT ping or feed silence once the socket is closed', () => {
    const ws = makeWs(3 /* CLOSED */);
    const send = jest.fn(() => true);
    const session = makeSession({ lastAudioForwardedTime: Date.now() - 10_000 });
    armUpstreamKeepalive(ws, session, { sendAudioToLiveAPI: send, pingIntervalMs: 25_000 });
    jest.advanceTimersByTime(25_000);
    expect(ws.ping).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('is idempotent — re-arming clears the previous timers (no leak/double-fire)', () => {
    const ws = makeWs();
    const session = makeSession();
    armUpstreamKeepalive(ws, session, { sendAudioToLiveAPI: jest.fn(() => true), pingIntervalMs: 25_000 });
    const firstPing = session.upstreamPingInterval;
    armUpstreamKeepalive(ws, session, { sendAudioToLiveAPI: jest.fn(() => true), pingIntervalMs: 25_000 });
    expect(session.upstreamPingInterval).not.toBe(firstPing);
    jest.advanceTimersByTime(25_000);
    expect(ws.ping).toHaveBeenCalledTimes(1); // only the live interval fires, not the cleared one
  });

  it('clearUpstreamKeepalive removes both intervals', () => {
    const ws = makeWs();
    const session = makeSession();
    armUpstreamKeepalive(ws, session, { sendAudioToLiveAPI: jest.fn(() => true) });
    clearUpstreamKeepalive(session);
    expect(session.upstreamPingInterval).toBeUndefined();
    expect(session.silenceKeepaliveInterval).toBeUndefined();
  });
});
