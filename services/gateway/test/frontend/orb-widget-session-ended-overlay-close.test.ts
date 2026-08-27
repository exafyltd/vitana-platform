import * as fs from 'fs';
import * as path from 'path';

// VTID-03778 — the ORB overlay froze forever on a server-initiated
// 'session_ended' message, requiring a page refresh to exit.
//
// Live-reproduced (staging, right after VTID-03776 shipped): a guided-topic
// tap correctly fell back to safe generic conversation (VTID-03776's own
// circuit breaker working as designed — "let's continue where we left
// off"), ran normally in LISTENING state for ~57s, then the server
// superseded it (terminateExistingSessionsForUser in orb-live.ts — the
// ONLY live code path that sends 'session_ended' to a client whose
// handlers are still attached; the other two emitters both echo a stop the
// client itself already POSTed via /session/stop, by which point
// _sessionStop() has already detached this handler). Reported verbatim:
// "you cannot close it, Orb overlay remains with Listening subtitle under
// it, and the close button doesn't work, I need to refresh to exit."
//
// Root cause, confirmed by reading _sessionStop() in full: it (1)
// unconditionally sets _s._userInitiatedStop = true at its very top —
// mislabeling a SERVER-forced close as a user action, silently suppressing
// every later reconnect guard in this file for the rest of the
// overlay-open — and (2) only tears down session internals (mic, audio
// contexts, WS); it never touches overlay visibility or the status
// caption. Together, the overlay froze on its last caption forever with
// nothing running behind it and no path left to recover.
//
// Fix: 'session_ended' now calls _hide() — the same full, honest teardown
// a real user-initiated close uses, which actually closes the overlay.
//
// Static source checks (same approach as the sibling orb-widget suites):
// the widget is a plain browser IIFE with no export surface.

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

/** The `case 'session_ended': ... break;` block inside _handleMessage. */
function sessionEndedCaseBlock(source: string): string {
  const body = extractFunctionBody(source, 'function _handleMessage(msg) {');
  const idx = body.indexOf("case 'session_ended':");
  expect(idx).toBeGreaterThanOrEqual(0);
  const breakIdx = body.indexOf('break;', idx);
  expect(breakIdx).toBeGreaterThan(idx);
  return body.slice(idx, breakIdx + 'break;'.length);
}

describe("orb-widget 'session_ended' message handling (VTID-03778)", () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('does not call the old, unconditional _sessionStop() handler', () => {
    // The old regression: a bare call that mislabeled a server-forced close
    // as a user action and never closed the overlay.
    const block = sessionEndedCaseBlock(source);
    expect(block).not.toMatch(/^\s*_sessionStop\(\);?\s*$/m);
  });

  it('calls _hide() — the same full, honest teardown a real close uses', () => {
    const block = sessionEndedCaseBlock(source);
    expect(block).toMatch(/_hide\(\);/);
  });

  it('is a scoped fix — the case block itself contains exactly one _hide() call, no other logic added', () => {
    const block = sessionEndedCaseBlock(source);
    const hideCalls = [...block.matchAll(/_hide\(\);/g)];
    expect(hideCalls.length).toBe(1);
  });
});

describe('orb-widget _sessionStop() unconditional _userInitiatedStop (unchanged, still real, still a footgun) — VTID-03778 context', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('_sessionStop() still sets _userInitiatedStop = true at its top (confirms the fix works by AVOIDING this call site, not by changing it)', () => {
    const body = extractFunctionBody(source, 'async function _sessionStop() {');
    expect(body).toMatch(/_s\._userInitiatedStop = true;/);
  });

  it('_hide() itself is safe to call from a server-driven event: it does not require a prior user gesture', () => {
    const body = extractFunctionBody(source, 'function _hide() {');
    // _hide() must not early-return based on some "was this user-initiated"
    // flag that a synthetic call site (like the message handler) wouldn't
    // have set — it should unconditionally tear down + close.
    expect(body).not.toMatch(/if \(!_s\._userRequestedClose\)\s*return;/);
    expect(body).toMatch(/_s\.overlayVisible = false;/);
  });
});
