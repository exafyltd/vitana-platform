/**
 * VTID-04198 / VTID-04199 — iPhone pre-login: "Vitana talking, no audio, zero".
 *
 * Reported live on 2026-09-19 (iOS 16.6, Appilix wrapper). Production
 * telemetry for the reported German session `58373903` shows the gateway
 * streamed **315 audio chunks / 643 speech tokens** — a complete, healthy
 * greeting. The user heard nothing. Nothing server-side recorded a fault,
 * because the audio was discarded inside the widget.
 *
 * Two defects, pinned here:
 *
 * VTID-04199 (a) — the retry loop could stop mid-flight. `_processQueue`'s
 * suspended-context branch re-entered ONLY via `resume()`'s own
 * `.then`/`.catch` or via the arrival of another chunk. On iOS a `resume()`
 * issued without user activation can stay PENDING — never resolving, never
 * rejecting — so once the greeting finished streaming there was no chunk left
 * to drive the loop either. The retry silently stopped: no playback, and not
 * even the 3s give-up that would have shown the tap-to-hear prompt. The
 * overlay sat on "Vitana spricht..." in silence, which is exactly how the
 * report presented. Fixed with a self-owned re-entry tick.
 *
 * VTID-04199 (b) — the give-up branch emptied `_s.audioQueue`, which defeated
 * the recovery VTID-03469 added in the same breath: the prompt says "tap to
 * hear", the tap unlocks the context and calls `_processQueue()` — against a
 * queue that had already been thrown away. The prompt was honest about the
 * problem and structurally incapable of fixing it. The audio is now held
 * (bounded at the push site, earliest-first) so the tap actually plays the
 * greeting from its first word.
 *
 * VTID-04198 — none of this was visible server-side. `_announceAudioBlocked()`
 * wrote a `console.error` on a phone with no console attached, so the single
 * most user-visible ORB failure was the one with no signal at all.
 *
 * The widget is a plain IIFE with no export surface, so — same pattern as
 * orb-widget-gesture-audio-unlock.test.ts, whose VTID-03469 guards this
 * suite extends — these are static source-check tests.
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

describe('orb-widget iOS audio-block recovery (VTID-04199)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const processQueueBody = extractFunctionBody(source, 'function _processQueue()');

  it('drives the suspended-context retry from its own timer, not only from resume() settling', () => {
    // The whole point: re-entry must not depend on resume() resolving (it can
    // hang forever on iOS) or on another chunk arriving (the greeting ends).
    expect(processQueueBody).toMatch(/_s\._resumeWatchdogTimer = setTimeout\(/);
    expect(processQueueBody).toMatch(/_RESUME_RETRY_TICK_MS/);

    // Guarded so repeated _processQueue calls cannot stack timers.
    const armIdx = processQueueBody.indexOf('if (!_s._resumeWatchdogTimer)');
    expect(armIdx).toBeGreaterThanOrEqual(0);
    expect(processQueueBody.indexOf('_s._resumeWatchdogTimer = setTimeout(')).toBeGreaterThan(armIdx);
  });

  it('no longer discards the queued audio when it gives up', () => {
    // This is the assertion VTID-03469's suite pinned the other way round.
    // Emptying the queue here is what made the tap-to-hear prompt a dead end:
    // the tap replays a queue that no longer holds the greeting.
    expect(processQueueBody).not.toMatch(/_s\.audioQueue\.length = 0\s*;/);
    // ...and it must still announce, so the user is not left in the dark.
    expect(processQueueBody).toMatch(/_announceAudioBlocked\(/);
  });

  it('passes the give-up reason to the announcement so it can be reported', () => {
    expect(processQueueBody).toMatch(/_announceAudioBlocked\(\{[^}]*reason:\s*'resume_timeout'/);
    expect(processQueueBody).toMatch(/elapsed_ms:\s*elapsed/);
  });

  it('cancels the retry tick on give-up, on success, and on teardown', () => {
    // Give-up + success both live in _processQueue.
    const clears = processQueueBody.match(/clearTimeout\(_s\._resumeWatchdogTimer\)/g) || [];
    expect(clears.length).toBeGreaterThanOrEqual(2);

    // Teardown: a tick outliving the session would resurrect a closed
    // AudioContext, since _processQueue recreates one.
    const stopBody = extractFunctionBody(source, 'function _sessionStop(');
    expect(stopBody).toMatch(/clearTimeout\(_s\._resumeWatchdogTimer\)/);
    expect(stopBody).toMatch(/_s\._resumeWatchdogTimer = null/);
  });

  it('bounds the held queue at the push site, keeping the earliest chunks', () => {
    const playBody = extractFunctionBody(source, 'function _playAudio(base64Data, mimeType)');
    // Holding without a cap would grow unbounded on a device that never
    // unlocks. Keeping the EARLIEST chunks means recovery plays the greeting
    // from its first word rather than from an arbitrary midpoint.
    expect(playBody).toMatch(/_s\.audioQueue\.length < _AUDIO_QUEUE_HOLD_CHUNKS/);
    expect(playBody).toMatch(/_s\.audioQueue\.push\(/);

    const capDecl = source.match(/var _AUDIO_QUEUE_HOLD_CHUNKS = (\d+)/);
    expect(capDecl).not.toBeNull();
    // Must comfortably exceed the 315 chunks one real greeting measured, or
    // the cap would truncate the very thing it exists to preserve.
    expect(parseInt(capDecl![1], 10)).toBeGreaterThan(315);
  });

  it('keeps the give-up budget bounded and named', () => {
    const giveUp = source.match(/var _RESUME_GIVE_UP_MS = (\d+)/);
    const tick = source.match(/var _RESUME_RETRY_TICK_MS = (\d+)/);
    expect(giveUp).not.toBeNull();
    expect(tick).not.toBeNull();
    // The tick must fit inside the budget several times over, otherwise the
    // watchdog contributes nothing before the give-up fires.
    expect(parseInt(tick![1], 10) * 4).toBeLessThanOrEqual(parseInt(giveUp![1], 10));
  });
});

describe('orb-widget audio-blocked telemetry (VTID-04198)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('beacons the block to the gateway, keyed to the session', () => {
    const beaconBody = extractFunctionBody(source, 'function _beaconAudioBlocked(state, detail)');
    expect(beaconBody).toMatch(/\/api\/v1\/orb\/session\/'\s*\+\s*encodeURIComponent\(_s\.sessionId\)\s*\+\s*'\/audio-blocked/);
    expect(beaconBody).toMatch(/method:\s*'POST'/);
    // keepalive: the most likely next action is closing the overlay, and the
    // report must survive that.
    expect(beaconBody).toMatch(/keepalive:\s*true/);
    // Never allowed to throw or reject into an already-degraded path.
    expect(beaconBody).toMatch(/\.catch\(/);
    expect(beaconBody).toMatch(/try\s*\{/);
  });

  it('carries the fields needed to tell the failure modes apart', () => {
    const beaconBody = extractFunctionBody(source, 'function _beaconAudioBlocked(state, detail)');
    for (const field of ['ctx_state', 'queued_chunks', 'unlocked_by_gesture', 'audio_ever_heard', 'lang']) {
      expect(beaconBody).toContain(field);
    }
  });

  it('fires once per block, from _announceAudioBlocked', () => {
    const announceBody = extractFunctionBody(source, 'function _announceAudioBlocked(detail)');
    expect(announceBody).toMatch(/_beaconAudioBlocked\('blocked', detail\)/);
    // One beacon per block — a flapping context must not spam the gateway.
    expect(announceBody).toMatch(/_s\._audioBlockedBeaconSent/);
  });

  it('distinguishes a real recovery from the user giving up', () => {
    const clearBody = extractFunctionBody(source, 'function _clearAudioBlocked(skipUi)');
    // skipUi is the teardown caller (_sessionStop), never a recovery.
    // Reporting it as 'recovered' would over-count rescues by exactly the
    // population this beacon exists to measure.
    expect(clearBody).toMatch(/skipUi\s*\?\s*'abandoned'\s*:\s*'recovered'/);
  });

  it('does not beacon before a session exists', () => {
    const beaconBody = extractFunctionBody(source, 'function _beaconAudioBlocked(state, detail)');
    expect(beaconBody).toMatch(/if \(!_s\.sessionId\) return/);
  });
});
