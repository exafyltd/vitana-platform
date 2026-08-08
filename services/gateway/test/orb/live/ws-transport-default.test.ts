/**
 * VTID-03471 (L-04/L-05) — WebSocket is the browser's default voice
 * transport, and the WS session start no longer forks from the HTTP one.
 *
 * Two invariants, both regression-prone in opposite directions:
 *
 *  1. The WS `start` frame must keep going through `handleLiveSessionStart`.
 *     The fork it replaced (VTID-01222 era) silently missed wake brief,
 *     journey guidance, guided topics, fast start, the quota gate, the
 *     re-auth signal and reconnect continuity — six features added to the
 *     HTTP path over ~7 months that nobody noticed were absent from the WS
 *     one, precisely because a second `const liveSession = {...}` looks
 *     locally complete. Rebuilding a session object inside the WS handler is
 *     how that comes back.
 *
 *  2. The widget must not lose its escape route. Making WS the default is
 *     only safe because a transport-level failure falls back to SSE and
 *     because the server can veto the default without a redeploy.
 *
 * The widget is a browser IIFE with no export surface, so its half is
 * asserted against source text (same approach as the sibling orb-widget
 * suites).
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../../src');
const ORB_LIVE = path.join(SRC, 'routes', 'orb-live.ts');
const WIDGET = path.join(SRC, 'frontend', 'command-hub', 'orb-widget.js');
const CONTROLLER = path.join(SRC, 'orb', 'live', 'session', 'live-session-controller.ts');

function functionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('WS session start is not a second implementation (VTID-03471)', () => {
  const src = fs.readFileSync(ORB_LIVE, 'utf8');
  const wsStart = functionBody(
    src,
    'async function handleWsStartMessage(clientSession: WsClientSession, message: WsClientMessage)',
  );

  it('delegates to the shared session-start controller', () => {
    expect(wsStart).toContain('startLiveSessionForWs({');
  });

  it('does not construct its own GeminiLiveSession', () => {
    // The fork's signature move. If this ever matches again, the WS path has
    // started drifting from the HTTP one a second time.
    expect(wsStart).not.toMatch(/const\s+liveSession\s*:\s*GeminiLiveSession\s*=/);
    expect(wsStart).not.toContain('liveSessions.set(');
  });

  it('does not re-read start-body fields the controller owns', () => {
    // Each of these was either hand-parsed in the fork or (worse) missing
    // from it. Reading them here again means two parsers to keep in sync.
    for (const field of [
      'message.vad_silence_ms',
      'message.conversation_summary',
      'message.voice_style',
      'guided_topic_id',
      'journey_focus_step',
      'reconnect_stage',
      'transcript_history',
    ]) {
      expect(wsStart).not.toContain(field);
    }
  });

  it('binds the socket to the controller-created session instead of minting an id', () => {
    expect(wsStart).toContain('liveSession.clientWs = clientWs;');
    expect(wsStart).toContain('const sessionId = liveSession.sessionId;');
  });

  it('keeps the WS-only greeting deferral (audio_ready) the SSE path does not use', () => {
    expect(wsStart).toContain('liveSession.greetingDeferred = true;');
  });

  it('surfaces a controller rejection to the client instead of continuing anonymously', () => {
    expect(wsStart).toContain("type: 'error'");
    expect(wsStart).toContain('startResult.status');
  });

  it('returns the controller meta (context_status, wake_brief, quota) in session_started', () => {
    expect(wsStart).toContain('...(startResult.body.meta || {})');
    expect(wsStart).toContain('conversation_id: startResult.body.conversation_id');
  });
});

describe('cleanupWsSession keys the live session by its own id (VTID-03471)', () => {
  const src = fs.readFileSync(CONTROLLER, 'utf8');
  const cleanup = functionBody(src, 'export function cleanupWsSession(sessionId: string): void');

  it('deletes from liveSessions by the live session id, not the socket id', () => {
    // Now that the two ids differ, `liveSessions.delete(sessionId)` would
    // leak the session forever.
    expect(cleanup).toContain('const liveSessionKey = ls.sessionId || sessionId;');
    expect(cleanup).toContain('liveSessions.delete(liveSessionKey);');
    expect(cleanup).not.toContain('liveSessions.delete(sessionId);');
  });

  it('scopes extraction + buffer teardown to the same key', () => {
    expect(cleanup).toContain('destroySessionBuffer(liveSessionKey)');
    expect(cleanup).toContain('clearExtractionState(liveSessionKey)');
  });
});

describe('orb widget defaults to the WebSocket transport (VTID-03471)', () => {
  const src = fs.readFileSync(WIDGET, 'utf8');

  it('compiles in `ws` as the default transport', () => {
    // The whole point of L-04/L-05: stop sending ~15.6 authenticated POSTs
    // per second of speech.
    expect(src).toMatch(/transport:\s*'ws'/);
    expect(src).not.toMatch(/transport:\s*'sse'\s*\n\s*\};/);
  });

  it('lets the operator veto the default without a redeploy', () => {
    expect(src).toContain("'/api/v1/orb/live/transport'");
    expect(src).toContain('_fetchServerTransport');
    const resolve = functionBody(src, 'function _useWsTransport()');
    expect(resolve).toContain("_serverTransport === 'sse'");
  });

  it('keeps the localStorage override winning over the server answer', () => {
    const resolve = functionBody(src, 'function _useWsTransport()');
    const lsIdx = resolve.indexOf("localStorage.getItem('vtorb.transport')");
    const serverIdx = resolve.indexOf('_serverTransport');
    expect(lsIdx).toBeGreaterThanOrEqual(0);
    expect(serverIdx).toBeGreaterThan(lsIdx);
  });

  it('falls back to SSE when a WS start fails for a transport reason', () => {
    const start = functionBody(src, 'async function _sessionStart()');
    expect(start).toContain('await _sessionStartWs(startPayload);');
    expect(start).toContain('_latchWsFallback(');
    // ...and does NOT retry on SSE when the SERVER rejected the start —
    // SSE would be rejected identically, so a retry is just a second 401.
    expect(start).toContain('if (wsErr && wsErr.__vtOrbServerRejected) throw wsErr;');
  });

  it('marks server rejections during the WS handshake so they are not retried', () => {
    const wsStart = functionBody(src, 'function _sessionStartWs(startPayload)');
    expect(wsStart).toContain("msg.type === 'error'");
    expect(wsStart).toContain('rejErr.__vtOrbServerRejected = true;');
  });

  it('latches the fallback per tab (sessionStorage), not permanently', () => {
    // A network that blocks WS upgrades is a property of where the user is,
    // not a verdict on their browser — localStorage would strand them on the
    // slow transport after they leave the hotel wifi.
    const latch = functionBody(src, 'function _latchWsFallback(reason)');
    expect(latch).toContain('sessionStorage.setItem');
    expect(latch).not.toContain('localStorage.setItem');
  });

  it('does not abandon the session when the user closed the overlay mid-start', () => {
    const start = functionBody(src, 'async function _sessionStart()');
    expect(start).toContain('if (_s._userInitiatedStop || !_s.overlayVisible) throw wsErr;');
  });
});
