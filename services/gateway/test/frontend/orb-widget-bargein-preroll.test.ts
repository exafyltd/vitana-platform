/**
 * BOOTSTRAP-ORB-BARGEIN (audit L-09 / C-09) — barge-in must not destroy the
 * user's opening words.
 *
 * THE BUG this locks out: while Vitana was speaking, the capture handler ran
 * `return; // Don't send audio while model speaking` with no buffering at all,
 * and only reacted after vadConfirm=6 frames (~384ms at 1024 samples/16kHz).
 * Those frames were dropped on the floor — the beginning of every interruption
 * was permanently lost, Nova never received it, and because
 * NovaSonicLiveClient.sendEndOfTurn() is a documented no-op, nothing else
 * stopped Nova either.
 *
 * Follows this repo's established convention for widget code (see
 * orb-widget-audio-playback.test.ts): the browser file is not a module, so it
 * is asserted by extracting the relevant function body and pinning the
 * behavioural shape.
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

describe('orb-widget barge-in pre-roll', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('captures mic frames into a bounded pre-roll while the model is speaking', () => {
    const capture = extractFunctionBody(source, 'async function _startAudioCapture()');
    // Frames are ENCODED AND BUFFERED during playback, not discarded.
    expect(capture).toMatch(/preRollFrames\.push\(\s*_encodeFrame\(input\)\s*\)/);
    // Bounded — an unbounded buffer during a long Vitana answer would grow
    // without limit.
    expect(capture).toMatch(
      /preRollFrames\.length\s*>\s*PRE_ROLL_MAX_FRAMES[\s\S]{0,40}preRollFrames\.shift\(\)/,
    );
    expect(source).toMatch(/PRE_ROLL_MAX_FRAMES\s*=\s*\d+/);
  });

  it('flushes the buffered speech GATED ON the interrupt acknowledgement', () => {
    const capture = extractFunctionBody(source, 'async function _startAudioCapture()');
    // Codex review on #3006: on the DEFAULT sse transport, _sendInterrupt and
    // _sendAudio are independent fetches with no ordering guarantee. A buffered
    // frame arriving before the interrupt is processed hits
    // live-session-controller.ts:2270 and is returned as
    // {dropped:true, reason:'model_speaking'} — the exact audio this fix
    // preserves, discarded server-side. So the flush MUST be gated on the
    // interrupt's promise, not fired alongside it.
    expect(capture).toMatch(/var\s+_interruptAck\s*=\s*_sendInterrupt\(\)/);
    expect(capture).toMatch(
      /_flushPreRollOrdered\(\s*preRollFrames\s*,\s*_interruptAck\s*\)/,
    );
    // Ordering: the ack must be captured before the flush consumes it.
    const ackIdx = capture.indexOf('_sendInterrupt()');
    const flushIdx = capture.indexOf('_flushPreRollOrdered(');
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(flushIdx).toBeGreaterThan(ackIdx);
  });

  it('serializes the HTTP flush and prevents live frames overtaking it', () => {
    // The gate exists, chains rather than races, and is released when drained
    // so steady-state sending is not permanently serialized.
    expect(source).toMatch(/var\s+_httpSendChain\s*=\s*null/);
    expect(source).toMatch(
      /if\s*\(\s*!_s\.ws\s*&&\s*_httpSendChain\s*\)[\s\S]{0,200}_httpSendChain\s*=\s*_httpSendChain\.then/,
    );
    const flush = extractFunctionBody(source, 'function _flushPreRollOrdered(');
    // HTTP path chains each frame onto the previous.
    expect(flush).toMatch(/chain\s*=\s*chain\.then\(/);
    // WS path deliberately bypasses the gate — a socket is already ordered.
    expect(flush).toMatch(/if\s*\(\s*_s\.ws\s*\)[\s\S]{0,300}_sendAudioNow\(/);
    // Gate is released, and guarded against an older burst tearing down a
    // newer barge-in's chain.
    expect(flush).toMatch(/_httpSendChain\s*===\s*mine[\s\S]{0,40}_httpSendChain\s*=\s*null/);
  });

  it('interrupt and audio sends are awaitable, and never wedge on failure', () => {
    const interrupt = extractFunctionBody(source, 'function _sendInterrupt()');
    // Returned so the flush can gate on it...
    expect(interrupt).toMatch(/return\s+fetch\(/);
    // ...and resolves even when the interrupt POST fails, otherwise a dropped
    // interrupt would deadlock the queue and lose the audio anyway.
    expect(interrupt).toMatch(/\.then\(\s*function\s*\(\s*\)\s*\{\s*\}\s*,\s*function\s*\(\s*\)\s*\{\s*\}\s*\)/);
    const sendNow = extractFunctionBody(source, 'function _sendAudioNow(');
    expect(sendNow).toMatch(/return\s+fetch\(/);
  });

  it('resets the buffer once the model is no longer speaking', () => {
    const capture = extractFunctionBody(source, 'async function _startAudioCapture()');
    // Stale frames from a previous turn must never leak into a later
    // interruption. Reset appears in the not-playing branch alongside the
    // other per-turn VAD resets.
    expect(capture).toMatch(
      /vadInterruptSent\s*=\s*false;[\s\S]{0,80}preRollFrames\s*=\s*\[\]/,
    );
  });

  it('shares one encoder between the live path and the pre-roll', () => {
    // If these diverged, replayed frames could be encoded differently from
    // live ones. The live send path must go through the same helper.
    const capture = extractFunctionBody(source, 'async function _startAudioCapture()');
    expect(capture).toMatch(/_sendAudio\(\s*_encodeFrame\(input\)\s*\)/);
    expect(source).toMatch(/function _encodeFrame\(input\)/);
    // The inline Float32→Int16 loop must exist exactly once (in the helper),
    // not be duplicated back into the capture handler.
    const encodeLoops = source.match(/s\s*<\s*0\s*\?\s*s\s*\*\s*0x8000\s*:\s*s\s*\*\s*0x7FFF/g) || [];
    expect(encodeLoops).toHaveLength(1);
  });

  it('never reaches the during-playback return without having buffered the frame', () => {
    // This is the core invariant, asserted against CODE ONLY — the source
    // deliberately quotes the old buggy line in a comment for future readers,
    // so comments must be stripped or that quote self-triggers the check.
    const capture = extractFunctionBody(source, 'async function _startAudioCapture()');
    const codeOnly = capture
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/\/\/.*$/gm, '');

    // Inside the `if (modelPlaying) { ... }` branch, the buffering push must
    // come before the branch's return. If a future edit reinstates a bare
    // drop, push disappears and this fails.
    const playingIdx = codeOnly.indexOf('if (modelPlaying)');
    expect(playingIdx).toBeGreaterThanOrEqual(0);
    const afterPlaying = codeOnly.slice(playingIdx);
    const pushIdx = afterPlaying.indexOf('preRollFrames.push');
    const returnIdx = afterPlaying.indexOf('return;');
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeGreaterThan(pushIdx);
  });
});
