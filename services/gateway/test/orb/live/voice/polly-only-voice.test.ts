/**
 * VTID-03641 — `needsPollyOnlyVoice`: languages with no native
 * speech-to-speech voice on Nova Sonic OR Vertex/Gemini Live's fallback.
 *
 * Picking either `pt` or `pl` on ORB Live used to silently answer the user
 * in fluent English (Vertex's `getLiveLanguageVoice` falls back to the `en`
 * voice for an unmapped language). This predicate is what gates the
 * Nova+Polly bypass that replaces that silent failure — see
 * upstream-provider-selector.ts's `nova_polly_only_voice` reason and
 * upstream-message-handler.ts's `deliverPollyOnlyTurnAudio`.
 */

import { needsPollyOnlyVoice } from '../../../../src/orb/live/voice/polly-only-voice';

describe('VTID-03641 needsPollyOnlyVoice', () => {
  it('is true for pt (no Nova voice, no Vertex fallback voice)', () => {
    expect(needsPollyOnlyVoice('pt')).toBe(true);
    expect(needsPollyOnlyVoice('pt-BR')).toBe(true);
  });

  it('is true for pl (no Nova voice, no Vertex fallback voice)', () => {
    expect(needsPollyOnlyVoice('pl')).toBe(true);
    expect(needsPollyOnlyVoice('pl-PL')).toBe(true);
  });

  it('is false for every Nova-supported language', () => {
    for (const lang of ['en', 'de', 'fr', 'es']) {
      expect(needsPollyOnlyVoice(lang)).toBe(false);
    }
  });

  it('is false for a language with a Vertex fallback voice even though Nova cannot speak it', () => {
    // ru/ar/zh/sr all have a LIVE_LANGUAGE_VOICE_FALLBACKS entry — they are
    // outside Nova's canary set but NOT in the "no voice anywhere" class this
    // predicate targets. (ru was demoted alongside pt/pl in the frontend
    // picker for a separate UX-consistency reason — VTID-03640 — not because
    // its voice is missing.)
    for (const lang of ['ru', 'ar', 'zh', 'sr']) {
      expect(needsPollyOnlyVoice(lang)).toBe(false);
    }
  });

  it('is case- and region-tag-insensitive, matching isNovaSonicLanguageSupported', () => {
    expect(needsPollyOnlyVoice('PT')).toBe(true);
    expect(needsPollyOnlyVoice('Pt-PT')).toBe(true);
    expect(needsPollyOnlyVoice('pt_BR')).toBe(true);
  });

  it('is false for null/undefined/empty — no language to gate on', () => {
    expect(needsPollyOnlyVoice(undefined)).toBe(false);
    expect(needsPollyOnlyVoice(null)).toBe(false);
    expect(needsPollyOnlyVoice('')).toBe(false);
  });

  it('is true for an entirely unknown future language code (fails safe, not fails open)', () => {
    // A locale added to the picker with no voice wired anywhere must gate to
    // Polly-only rather than silently inheriting Vertex's English fallback —
    // this is the whole-class fix, not a pt/pl special case.
    expect(needsPollyOnlyVoice('it')).toBe(true);
    expect(needsPollyOnlyVoice('nl')).toBe(true);
  });
});
