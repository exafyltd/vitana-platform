import * as fs from 'fs';
import * as path from 'path';

// VTID-03740 — the DEV-COMHU-0501 speaking-state watchdog (see the sibling
// orb-widget-speaking-watchdog.test.ts) only ever cleared the INTERNAL
// audioPlaying flag when it fired; it never touched .vtorb-status or the
// orb glow. A session whose upstream stream dies mid-turn (delivers at
// least one audio chunk, then goes silent before turn_complete) never gets
// a server turn_complete, so _waitForAudioEnd() — the only other place that
// resets the visible state — never runs either. Reported live: the
// pre-login MAXINA Intro orb visibly "spoke" (caption "Vitana priča..." +
// amber glow) but stayed silent, stuck that way for the rest of the
// session.
//
// Static source checks, matching the sibling watchdog test's style (the
// widget is a plain browser IIFE with no export surface).

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

describe('orb-widget stuck-speaking recovery (VTID-03740)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'function _speakingStateWatchdog()');

  it('resets the visible voiceState/orb/caption back to listening when the watchdog fires while stuck in SPEAKING', () => {
    expect(body).toMatch(/_s\.voiceState === 'SPEAKING'/);
    expect(body).toMatch(/_s\.voiceState = 'LISTENING';/);
    expect(body).toMatch(/_setOrbState\('listening'\)/);
    expect(body).toMatch(/_setStatus\(_caption\('listening'\)\)/);
  });

  it('guards the recovery on session-active / not-closing-for-nav / not-user-closed / overlay-visible, matching the normal turn-complete path', () => {
    expect(body).toMatch(/_s\.active/);
    expect(body).toMatch(/!_isClosingForNav\(\)/);
    expect(body).toMatch(/!_s\._userRequestedClose/);
    expect(body).toMatch(/_s\.overlayVisible/);
  });

  it('does not overwrite the tap-to-hear prompt when audio is blocked (VTID-03469)', () => {
    expect(body).toMatch(/if \(!_s\._audioBlocked\) \{\s*\n\s*_setOrbState\('listening'\);\s*\n\s*_setStatus\(_caption\('listening'\)\);/);
  });

  it('re-arms the mic exactly once, gated on !greetingComplete, mirroring the normal first-turn mic-start invariant', () => {
    expect(body).toMatch(/if \(!_s\.greetingComplete\) \{/);
    expect(body).toMatch(/_s\.greetingComplete = true;/);
    expect(body).toMatch(/_s\._audioEverHeardThisOpen = true;/);
    expect(body).toMatch(/_startAudioCapture\(\)\.catch\(/);
  });

  it('never fires _cfg.onTurnComplete — this turn did not genuinely complete, and reporting it as complete would reproduce the VTID-03685 "completed" drawer bug for undelivered content', () => {
    expect(body).not.toMatch(/onTurnComplete/);
  });

  it('still clears the internal audioPlaying flag and refreshes the mic-button UI regardless of the recovery branch (unchanged DEV-COMHU-0501 behavior)', () => {
    expect(body).toMatch(/audioPlaying = false;/);
    expect(body).toMatch(/_updateUI\(\);/);
  });
});
