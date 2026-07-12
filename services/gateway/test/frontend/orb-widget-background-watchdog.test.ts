import * as fs from 'fs';
import * as path from 'path';

// Mobile overheating fix: orb-widget.js had no Page Visibility handling at
// all (no visibilitychange/pagehide listeners anywhere), so a backgrounded
// app kept the mic + audio pipeline + SSE/recovery-watchdog timers running
// full-tilt. Static checks mirror the style of
// orb-widget-speaking-watchdog.test.ts (the widget runs in the browser; we
// assert on its source so CI catches accidental removal/regression).

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

describe('orb-widget background/idle watchdog (mobile overheating fix)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('detects backgrounding via setTimeout drift, not the Visibility API', () => {
    const body = extractFunctionBody(source, 'function _startBackgroundWatchdog()');
    expect(body).toMatch(/setTimeout/);
    expect(body).toMatch(/Date\.now\(\) - scheduledAt - BG_CHECK_MS/);
    expect(body).toMatch(/drift > BG_KILL_DRIFT_MS/);
  });

  it('ends the session instead of leaving it running when backgrounding is detected', () => {
    const body = extractFunctionBody(source, 'function _startBackgroundWatchdog()');
    expect(body).toMatch(/_sessionStop\(\)/);
  });

  it('reschedules itself while the overlay is open, not gated on _s.active', () => {
    const body = extractFunctionBody(source, 'function _startBackgroundWatchdog()');
    expect(body).toMatch(/if \(_s\.overlayVisible\) _startBackgroundWatchdog\(\);/);
    // Regression guard: _s.active only flips true after the up-to-8s session
    // handshake and drops false during reconnect gaps — gating the reschedule
    // on it let the watchdog die on its first tick for slow-but-successful
    // opens (Codex review catch).
    expect(body).not.toMatch(/if \(_s\.active\) _startBackgroundWatchdog\(\);/);
  });

  it('uses a 5s check interval and a 30s kill threshold', () => {
    expect(source).toMatch(/BG_CHECK_MS = 5000/);
    expect(source).toMatch(/BG_KILL_DRIFT_MS = 30000/);
  });

  it('_stopBackgroundWatchdog clears the timer', () => {
    const body = extractFunctionBody(source, 'function _stopBackgroundWatchdog()');
    expect(body).toMatch(/clearTimeout\(_s\._bgWatchdogTimer\)/);
    expect(body).toMatch(/_s\._bgWatchdogTimer = null/);
  });

  it('starts on overlay open (_show) and stops on session teardown (_sessionStop)', () => {
    const showBody = extractFunctionBody(source, 'function _show()');
    expect(showBody).toMatch(/_startBackgroundWatchdog\(\)/);

    const stopBody = extractFunctionBody(source, 'async function _sessionStop()');
    expect(stopBody).toMatch(/_stopBackgroundWatchdog\(\)/);
  });
});
