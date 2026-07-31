import * as fs from 'fs';
import * as path from 'path';

// BOOTSTRAP-ORB-FASTSTART-DRIFT — the failed-session-start path must tell the
// truth and must recover.
//
// Live report (2026-07-31, prod mobile): after login the orb sat on
// "Verbinden..." forever; a second attempt connected. Telemetry showed the
// server reached session.start at +9.51s on the cold authenticated path while
// the widget aborts the start fetch at 8s. The abort landed in _sessionStart's
// catch, which set the 'error' aura but never touched the status text — so the
// label _show() wrote ("Verbinden...") stayed on screen with nothing in
// flight — and never handed off to the retry loop, making a merely-slow start
// permanently dead.
//
// These are static source checks (same approach as the sibling orb-widget
// suites): the widget is a plain browser IIFE with no export surface, so the
// invariants are asserted against the source text.

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

/** The trailing catch block of _sessionStart — the failed-start handler. */
function failedStartHandler(source: string): string {
  const body = extractFunctionBody(source, 'async function _sessionStart()');
  const idx = body.lastIndexOf('} catch (err) {');
  expect(idx).toBeGreaterThanOrEqual(0);
  return body.slice(idx);
}

describe('orb-widget failed session start (BOOTSTRAP-ORB-FASTSTART-DRIFT)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('replaces the stale status text instead of leaving "Verbinden..." on screen', () => {
    const handler = failedStartHandler(source);
    // The regression was a handler that set the aura but never the label.
    expect(handler).toMatch(/_setOrbState\('error'\)/);
    expect(handler).toMatch(/_setStatus\(/);
  });

  it('the failure status is localized and does not itself say "Verbinden..."', () => {
    const handler = failedStartHandler(source);
    expect(handler).toMatch(/lang\.startsWith\('de'\)/);
    expect(handler).toMatch(/Verbindung fehlgeschlagen/);
    // Guard the actual bug: the German failure string must not be the
    // connecting label _show() sets, or the UI is lying again.
    const deString = handler.match(/'(Verbindung fehlgeschlagen[^']*)'/)?.[1] ?? '';
    expect(deString).not.toBe('Verbinden...');
    expect(deString.length).toBeGreaterThan(0);
  });

  it('hands off to the retry loop so a slow start is not a permanent dead end', () => {
    const handler = failedStartHandler(source);
    expect(handler).toMatch(/_attemptReconnect\(\)/);
  });

  it('does not retry when the user is deliberately leaving', () => {
    const handler = failedStartHandler(source);
    // Mirrors _announceDisconnect's guards — retrying after an X press would
    // resurrect a session the user just dismissed.
    expect(handler).toMatch(/_s\._userInitiatedStop/);
    expect(handler).toMatch(/_s\.overlayVisible/);
  });

  it('does not stack a second retry while one is already in flight', () => {
    const handler = failedStartHandler(source);
    expect(handler).toMatch(/!_s\._isReconnecting/);
  });

  it('still records the error state the rest of the widget reads', () => {
    const handler = failedStartHandler(source);
    expect(handler).toMatch(/_s\.active = false/);
    expect(handler).toMatch(/_s\.sessionId = null/);
    expect(handler).toMatch(/_s\.liveError = err\.message/);
  });

  it('the WS transport start shares this handler (its await is inside the try)', () => {
    const body = extractFunctionBody(source, 'async function _sessionStart()');
    const wsAwait = body.indexOf('await _sessionStartWs(startPayload)');
    const catchIdx = body.lastIndexOf('} catch (err) {');
    expect(wsAwait).toBeGreaterThanOrEqual(0);
    // If the WS branch ever moves below the catch, its 8s timeout rejection
    // would bypass the recovery this suite protects.
    expect(wsAwait).toBeLessThan(catchIdx);
  });

  it('the 8s start budget still exists on both transports', () => {
    // The recovery above is what makes this budget survivable; if the budget
    // silently disappeared these tests would pass while the real behavior
    // changed underneath them.
    expect(source).toMatch(/AbortSignal\.timeout\(8000\)/);
    expect(source).toMatch(/WS session start timed out after 8s/);
  });
});
