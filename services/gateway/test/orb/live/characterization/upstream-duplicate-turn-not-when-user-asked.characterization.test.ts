/**
 * VTID-03637 — VTID-03143's duplicate-turn suppression must not fire when
 * the user just asked for the thing being delivered.
 *
 * Live report: "Vitana says 'Ich zeige dir die neusten Nachrichten' and
 * turns to listening mode — this makes no sense." Traced through real prod
 * telemetry (session live-79e7a500..., 2026-08-13): the greeting offered to
 * show the news feed, the user said "ja zeig sie mir" (yes, show me), and
 * the delivery turn's opening ~30 chars matched the greeting's opening
 * (both start "Ich zeige dir..."). VTID-03143's duplicate-turn detector —
 * built for Gemini re-emitting a scripted "Say-exactly" line verbatim and
 * unprompted — flagged this as a repeat and suppressed the rest of the
 * turn's audio (`duplicate_turn_suppressed_at_complete`, dropped_chunks:
 * 107), leaving the user with an orphaned promise and dead air.
 *
 * The detector never checked whether the user spoke between the two
 * matching turns. A promise-then-fulfillment exchange naturally shares an
 * opening clause and is not a repeat — the model is doing exactly what was
 * asked. Fix: gate the prefix-match check on `session.inputTranscriptBuffer`
 * being empty for the current turn, the same discriminator the sibling
 * `greeting_reemit_suppressed` check (same file) already uses for "the user
 * has not spoken yet". `inputTranscriptBuffer` isn't cleared until
 * turn_complete, so it still holds the current turn's user speech at the
 * point both duplicate-detection call sites run.
 *
 * Source characterization test (matches this repo's established pattern —
 * see upstream-duplicate-turn-suppression.characterization.test.ts, which
 * this file complements rather than replaces).
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

describe('VTID-03637: duplicate-turn suppression does not fire when the user spoke this turn', () => {
  it('both duplicate-turn-detection call sites gate on an empty inputTranscriptBuffer', () => {
    // Two call sites: the raw-WS handler and the Nova handleTranscript
    // mirror. Both must carry the guard — fixing only one leaves the other
    // provider transport exposed to the identical false positive.
    const guardPattern = /&&\s*\(session\.inputTranscriptBuffer \|\| ''\)\.trim\(\)\.length === 0/g;
    const matches = src.match(guardPattern) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('the guard sits in the SAME if-condition as the prefix-match trigger, not a separate check', () => {
    // A guard added elsewhere (e.g. only around the emitDiag call) would
    // still let suppressCurrentTurnAudio flip to true. Assert the two
    // duplicate-detection blocks (recent.length > 0 as the anchor) each
    // contain the inputTranscriptBuffer guard within the same block.
    const blocks = src.split('recent.length > 0');
    // First split part has no recent.length>0 above it; each subsequent
    // part starts right after one occurrence.
    const blocksWithGuardNearby = blocks.slice(1).filter((b) =>
      b.slice(0, 200).includes("inputTranscriptBuffer || '').trim().length === 0"),
    );
    expect(blocksWithGuardNearby.length).toBeGreaterThanOrEqual(2);
  });

  it('does not weaken the original suppression contract — SUPPRESS_PREFIX_CHARS and recentAssistantTexts checks are untouched', () => {
    // Regression guard: the fix must be additive (one more &&-clause), not
    // a rewrite of the existing matching logic pinned by the sibling
    // upstream-duplicate-turn-suppression.characterization.test.ts file.
    expect(src).toMatch(/SUPPRESS_PREFIX_CHARS\s*=\s*30/);
    expect(src).toMatch(/recentAssistantTexts/);
    expect(src).toMatch(/prevPrefix\.length >= 20 && prevPrefix === currentPrefix/);
  });
});
