import * as fs from 'fs';
import * as path from 'path';

// VTID-03776 — infinite guided-topic reconnect loop, live-reproduced right
// after VTID-03774 shipped (oasis_events trace 2026-08-27 13:25-13:31 UTC):
// tapping a guided-topic session produced a BRAND NEW `live-*` session every
// ~3.4s, ~30+ consecutive times over 5+ minutes — every single one hitting
// Nova's nova_validation content filter on the guided-topic wake-brief
// opener within ~700ms of greeting_sent, before any turn ever completed.
// Reported live: "it now starts immediately... but repeats it infinitely,
// there is no end, and we hear the Connecting sound in the background
// non-stop. Also, you can't stop it, the close button doesn't work."
//
// Root cause: VTID-03774's own Fix 1+2 made guided_topic_id correctly
// persist and resend across every reconnect (previously it silently
// dropped after one attempt) — but `_attemptReconnect()`'s success handler
// reset `_s._reconnectCount = 0` whenever `_s.active` became true, i.e. on
// a bare TRANSPORT connect, regardless of whether the session then died to
// nova_validation before any audio played. For a guided topic whose opener
// is deterministically rejected, every reconnect "succeeds" at the
// transport layer just long enough to zero the budget before the very next
// RECONNECT_DELAYS[0] fires — MAX_WIDGET_RECONNECTS never actually bounds
// anything, and every attempt re-synthesizes/replays the full Polly
// narration audio before being blocked again (the "infinite repeat").
//
// Two fixes:
//   A. Only reset _reconnectCount once real audio has actually played this
//      overlay-open (_audioEverHeardThisOpen, the same flag VTID-03727
//      already established for the reconnect-caption gating).
//   B. A circuit breaker: after 2 consecutive disconnects with a guided
//      topic in flight and NO audio ever heard this overlay-open, drop the
//      topic so the next attempt falls through to safe generic conversation
//      instead of repeating the doomed content — ending the audible repeat
//      well before the 5-attempt widget-level budget is exhausted.
//
// Static source checks (same approach as the sibling orb-widget suites): the
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

describe('orb-widget _s._guidedTopicZeroAudioFailCount lifecycle (VTID-03776)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('is declared in the initial _s state, defaulting to 0', () => {
    expect(source).toMatch(/_guidedTopicZeroAudioFailCount:\s*0,/);
  });

  it('is reset to 0 by focusGuidedTopic (a fresh tap is a clean slate)', () => {
    const idx = source.indexOf('focusGuidedTopic: function (topicId) {');
    expect(idx).toBeGreaterThan(-1);
    const openIdx = source.indexOf('{', idx);
    let depth = 0, end = openIdx;
    for (let i = openIdx; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}') depth--;
      if (depth === 0) { end = i; break; }
    }
    const block = source.slice(openIdx, end);
    expect(block).toMatch(/_s\._guidedTopicZeroAudioFailCount = 0;/);
  });

  it('is reset to 0 by _hide() — a real close ends the overlay session', () => {
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
    expect(hideBody).toMatch(/_s\._guidedTopicZeroAudioFailCount = 0;/);
  });
});

