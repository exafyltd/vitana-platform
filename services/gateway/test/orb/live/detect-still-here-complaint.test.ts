/**
 * VTID-03824 (second follow-up) — detectStillHereComplaint().
 *
 * Live evidence (a real staging session, read directly from oasis_events,
 * session live-2dafffa5-fe05-4ad7-8294-53803185549d) showed the model
 * never calling end_conversation across 5 turns despite the user saying
 * "du bist immer noch da" TWICE — even though the repositioned RULE 0
 * override instruction (the first follow-up to this VTID) was confirmed
 * present and correctly placed in that session's own rendered system
 * instruction. This is a deterministic, code-level backstop rather than a
 * third round of prompt wording, matching this repo's established remedy
 * for a model-compliance gap that keeps recurring (VTID-03650).
 *
 * These tests pin the regex's precision: it must catch the exact reported
 * phrasings (EN + DE, matching both screenshots) while staying silent on
 * ambiguous phrases like "let's talk later" that should NOT force-end a
 * session — a user saying "you're still here" only ever means the
 * assistant already failed to leave/stop once; nobody says it as an
 * invitation to keep talking.
 */

import { detectStillHereComplaint } from '../../../src/routes/orb-live';

describe('VTID-03824: detectStillHereComplaint', () => {
  describe('matches the exact reported live phrasings', () => {
    const positives = [
      // German — screenshot 1 (session live-1a258a4e...)
      'du bist ja noch da',
      // German — screenshot 2 (session live-2dafffa5...), said TWICE
      'du bist immer noch da',
      // Bare "bist du" question form
      'bist du noch da',
      'bist du immer noch da',
      // English equivalents
      "you're still here",
      'you are still here',
      'you are still there',
      "you're still there",
    ];

    it.each(positives)('detects: %j', (text) => {
      expect(detectStillHereComplaint(text)).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(detectStillHereComplaint('DU BIST IMMER NOCH DA')).toBe(true);
      expect(detectStillHereComplaint("YOU'RE STILL HERE")).toBe(true);
    });

    it('matches mid-sentence, not just as the whole utterance', () => {
      expect(detectStillHereComplaint('hallo, du bist immer noch da?')).toBe(true);
      expect(detectStillHereComplaint("wait, you're still here?")).toBe(true);
    });
  });

  describe('does NOT match ambiguous phrases that should not force-end a session', () => {
    const negatives = [
      // A legitimate pause request — not a complaint about a failed close.
      'nee danke lass uns später sprechen ich will gerade nicht',
      "let's talk later",
      'ich will gerade nicht sprechen lass uns später reden',
      // An explicit but FIRST-time stop request — the model should still
      // be given the chance to comply via the prompt-level instruction;
      // this backstop only fires on the unambiguous repeat-complaint.
      "that's enough",
      'du kannst jetzt ausschalten',
      'ich will dass du gehst lass mich in ruhe',
      // Ordinary conversation containing "here"/"da" with no stop context.
      'ich bin gerade nicht zuhause',
      'is anyone here',
      'here we go',
    ];

    it.each(negatives)('does not flag: %j', (text) => {
      expect(detectStillHereComplaint(text)).toBe(false);
    });
  });

  it('handles empty/whitespace-only input without throwing', () => {
    expect(detectStillHereComplaint('')).toBe(false);
    expect(detectStillHereComplaint('   ')).toBe(false);
  });
});
