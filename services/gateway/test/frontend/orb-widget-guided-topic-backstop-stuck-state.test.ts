import * as fs from 'fs';
import * as path from 'path';

// VTID-03784 — the VTID-03762 guided-topic backstop (a 5-minute timer,
// armed in focusGuidedTopic(), that fires end_guided_topic_teaching if the
// model never signals completion) was never cancelled by any path into
// _enterStuckState() — the shared "tap to reconnect" stop used by both the
// VTID-03776/03782 guided-topic circuit breaker and MAX_WIDGET_RECONNECTS
// exhaustion. Only _hide() cleared it, and neither stuck-state path calls
// _hide() (the overlay deliberately stays up so the user can retry).
//
// Live-reproduced on staging directly after VTID-03783 shipped: tapped a
// My Journey step ("Session 7"), hit the circuit breaker's "Tap the orb to
// reconnect" stuck state, then ~5 minutes later — without ever tapping
// anything — the Well-done drawer appeared and the step was marked done,
// even though the lesson was never delivered.
//
// Fix: _enterStuckState() itself now cancels the backstop (clearing
// _guidedTopicOpenedAt and the interval), the same cleanup _hide() already
// does — covering every current and future path into this shared stuck
// state, not just the circuit breaker.
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

describe('orb-widget _enterStuckState cancels the guided-topic backstop (VTID-03784)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'function _enterStuckState() {');

  it('clears _guidedTopicOpenedAt', () => {
    expect(body).toMatch(/_s\._guidedTopicOpenedAt = null;/);
  });

  it('cancels the backstop interval and nulls the handle', () => {
    expect(body).toMatch(/clearInterval\(_s\._guidedTopicBackstopInterval\)/);
    expect(body).toMatch(/_s\._guidedTopicBackstopInterval = null;/);
  });

  it('still sets the tap-to-reconnect UI state (unchanged behavior)', () => {
    expect(body).toMatch(/_setOrbState\('error'\);/);
    expect(body).toMatch(/tapToReconnect/);
    expect(body).toMatch(/_s\._disconnectStuck = true;/);
  });

  it('the guided-topic circuit breaker call site no longer needs its own duplicate cancellation — _enterStuckState covers it', () => {
    // Regression guard against re-introducing the cleanup at just one call
    // site (the circuit breaker) instead of the shared function — that
    // would silently leave MAX_WIDGET_RECONNECTS exhaustion vulnerable to
    // the identical false-completion bug for a guided-topic session that
    // never got that far.
    const reconnectFnBody = extractFunctionBody(source, 'function _attemptReconnect() {');
    const breakerGateIdx = reconnectFnBody.indexOf('if (_s._guidedTopicZeroAudioFailCount >= 2) {');
    expect(breakerGateIdx).toBeGreaterThanOrEqual(0);
    const breakerStuckIdx = reconnectFnBody.indexOf('_enterStuckState();', breakerGateIdx);
    const breakerBlock = reconnectFnBody.slice(breakerGateIdx, breakerStuckIdx);
    expect(breakerBlock).not.toMatch(/_guidedTopicBackstopInterval/);
  });

  it('MAX_WIDGET_RECONNECTS exhaustion also stops via the same _enterStuckState — same protection, no separate mechanism', () => {
    const reconnectFnBody = extractFunctionBody(source, 'function _attemptReconnect() {');
    expect(reconnectFnBody).toMatch(/_s\._reconnectCount >= MAX_WIDGET_RECONNECTS\) \{\s*\n\s*_enterStuckState\(\);/);
  });
});
