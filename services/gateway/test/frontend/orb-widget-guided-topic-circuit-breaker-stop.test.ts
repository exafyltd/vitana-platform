import * as fs from 'fs';
import * as path from 'path';

// VTID-03782 — the guided-topic zero-audio circuit breaker (VTID-03776)
// correctly drops a topic after 2 consecutive no-audio failures, but used
// to silently fall through to a normal reconnect afterward.
//
// Live-reproduced (production, 2026-08-28, via oasis_events): after the
// breaker tripped and dropped the topic, the very next reconnect attempt
// ran the normal wake-brief candidate ranking with no guided topic in the
// mix, landing on an unrelated candidate (wake_opener:"conv_resume",
// nba:"next_session", nba_domain:"journey") that spoke one long, unbroken
// turn (3562 output speech tokens — reported verbatim as "something that
// sounds like reading a script"). Because the guided-topic system
// instruction was never injected for that session, end_guided_topic_teaching
// was never even a reachable signal — no Well-done drawer, nothing marked
// done, and no bound on how long the fallback conversation could run.
// Reported: "it doesn't finish after teaching the session and Well done
// drawer doesn't open afterwards, and the session is not marked as done."
//
// Fix: when the breaker trips, call the existing _enterStuckState()
// (tap-to-reconnect) instead of falling through — the same mechanism
// already used when MAX_WIDGET_RECONNECTS is exhausted. This stops the
// attempt honestly instead of silently degrading into an unrelated,
// unbounded conversation the user cannot distinguish from their lesson.
//
// Static source checks — same pattern as the sibling guided-topic suites
// (the widget is a plain browser IIFE with no export surface).

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

describe('orb-widget guided-topic circuit breaker stops honestly instead of falling through (VTID-03782)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'function _attemptReconnect() {');

  function breakerBlock(): string {
    const gateIdx = body.indexOf('if (_s._guidedTopicZeroAudioFailCount >= 2) {');
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    const openIdx = body.indexOf('{', gateIdx);
    let depth = 0;
    for (let i = openIdx; i < body.length; i++) {
      const c = body[i];
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (depth === 0) return body.slice(openIdx + 1, i);
    }
    throw new Error('unclosed breaker block');
  }

  it('still drops guidedTopic and _guidedTopicInFlight once the threshold is reached (unchanged)', () => {
    const block = breakerBlock();
    expect(block).toMatch(/_s\.guidedTopic = null;/);
    expect(block).toMatch(/_s\._guidedTopicInFlight = null;/);
  });

  it('calls _enterStuckState() after dropping the topic', () => {
    const block = breakerBlock();
    expect(block).toMatch(/_enterStuckState\(\);/);
    // Must come AFTER the topic is dropped, not before — the stuck-state
    // caption/orb-state change should reflect the topic already being gone.
    const dropIdx = block.indexOf('_s._guidedTopicInFlight = null;');
    const stuckIdx = block.indexOf('_enterStuckState();');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(stuckIdx).toBeGreaterThan(dropIdx);
  });

  it('returns immediately after _enterStuckState() — does not fall through to the normal reconnect scheduling below', () => {
    const block = breakerBlock();
    expect(block).toMatch(/_enterStuckState\(\);\s*\n\s*return;/);
  });

  it('does not increment _reconnectCount or schedule a delayed reconnect once the breaker has stopped the attempt', () => {
    // The breaker block itself must not contain the normal scheduling
    // logic (RECONNECT_DELAYS / _reconnectCount++) — that would mean the
    // early return above is dead code / bypassed.
    const block = breakerBlock();
    expect(block).not.toMatch(/_s\._reconnectCount\+\+/);
    expect(block).not.toMatch(/RECONNECT_DELAYS/);
  });

  // Codex review finding on this PR: _enterStuckState() alone does not stop
  // automatic recovery. _resetAndReconnect()'s own comment confirms
  // _disconnectActive is deliberately left true so the 5s _recoveryWatchdog
  // health-probe can auto-recover once the gateway answers again — correct
  // for a real network outage, but this breaker trips on a REACHABLE
  // gateway (nova_validation, not a dropped connection), so the probe would
  // succeed within ~5s and silently call _resetAndReconnect() anyway,
  // reopening the exact unrelated conversation the stop exists to prevent.
  it('cancels the recovery watchdog and clears _disconnectActive before entering the stuck state', () => {
    const block = breakerBlock();
    expect(block).toMatch(/clearInterval\(_s\._recoveryWatchdog\)/);
    expect(block).toMatch(/_s\._recoveryWatchdog = null;/);
    expect(block).toMatch(/_s\._disconnectActive = false;/);
    // Must happen BEFORE _enterStuckState() — no window where the watchdog
    // could still be armed while the UI already shows the stuck state.
    const watchdogIdx = block.indexOf('_s._recoveryWatchdog = null;');
    const disconnectIdx = block.indexOf('_s._disconnectActive = false;');
    const stuckIdx = block.indexOf('_enterStuckState();');
    expect(watchdogIdx).toBeGreaterThanOrEqual(0);
    expect(disconnectIdx).toBeGreaterThan(watchdogIdx);
    expect(stuckIdx).toBeGreaterThan(disconnectIdx);
  });

  it('the manual tap-to-reconnect path still works with _disconnectActive cleared (gated on _disconnectStuck too)', () => {
    // _enterStuckState() sets _disconnectStuck = true; the tap handler must
    // OR the two flags so clearing _disconnectActive here doesn't also
    // disable the manual retry this whole mechanism exists to offer.
    const stuckStateBody = extractFunctionBody(source, 'function _enterStuckState() {');
    expect(stuckStateBody).toMatch(/_s\._disconnectStuck = true;/);
    expect(source).toMatch(/_s\._disconnectActive \|\| _s\._disconnectStuck/);
  });

  it('_enterStuckState remains the exact same function MAX_WIDGET_RECONNECTS exhaustion uses — no new UI invented', () => {
    // Only one function named _enterStuckState should exist in the file;
    // both call sites must reference it, not a topic-specific variant.
    const occurrences = (source.match(/function _enterStuckState\(\)/g) || []).length;
    expect(occurrences).toBe(1);
    const stuckStateFnBody = extractFunctionBody(source, 'function _enterStuckState() {');
    expect(stuckStateFnBody).toMatch(/_setOrbState\('error'\);/);
    expect(stuckStateFnBody).toMatch(/tapToReconnect/);
  });
});
