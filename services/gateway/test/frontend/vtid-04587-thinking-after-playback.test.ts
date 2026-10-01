import * as fs from 'fs';
import * as path from 'path';

// VTID-04587 — the server finishes a turn before the browser finishes playing
// it. When the user answered during that tail, the 'thinking' signal arrived
// while the widget was on Speaking and was dropped; when playback ended the
// widget showed Listening (ready beep, mic) while Vitana was preparing her
// answer, then flipped back to Speaking.
//
// Behaviour is verified end to end in a real browser by
// scripts/orb/verify-thinking-display.mjs (7 scenarios, before/after in
// docs/validation/VTID-04587/). These are the static contracts that keep the
// pieces wired, in the style of the sibling widget tests (the widget is a
// plain browser IIFE with no export surface).

const WIDGET_PATH = path.resolve(__dirname, '../../src/frontend/command-hub/orb-widget.js');
const source = fs.readFileSync(WIDGET_PATH, 'utf8');

function bodyOf(signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed body: ${signature}`);
}

function caseBlock(name: string): string {
  const start = source.indexOf(`case '${name}':`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\n      case \'', start + 10);
  return source.slice(start, next);
}

describe('VTID-04587 — Thinking, not Listening, when the user answers during playback', () => {
  it('a thinking signal that arrives while Speaking is remembered, not dropped', () => {
    const block = caseBlock('thinking');
    expect(block).toMatch(/else if \(_s\.voiceState === 'SPEAKING'\) \{[\s\S]*?_s\.thinkingPendingAfterPlayback = true;/);
  });

  it('the normal LISTENING/IDLE and MUTED thinking paths are unchanged', () => {
    const block = caseBlock('thinking');
    expect(block).toMatch(/if \(_s\.voiceState === 'LISTENING' \|\| _s\.voiceState === 'IDLE'\) \{[\s\S]*?}, 300\);/);
    expect(block).toMatch(/_s\.preMuteState = 'THINKING';/);
  });

  it('the turn_complete drain poll shows Thinking instead of Listening when a signal is pending, and skips the ready beep', () => {
    const block = caseBlock('turn_complete');
    const muted = block.indexOf("_s.preMuteState = 'LISTENING';");
    const pending = block.indexOf('} else if (_enterPendingThinking()) {');
    const listening = block.indexOf("_s.voiceState = 'LISTENING';", pending);
    expect(muted).toBeGreaterThan(0);
    expect(pending).toBeGreaterThan(muted);
    expect(listening).toBeGreaterThan(pending);
    const pendingBranch = block.slice(pending, listening);
    expect(pendingBranch).toMatch(/_afterBeepStartMic\(\);/); // mic still armed on the first turn
    expect(pendingBranch).not.toMatch(/_playReadyBeep/);
  });

  it('a turn_complete clears a signal remembered before it (a silent turn goes to Listening)', () => {
    const block = caseBlock('turn_complete');
    const clear = block.indexOf('_clearPendingThinking();');
    const poll = block.indexOf('_waitForAudioEnd');
    expect(clear).toBeGreaterThan(0);
    expect(clear).toBeLessThan(poll);
  });

  it('answer audio clears the pending signal', () => {
    const block = caseBlock('audio_out'); // 'audio' falls through to 'audio_out'
    expect(block).toMatch(/if \(msg\.data_b64\) _clearPendingThinking\(\);/);
  });

  it('the speaking-state watchdog follows the same rule', () => {
    const body = bodyOf('function _speakingStateWatchdog()');
    expect(body).toMatch(/if \(!_enterPendingThinking\(\)\) \{\s*\n\s*_s\.voiceState = 'LISTENING';/);
  });

  it('entering pending Thinking is idempotent, respects the tap-to-hear prompt, and has a 15 s fallback to Listening', () => {
    const body = bodyOf('function _enterPendingThinking()');
    expect(body).toMatch(/if \(!_s\.thinkingPendingAfterPlayback\) return false;/);
    expect(body).toMatch(/if \(_s\._audioBlocked\) return false;/);
    expect(body).toMatch(/if \(_s\.voiceState === 'THINKING'\) return true;/);
    expect(body).toMatch(/_setOrbState\('thinking'\)/);
    expect(body).toMatch(/_startThinkingProgress\(\)/);
    expect(body).toMatch(/PENDING_THINKING_FALLBACK_MS/);
    expect(source).toMatch(/var PENDING_THINKING_FALLBACK_MS = 15000;/);
    expect(body).toMatch(/_s\._sessionGeneration !== gen/);
  });

  it('the pending signal is cleared on disconnect and on session stop', () => {
    const count = (source.match(/_clearPendingThinking\(\); \/\/ VTID-04587/g) || []).length;
    expect(count).toBe(2);
  });
});
