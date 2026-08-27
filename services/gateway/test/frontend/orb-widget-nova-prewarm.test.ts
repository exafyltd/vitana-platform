import * as fs from 'fs';
import * as path from 'path';

// VTID-03779 — session pre-establishment ("warm start"). The widget opens
// the WS transport (and asks the gateway to warm a real Nova Sonic
// connection on it) right after login, before the ORB overlay is ever
// shown; when the user later taps ORB, _sessionStartWs reuses that
// already-open, already-prewarmed socket instead of paying a fresh
// connect. Mirrors the static-analysis style of
// orb-widget-auth-reactive.test.ts — the widget runs in the browser with no
// export surface, so these assert on source rather than executing it.

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

function extractFunctionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('VTID-03779 orb-widget Nova session prewarm', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('_prewarmNovaWs is a no-op for anonymous callers, an already-active session, or an already-warm socket', () => {
    const body = extractFunctionBody(source, 'function _prewarmNovaWs()');
    expect(body).toMatch(/if \(!_cfg\.token\) return;/);
    expect(body).toMatch(/if \(_s\.active \|\| _s\.ws\) return;/);
    expect(body).toMatch(/if \(_s\._prewarmWsInFlight\) return;/);
    expect(body).toMatch(/if \(_s\.prewarmWs && _s\.prewarmWs\.readyState === 1\) return;/);
  });

  it('_prewarmNovaWs only marks the socket ready — and sends the prewarm message — after the server\'s connected handshake', () => {
    const body = extractFunctionBody(source, 'function _prewarmNovaWs()');
    expect(body).toMatch(/msg\.type === 'connected'/);
    const connectedBranch = body.match(/if \(msg\.type === 'connected'\) \{[\s\S]*?\n\s*\}/)?.[0];
    expect(connectedBranch).toBeDefined();
    expect(connectedBranch).toMatch(/w\.send\(JSON\.stringify\(\{ type: 'prewarm' \}\)\)/);
    expect(connectedBranch).toMatch(/_s\.prewarmWsReady = true/);
    // Never sent before 'connected' — the whole point is reusing an already
    // upgraded, already-authenticated socket, not a bare freshly-opened one.
    const beforeConnected = body.slice(0, body.indexOf("msg.type === 'connected'"));
    expect(beforeConnected).not.toContain("type: 'prewarm'");
  });

  it('a closed/errored prewarm socket clears its own bookkeeping so a later attempt is not blocked forever', () => {
    const body = extractFunctionBody(source, 'function _prewarmNovaWs()');
    expect(body).toMatch(/w\.onclose = drop;/);
    expect(body).toMatch(/w\.onerror = drop;/);
    const dropFn = extractFunctionBody(body, 'function drop()');
    expect(dropFn).toMatch(/_s\.prewarmWs = null/);
    expect(dropFn).toMatch(/_s\.prewarmWsReady = false/);
  });

  it('an identity switch mid-handshake can never let the OLD identity\'s socket be claimed as the prewarm result', () => {
    const body = extractFunctionBody(source, 'function _prewarmNovaWs()');
    expect(body).toMatch(/var myGen = _s\._prewarmWsGen;/);
    expect(body).toMatch(/function stale\(\) \{ return _s\._prewarmWsGen !== myGen; \}/);
    // The onmessage handler must check staleness before ever touching
    // _s.prewarmWs / sending 'prewarm' on the old identity's behalf.
    const onmessageIdx = body.indexOf('w.onmessage = function');
    const staleCheckIdx = body.indexOf('if (stale())', onmessageIdx);
    const connectedIdx = body.indexOf("msg.type === 'connected'", onmessageIdx);
    expect(staleCheckIdx).toBeGreaterThan(onmessageIdx);
    expect(staleCheckIdx).toBeLessThan(connectedIdx);
  });

  it('_wipeIdentityBoundState bumps the prewarm generation and closes/clears any existing prewarmed socket', () => {
    const body = extractFunctionBody(source, 'function _wipeIdentityBoundState()');
    expect(body).toMatch(/_s\._prewarmWsGen = \(_s\._prewarmWsGen \|\| 0\) \+ 1;/);
    expect(body).toMatch(/_s\.prewarmWs\.close\(\);/);
    expect(body).toMatch(/_s\.prewarmWs = null;/);
    expect(body).toMatch(/_s\.prewarmWsReady = false;/);
    expect(body).toMatch(/_s\._prewarmWsInFlight = false;/);
  });

  it('_prewarmNovaWs is invoked from both init() and setAuth() — the same lifecycle points as the existing bootstrap prewarm', () => {
    // init() calls it alongside _prewarmBootstrap()/_fetchServerTransport().
    const initIdx = source.indexOf("console.log('[VTOrb] Initialized");
    const initWindow = source.slice(Math.max(0, initIdx - 600), initIdx);
    expect(initWindow).toMatch(/_prewarmBootstrap\(\);/);
    expect(initWindow).toMatch(/_prewarmNovaWs\(\);/);

    // setAuth() calls it after the existing bootstrap prewarm.
    const setAuthBody = extractFunctionBody(source, 'setAuth: function (token)');
    expect(setAuthBody).toMatch(/_prewarmBootstrap\(\);/);
  });

  it('_sessionStartWs reuses an open, ready prewarmed socket instead of opening a fresh one', () => {
    const body = extractFunctionBody(source, 'function _sessionStartWs(startPayload)');
    expect(body).toMatch(
      /var reused = !!\(_s\.prewarmWs && _s\.prewarmWsReady && _s\.prewarmWs\.readyState === 1\);/,
    );
    expect(body).toMatch(/if \(reused\) \{\s*\n\s*w = _s\.prewarmWs;/);
    // Claiming (reused or not) must always clear the prewarm slot, so a
    // later prewarm attempt never mistakes a now-owned socket for a
    // still-available candidate.
    expect(body).toMatch(/if \(_s\.prewarmWs === w\) \{ _s\.prewarmWs = null; _s\.prewarmWsReady = false; \}/);
  });

  it('a reused socket sends start immediately instead of waiting for a connected message that will never arrive again', () => {
    const body = extractFunctionBody(source, 'function _sessionStartWs(startPayload)');
    const tail = body.slice(body.lastIndexOf('w.onerror = function'));
    expect(tail).toMatch(/if \(reused\) \{/);
    expect(tail).toMatch(/w\.send\(JSON\.stringify\(Object\.assign\(\{ type: 'start' \}, startPayload\)\)\)/);
  });

  it('the fresh-connect path is untouched: a non-reused socket still opens a new WebSocket and waits for connected before sending start', () => {
    const body = extractFunctionBody(source, 'function _sessionStartWs(startPayload)');
    expect(body).toMatch(/} else \{\s*\n\s*var url = _cfg\.gw\.replace\(\/\^http\/, 'ws'\)/);
    // The pre-existing 'connected' → send('start') path must still exist
    // verbatim for the non-reused branch.
    expect(body).toMatch(/if \(msg\.type === 'connected'\) \{/);
  });
});
