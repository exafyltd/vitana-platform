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

  it('flushes the buffered speech upstream when barge-in is confirmed', () => {
    const capture = extractFunctionBody(source, 'async function _startAudioCapture()');
    // The flush must actually send, via the same transport-agnostic path as
    // live audio (_sendAudio picks WS vs HTTP internally).
    expect(capture).toMatch(
      /for\s*\(\s*var\s+p\s*=\s*0;[\s\S]{0,120}_sendAudio\(\s*preRollFrames\[p\]\s*\)/,
    );
    // And the flush is inside the confirmed-interrupt branch, i.e. it happens
    // together with _sendInterrupt rather than on every frame.
    const interruptIdx = capture.indexOf('_sendInterrupt()');
    const flushIdx = capture.indexOf('_sendAudio(preRollFrames[p])');
    expect(interruptIdx).toBeGreaterThanOrEqual(0);
    expect(flushIdx).toBeGreaterThan(interruptIdx);
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
