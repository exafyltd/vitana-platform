import * as fs from 'fs';
import * as path from 'path';

// VTID-03727 — _attemptReconnect() must not announce "reconnecting" before
// the user has ever heard anything.
//
// Live report (staging, right after VTID-03724 shipped): "the session now
// starts speaking, but before it starts talking, the orb screen shows a
// disconnection screen: 'One moment, I will reconnect.' ... Why did you put
// that in front of starting the session?"
//
// _attemptReconnect() is the widget's generic reconnect loop — fired from
// every WS/SSE close handler in this file, including a nova_validation-
// driven close that happens before turn 1 has ever played (turn_count still
// 0, greetingComplete still false). Unlike _announceDisconnect() (which
// picks a per-reason label from _DISCONNECT_LABELS and, per VTID-03685,
// already knows how to stay quiet about a failure nothing has been heard
// yet to break) and the server-side resendGreetingIfStuckAtZeroTurns retry
// cue (also VTID-03685's "hasHeardNothingYet" pattern),
// _attemptReconnect() showed the 'reconnecting' caption unconditionally.
//
// Fix: gate the caption on a dedicated _s._audioEverHeardThisOpen flag —
// before anything has played, show 'connecting' (the same honest label
// _show() uses for the very first attempt); once real audio has played, a
// genuine reconnect cue is correct and unchanged.
//
// Codex review fix (P2): the FIRST version of this fix gated directly on
// _s.greetingComplete — but that flag is deliberately reset to false on
// every reconnect (VTID-01988, mic-restart), so a SECOND consecutive retry
// within the same overlay open would misreport 'connecting' even though the
// user genuinely heard Vitana speak earlier. _audioEverHeardThisOpen is set
// once true (alongside greetingComplete, at the same call site) and only
// cleared by _hide() — never by any reconnect path — so it survives however
// many retries happen within one overlay open.
//
// Static source check (same approach as the sibling orb-widget suites): the
// widget is a plain browser IIFE with no export surface.

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

describe('orb-widget _attemptReconnect status cue (VTID-03727)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'function _attemptReconnect()');

  it('does not show the reconnecting caption unconditionally', () => {
    // The old regression: a bare, unconditional call.
    expect(body).not.toMatch(/_setStatus\(_caption\('reconnecting'\)\);/);
  });

  it('picks the caption based on a dedicated flag, not greetingComplete directly', () => {
    expect(body).toMatch(
      /_setStatus\(_caption\(_s\._audioEverHeardThisOpen \? 'reconnecting' : 'connecting'\)\);/,
    );
    // Regression lock for the Codex-flagged bug: greetingComplete alone is
    // wrong here because it gets reset on every reconnect.
    expect(body).not.toMatch(/_setStatus\(_caption\(_s\.greetingComplete \?/);
  });

  it('still shows a caption every time (never silently skips the status update)', () => {
    // Regression guard against a fix that "solves" this by removing the
    // call entirely — the orb must always say SOMETHING while reconnecting.
    const setStatusCalls = body.match(/_setStatus\(/g) || [];
    expect(setStatusCalls.length).toBeGreaterThan(0);
  });

  it('the reconnect loop itself is unchanged otherwise — still gated by _isOffline/_isReconnecting/MAX_WIDGET_RECONNECTS', () => {
    expect(body).toMatch(/if \(_s\._isOffline\)/);
    expect(body).toMatch(/if \(_s\._isReconnecting\)/);
    expect(body).toMatch(/_s\._reconnectCount >= MAX_WIDGET_RECONNECTS/);
  });
});

describe('orb-widget _audioEverHeardThisOpen lifecycle (VTID-03727 Codex fix)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('is declared in the initial _s state, defaulting to false', () => {
    expect(source).toMatch(/_audioEverHeardThisOpen:\s*false,/);
  });

  it('is set true at the SAME call site that sets greetingComplete true (the real "heard audio" moment)', () => {
    const idx = source.indexOf('_afterBeepStartMic = function () {');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 400);
    expect(block).toMatch(/_s\.greetingComplete = true;/);
    expect(block).toMatch(/_s\._audioEverHeardThisOpen = true;/);
    // greetingComplete must be set before _audioEverHeardThisOpen in the
    // same guarded block, not by a separate/later unguarded assignment.
    expect(block.indexOf('_s.greetingComplete = true;')).toBeLessThan(
      block.indexOf('_s._audioEverHeardThisOpen = true;'),
    );
  });

  it('is NOT reset by any of the reconnect paths that reset greetingComplete', () => {
    // Every one of these existing greetingComplete=false resets (VTID-01988
    // mic-restart, various reconnect points) must NOT also clear the new
    // flag — that would reintroduce the exact bug this fix exists for.
    const resetSites = [...source.matchAll(/_s\.greetingComplete = false;/g)];
    expect(resetSites.length).toBeGreaterThan(0);
    for (const m of resetSites) {
      const windowAround = source.slice(Math.max(0, m.index! - 50), m.index! + 200);
      expect(windowAround).not.toMatch(/_audioEverHeardThisOpen = false/);
    }
  });

  it('IS reset by _hide() — a real close ends the overlay session', () => {
    const idx = source.indexOf('function _hide() {');
    expect(idx).toBeGreaterThan(-1);
    const openIdx = source.indexOf('{', idx);
    let depth = 0, end = openIdx;
    for (let i = openIdx; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}') depth--;
      if (depth === 0) { end = i; break; }
    }
    const hideBody = source.slice(openIdx, end);
    expect(hideBody).toMatch(/_s\._audioEverHeardThisOpen = false;/);
  });
});