describe('orb-widget _attemptReconnect guided-topic circuit breaker (VTID-03776 Fix B)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'function _attemptReconnect() {');

  it('increments the zero-audio fail counter only when a guided topic is in flight AND nothing has been heard yet', () => {
    expect(body).toMatch(
      /if \(_s\._guidedTopicInFlight && !_s\._audioEverHeardThisOpen\) {\s*\n\s*_s\._guidedTopicZeroAudioFailCount = \(_s\._guidedTopicZeroAudioFailCount \|\| 0\) \+ 1;/,
    );
  });

  it('drops both guidedTopic and _guidedTopicInFlight once the threshold is reached', () => {
    expect(body).toMatch(/if \(_s\._guidedTopicZeroAudioFailCount >= 2\) {/);
    const gateIdx = body.indexOf('if (_s._guidedTopicZeroAudioFailCount >= 2) {');
    expect(gateIdx).toBeGreaterThan(-1);
    const window = body.slice(gateIdx, gateIdx + 400);
    expect(window).toMatch(/_s\.guidedTopic = null;/);
    expect(window).toMatch(/_s\._guidedTopicInFlight = null;/);
  });

  it('the breaker check runs before the MAX_WIDGET_RECONNECTS stuck-state check', () => {
    const breakerIdx = body.indexOf('_guidedTopicZeroAudioFailCount = (_s._guidedTopicZeroAudioFailCount');
    const stuckIdx = body.indexOf('_s._reconnectCount >= MAX_WIDGET_RECONNECTS');
    expect(breakerIdx).toBeGreaterThan(-1);
    expect(stuckIdx).toBeGreaterThan(-1);
    expect(breakerIdx).toBeLessThan(stuckIdx);
  });

  // VTID-03782: superseded expectation. This used to assert the tripped
  // breaker "still gets a fair remaining-budget retry" by falling through
  // to the normal reconnect below — live evidence showed that fallthrough
  // landed on an unrelated, unbounded generic-conversation candidate with
  // no natural end, which the user could not distinguish from the Journey
  // session still running. See orb-widget-guided-topic-circuit-breaker-stop.test.ts
  // for the current behavior: the breaker now stops via _enterStuckState()
  // instead of consuming reconnect budget on a topic already given up on.
  it('does NOT fall through to a fresh reconnect once the breaker trips — it stops immediately instead', () => {
    const gateIdx = body.indexOf('if (_s._guidedTopicZeroAudioFailCount >= 2) {');
    const stuckIdx = body.indexOf('_s._reconnectCount >= MAX_WIDGET_RECONNECTS');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(stuckIdx).toBeGreaterThan(-1);
    const window = body.slice(gateIdx, stuckIdx);
    expect(window).toMatch(/_enterStuckState\(\);/);
    expect(window).toMatch(/_enterStuckState\(\);\s*\n\s*return;/);
  });

  it('does NOT touch the counter or drop the topic once real audio has played (mid-lesson resume must survive)', () => {
    // The guard is a single `&&`-combined condition — confirm the positive
    // audio-heard case is structurally excluded, not handled by a second
    // branch that could diverge from the first.
    expect(body).not.toMatch(/if \(_s\._guidedTopicInFlight\) {\s*\n\s*_s\._guidedTopicZeroAudioFailCount/);
  });
});

describe('orb-widget _attemptReconnect backoff-budget reset (VTID-03776 Fix A)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'function _attemptReconnect() {');

  it('does NOT reset _reconnectCount on bare _s.active alone', () => {
    // The old regression: reset gated only on transport-active, so a session
    // that connects and immediately dies (nova_validation, before any turn)
    // still zeroed the budget every single time.
    expect(body).not.toMatch(/if \(_s\.active\) {\s*\n\s*_s\._reconnectCount = 0;/);
  });

  it('gates the reset on _s._audioEverHeardThisOpen, nested inside the _s.active branch', () => {
    const activeIdx = body.indexOf('if (_s.active) {');
    expect(activeIdx).toBeGreaterThan(-1);
    const nextElseIdx = body.indexOf('} else {', activeIdx);
    expect(nextElseIdx).toBeGreaterThan(activeIdx);
    const activeBranch = body.slice(activeIdx, nextElseIdx);
    expect(activeBranch).toMatch(
      /if \(_s\._audioEverHeardThisOpen\) {\s*\n\s*_s\._reconnectCount = 0;\s*\n\s*}/,
    );
  });

  it('still logs success and clears the disconnect banner regardless of whether the budget was reset', () => {
    const activeIdx = body.indexOf('if (_s.active) {');
    const nextElseIdx = body.indexOf('} else {', activeIdx);
    const activeBranch = body.slice(activeIdx, nextElseIdx);
    expect(activeBranch).toMatch(/console\.log\('\[VTOrb\] _attemptReconnect: succeeded/);
    expect(activeBranch).toMatch(/if \(_s\._disconnectActive\) _clearDisconnect\(\);/);
  });

  it('the reconnect loop itself is otherwise unchanged — still gated by _isOffline/_isReconnecting/MAX_WIDGET_RECONNECTS', () => {
    expect(body).toMatch(/if \(_s\._isOffline\)/);
    expect(body).toMatch(/if \(_s\._isReconnecting\)/);
    expect(body).toMatch(/_s\._reconnectCount >= MAX_WIDGET_RECONNECTS/);
  });
});
