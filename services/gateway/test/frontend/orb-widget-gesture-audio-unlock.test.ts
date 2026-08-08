/**
 * VTID-03469 — the ORB's first session after login was silent on iPhone.
 *
 * The playback AudioContext was only ever unlocked inside `_sessionStart()`,
 * which is reachable in-gesture ONLY on the FAB-tap path
 * (click → _show() → _sessionStart(), no await in between). vitana-v1's
 * voice-first front door (`useOrbFrontDoor`) calls `VitanaOrb.show()` from a
 * React `useEffect` right after login — no user activation at all. On iOS the
 * context stayed suspended, `_processQueue` burned its 3s resume budget and
 * DROPPED the greeting, while the overlay still read "Vitana spricht..."
 * because SPEAKING is set when an `audio_out` message ARRIVES, not when it
 * plays. Closing and re-opening worked because that second session came from
 * a real tap.
 *
 * These guards pin the two halves of the fix:
 *   1. a page-level first-gesture unlock installed at SCRIPT LOAD, so an
 *      earlier tap (the login button) starts the context, and
 *   2. an honest, tap-recoverable UI when audio genuinely cannot play,
 *      instead of miming speech over a dropped queue.
 */
import * as fs from 'fs';
import * as path from 'path';

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

describe('orb-widget page-level gesture audio unlock (VTID-03469)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('installs the unlock at script load, not from init()', () => {
    // The installer must run in the IIFE body itself. init() is called by the
    // host only AFTER auth resolves — by then the login tap is already spent,
    // and the front door's auto-open carries no gesture of its own.
    const callIdx = source.indexOf('\n  _installGestureAudioUnlock();');
    expect(callIdx).toBeGreaterThanOrEqual(0);

    const apiIdx = source.indexOf('window.VitanaOrb = {');
    const iifeEndIdx = source.lastIndexOf('})(window);');
    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(iifeEndIdx).toBeGreaterThan(apiIdx);
    expect(callIdx).toBeGreaterThan(apiIdx);
    expect(callIdx).toBeLessThan(iifeEndIdx);

    // ...and specifically NOT from inside init().
    const initBody = extractFunctionBody(source, 'init: function (opts)');
    expect(initBody).not.toMatch(/_installGestureAudioUnlock\s*\(/);
  });

  it('binds document-level gesture listeners in the capture phase', () => {
    const installBody = extractFunctionBody(
      source,
      'function _installGestureAudioUnlock()',
    );
    expect(installBody).toMatch(/_GESTURE_EVENTS\.forEach/);
    expect(installBody).toMatch(/document\.addEventListener/);
    expect(installBody).toMatch(/capture:\s*true/);
    // Must be idempotent — a second install would double-fire every gesture.
    expect(installBody).toMatch(/_s\._gestureUnlockInstalled/);

    const eventsDecl = source.match(/var _GESTURE_EVENTS = \[([^\]]*)\]/);
    expect(eventsDecl).not.toBeNull();
    const events = eventsDecl![1];
    // touchend/pointerdown are what iOS actually delivers; keydown covers a
    // desktop/keyboard login submit.
    for (const evt of ['pointerdown', 'touchend', 'mousedown', 'keydown']) {
      expect(events).toContain(evt);
    }
  });

  it('starts the context with a 1-sample silent buffer, not resume() alone', () => {
    const unlockBody = extractFunctionBody(
      source,
      'function _unlockPlaybackCtxFromGesture()',
    );
    // resume() alone does not reliably flip a never-started context on WebKit.
    expect(unlockBody).toMatch(/createBuffer\(1,\s*1,\s*22050\)/);
    expect(unlockBody).toMatch(/createBufferSource\(\)/);
    expect(unlockBody).toMatch(/\.start\(0\)/);
    expect(unlockBody).toMatch(/\.resume\(\)/);
    // Must recreate a closed context — _sessionStop() closes playbackCtx, so
    // the post-teardown gesture has nothing to resume otherwise.
    expect(unlockBody).toMatch(/state === 'closed'/);
  });

  it('surfaces blocked audio instead of silently dropping the queue', () => {
    const processQueueBody = extractFunctionBody(source, 'function _processQueue()');

    // The 3s-expiry branch must announce, not just clear the queue and return.
    const dropIdx = processQueueBody.indexOf('_s.audioQueue.length = 0;');
    const announceIdx = processQueueBody.indexOf('_announceAudioBlocked()');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(announceIdx).toBeGreaterThan(dropIdx);

    // A successful resume must take the prompt back down.
    expect(processQueueBody).toMatch(/_clearAudioBlocked\(\)/);
  });

  it('offers a tap that repairs playback and drains the pipeline', () => {
    const announceBody = extractFunctionBody(source, 'function _announceAudioBlocked()');
    expect(announceBody).toMatch(/_s\._audioBlocked = true/);
    expect(announceBody).toMatch(/_unlockPlaybackCtxFromGesture\(\)/);
    expect(announceBody).toMatch(/_processQueue\(\)/);
    // The prompt has to actually say what to do, in both shipped languages.
    expect(announceBody).toMatch(/Tippe, um Vitana zu hören/);
    expect(announceBody).toMatch(/Tap anywhere to hear Vitana/);
  });

  it('keeps the tap prompt visible through the end-of-turn transition', () => {
    // turn_complete drops the overlay to "Listening..."; doing that while
    // audio is blocked would erase the only instruction that fixes it.
    // Anchor on the post-greeting mic arm — unique to the turn-complete path,
    // unlike _playReadyBeep() which also fires from _clearDisconnect.
    const anchor = 'setTimeout(_afterBeepStartMic, 250);';
    expect(source.split(anchor).length - 1).toBe(1);
    const preamble = source.slice(0, source.indexOf(anchor)).slice(-500);

    // Both the "Listening..." repaint and the beep must sit behind the guard.
    expect(preamble).toMatch(/if \(!_s\._audioBlocked\)\s*\{/);
    expect(preamble).toMatch(/'Ich höre zu\.\.\.'/);
    expect(preamble).toMatch(/_playReadyBeep\(\)/);
  });

  it('drops the tap listener when the session tears down', () => {
    const stopBody = extractFunctionBody(source, 'function _sessionStop()');
    expect(stopBody).toMatch(/_clearAudioBlocked\(true\)/);
  });
});
