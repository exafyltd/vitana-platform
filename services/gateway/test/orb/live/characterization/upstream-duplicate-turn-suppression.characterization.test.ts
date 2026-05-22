/**
 * VTID-03143 — duplicate-turn audio suppression.
 *
 * User report: Gemini Live sometimes repeats the same response twice
 * (occasionally three times) — especially when given a long Say-exactly
 * directive like our locked teacher_intro_de/en scripts. The user hears
 * the same intro multiple times before the conversation can move on.
 *
 * This file locks the structural contract of the anti-duplicate filter
 * in services/gateway/src/orb/live/session/upstream-message-handler.ts:
 *
 *   - On every output_transcription chunk, accumulate into the session
 *     buffer. Once we have >= 30 chars, compare the normalized prefix
 *     to the last few completed assistant transcripts
 *     (session.recentAssistantTexts, capped at 3).
 *   - If the prefix matches any recent turn's prefix → flip
 *     session.suppressCurrentTurnAudio = true.
 *   - All subsequent audio chunks for this turn are DROPPED (the early
 *     ~30 chars already reached the client; the rest of the duplicate
 *     does not).
 *   - At turn_complete: the just-completed transcript is pushed onto
 *     recentAssistantTexts (ring buffer of 3) IFF the turn was NOT
 *     suppressed (otherwise we'd keep a suppressed duplicate as a
 *     comparison anchor and feedback-loop the suppression). Flag +
 *     counter reset.
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

describe('VTID-03143: duplicate-turn audio suppression', () => {
  it('audio-chunk path checks session.suppressCurrentTurnAudio BEFORE forwarding', () => {
    // The suppression check must be in the same block that calls
    // onAudioResponse — otherwise a duplicate would still reach the
    // client through onAudioResponse.
    expect(src).toMatch(/suppressCurrentTurnAudio === true/);
    expect(src).toMatch(/currentTurnAudioChunksDropped/);
    // The "else { ctx.callbacks.onAudioResponse(audioB64); }" branch
    // proves we only forward when suppression is off.
    expect(src).toMatch(/\}\s*else\s*\{\s*ctx\.callbacks\.onAudioResponse\(audioB64\);\s*\}/);
  });

  it('output_transcription handler compares prefix to session.recentAssistantTexts', () => {
    expect(src).toMatch(/recentAssistantTexts/);
    expect(src).toMatch(/SUPPRESS_PREFIX_CHARS\s*=\s*30/);
    // Prefix normalization: lowercase, strip non-letter/digit/space,
    // collapse whitespace, trim. Locks the canonical comparison so a
    // refactor can't accidentally weaken it.
    expect(src).toMatch(/toLowerCase\(\)\.replace\(\/\[\^\\p\{L\}\\p\{N\} \]\+\/gu, ' '\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)/);
  });

  it('detection emits [VTID-03143] log + diag event', () => {
    expect(src).toMatch(/\[VTID-03143\] Duplicate turn detected/);
    expect(src).toMatch(/duplicate_turn_detected/);
  });

  it('turn_complete snapshots the transcript into recentAssistantTexts ring buffer (capped at 3)', () => {
    // Snapshot only happens when the turn was NOT suppressed (otherwise
    // we'd feedback-loop the suppression flag forever).
    expect(src).toMatch(/recent\.push\(completedTranscript\)/);
    // Ring-buffer cap.
    expect(src).toMatch(/while\s*\(recent\.length\s*>\s*3\)\s*recent\.shift\(\)/);
  });

  it('turn_complete does NOT snapshot a suppressed (duplicate) turn', () => {
    // The snapshot line `recent.push(completedTranscript)` must live in
    // the `else if (completedTranscript.length >= 30)` branch — i.e.
    // AFTER the `if (wasSuppressed)` guard returns / logs only.
    const block = src.match(/const wasSuppressed[\s\S]+?suppressCurrentTurnAudio\s*=\s*false;\s*\n\s+\(session as any\)\.currentTurnAudioChunksDropped\s*=\s*0;/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/if\s*\(wasSuppressed\)/);
    expect(block![0]).toMatch(/else if\s*\(completedTranscript\.length\s*>=\s*30\)/);
  });

  it('turn_complete resets suppressCurrentTurnAudio + chunk counter', () => {
    expect(src).toMatch(/suppressCurrentTurnAudio\s*=\s*false;/);
    expect(src).toMatch(/currentTurnAudioChunksDropped\s*=\s*0;/);
  });

  it('suppression diag emitted at turn_complete when it fired', () => {
    expect(src).toMatch(/duplicate_turn_suppressed_at_complete/);
    expect(src).toMatch(/dropped_chunks/);
  });
});
