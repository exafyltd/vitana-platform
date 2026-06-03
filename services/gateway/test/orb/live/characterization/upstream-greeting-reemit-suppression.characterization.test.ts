/**
 * BOOTSTRAP-ORB-GREETING-REEMIT — structural greeting/journey re-emit suppression.
 *
 * User report: opening the ORB ("Vitana Assistant") speaks the greeting +
 * "My Journey" summary 3 times in a row, "again and again". Root cause:
 * Gemini Live occasionally auto-continues after a `Say exactly: "…"` opener
 * directive and re-speaks the SAME opener as a brand-new model turn with NO
 * user input in between.
 *
 * The pre-existing VTID-03143 transcript-prefix filter only catches this
 * AFTER ~30 chars of OUTPUT TRANSCRIPTION match a prior turn — so the first
 * words still leak, and it does nothing when output transcription is
 * sparse/absent. This guard catches the re-emit STRUCTURALLY, from the very
 * first audio chunk, with no dependency on transcription.
 *
 * This file locks the structural contract of that guard in
 * services/gateway/src/orb/live/session/upstream-message-handler.ts:
 *
 *   - It lives in the new-model-turn-start block (the `if (!session.isModelSpeaking)`
 *     branch that fires on the first audio chunk of a turn), so the flag is
 *     set BEFORE the audio-forward decision — no first-word leak.
 *   - It only fires when the user has NEVER spoken yet:
 *       greetingSent && turn_count >= 1 && consecutiveModelTurns >= turn_count
 *       && inputTranscriptBuffer empty.
 *     (consecutiveModelTurns resets to 0 the instant a user transcription
 *     arrives, so equality with turn_count proves no user turn happened.)
 *   - It reuses session.suppressCurrentTurnAudio so the existing forward
 *     gate drops the whole turn.
 *   - It emits a [BOOTSTRAP-ORB-GREETING-REEMIT] warn + greeting_reemit_suppressed diag.
 */

import * as fs from 'fs';
import * as path from 'path';

const HANDLER_PATH = path.resolve(
  __dirname,
  '../../../../src/orb/live/session/upstream-message-handler.ts',
);

let src: string;

beforeAll(() => {
  src = fs.readFileSync(HANDLER_PATH, 'utf8');
});

describe('BOOTSTRAP-ORB-GREETING-REEMIT: structural greeting re-emit suppression', () => {
  it('guards on greetingSent + the "user never spoke" counter relation', () => {
    // greetingSent: the only thing produced so far is the opener.
    expect(src).toMatch(/session\.greetingSent/);
    // turn_count >= 1: the greeting already completed at least once.
    expect(src).toMatch(/session\.turn_count\s*>=\s*1/);
    // consecutiveModelTurns >= turn_count: the user has NEVER interjected
    // (the counter resets to 0 on user speech, so equality == no user turn).
    expect(src).toMatch(/session\.consecutiveModelTurns\s*>=\s*session\.turn_count/);
    // No user utterance mid-flight either.
    expect(src).toMatch(/\(session\.inputTranscriptBuffer\s*\|\|\s*''\)\.trim\(\)\.length\s*===\s*0/);
  });

  it('flips session.suppressCurrentTurnAudio so the existing forward gate drops the turn', () => {
    // Reuses the VTID-03143 suppression flag rather than a parallel path.
    expect(src).toMatch(/suppressCurrentTurnAudio\s*=\s*true;/);
    // Idempotency guard so the warn/diag fires once per re-emit turn, not per chunk.
    expect(src).toMatch(/suppressCurrentTurnAudio\s*!==\s*true/);
  });

  it('emits a [BOOTSTRAP-ORB-GREETING-REEMIT] warn + greeting_reemit_suppressed diag', () => {
    expect(src).toMatch(/\[BOOTSTRAP-ORB-GREETING-REEMIT\] Suppressing unsolicited greeting re-emit/);
    expect(src).toMatch(/greeting_reemit_suppressed/);
  });

  it('sets the flag inside the new-turn-start (isModelSpeaking) block, before audio is forwarded', () => {
    // The guard must sit between the start-of-turn marker and the
    // onAudioResponse forward, so a re-emit is dropped from chunk 1.
    const idxIsSpeaking = src.indexOf('if (!session.isModelSpeaking)');
    const idxGuard = src.indexOf('[BOOTSTRAP-ORB-GREETING-REEMIT] Suppressing');
    const idxForward = src.indexOf('ctx.callbacks.onAudioResponse(audioB64)');
    expect(idxIsSpeaking).toBeGreaterThan(-1);
    expect(idxGuard).toBeGreaterThan(idxIsSpeaking);
    expect(idxForward).toBeGreaterThan(idxGuard);
  });
});
