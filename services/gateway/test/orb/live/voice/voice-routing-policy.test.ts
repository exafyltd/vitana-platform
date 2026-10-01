/**
 * VTID-03704 — the two standing voice rules, asserted as rules rather than as
 * a list of current values.
 *
 *   1. Anything Nova does not cover goes to the Polly cascade. The one
 *      exception is Serbian, which stays on Nova because Polly has no Serbian
 *      voice in any engine — so cascading it would route it somewhere that
 *      also fails.
 *   2. Vitana speaks with a FEMALE voice in every language, and the persona
 *      does not change that. Persona-selected voices are what made the voice
 *      differ before and after sign-in (an anonymous session carries no
 *      persona), which is how the defect was reported.
 *
 * These are written as invariants over the language sets, not as hardcoded
 * expectations per language: adding a language to Nova, or to Transcribe, or
 * to Polly, must keep the rules true without anyone remembering to edit a
 * literal here. The sibling suites already pin the per-language values.
 */

import {
  NOVA_SONIC_SUPPORTED_LANGUAGES,
  isNovaSonicLanguageSupported,
} from '../../../../src/orb/live/upstream/nova-sonic-config';
import {
  evaluateCascadeEligibility,
  listCascadeLanguages,
} from '../../../../src/orb/live/upstream/cascaded-config';
import {
  resolveNovaSonicVoice,
  resolveNovaSonicVoiceOrFallback,
} from '../../../../src/orb/live/voice/nova-sonic-voice';

/** Every language the product ships or is preparing to ship. */
const ALL_LANGUAGES = ['de', 'en', 'es', 'fr', 'pt', 'pl', 'ru', 'sr', 'ar', 'zh', 'tr'];

/** Polly has no Serbian voice in any engine (verified against the live API). */
const NO_POLLY_VOICE = ['sr'];

describe('VTID-03704: voice routing policy', () => {
  describe('rule 1 — not on Nova means Polly, except Serbian', () => {
    it('routes every non-Nova language to the cascade unless Polly cannot voice it', () => {
      const cascaded = new Set(listCascadeLanguages());
      for (const lang of ALL_LANGUAGES) {
        if (isNovaSonicLanguageSupported(lang)) continue;
        if (NO_POLLY_VOICE.includes(lang)) {
          expect(cascaded.has(lang)).toBe(false);
        } else {
          // The assertion that matters: no language is left with neither a
          // Nova seat nor a Polly seat.
          expect(cascaded.has(lang)).toBe(true);
        }
      }
    });

    it('never cascades a language Nova already speaks — speech-to-speech wins', () => {
      for (const lang of NOVA_SONIC_SUPPORTED_LANGUAGES) {
        const verdict = evaluateCascadeEligibility(lang);
        expect(verdict.eligible).toBe(false);
        expect(verdict.reason).toBe('nova_supports_natively');
      }
    });

    it('keeps Serbian on Nova and blames Polly, the blocker that is real', () => {
      // Serbian must NOT silently become "unsupported everywhere". It stays on
      // Nova via the documented substitute voice.
      expect(evaluateCascadeEligibility('sr').eligible).toBe(false);
      expect(resolveNovaSonicVoiceOrFallback({ language: 'sr' }).fallback).toBe(true);
      expect(resolveNovaSonicVoiceOrFallback({ language: 'sr' }).voice).toBeTruthy();
    });

    it('leaves no language with no route at all', () => {
      const cascaded = new Set(listCascadeLanguages());
      for (const lang of ALL_LANGUAGES) {
        const onNova = isNovaSonicLanguageSupported(lang);
        const onCascade = cascaded.has(lang);
        const novaFallback = !onNova && !onCascade;
        // Either Nova speaks it, or the cascade does, or it is a known
        // Polly-less language riding Nova's substitute voice. Anything else is
        // a language with nowhere to go.
        expect(onNova || onCascade || (novaFallback && NO_POLLY_VOICE.includes(lang))).toBe(true);
      }
    });
  });

  describe('rule 1b — rerouting a language must not change how it SOUNDS', () => {
    // `tryCascadeRescue()` returns null unless ORB_CASCADED_VOICE_ENABLED is
    // exactly 'true', so between this landing and the cascade's IAM being
    // granted, every cascade-routed language still transits Nova via
    // `nova_forced_vertex_unavailable`. Moving a language OUT of Nova's
    // routing set therefore must not empty its voice entry — an earlier draft
    // of VTID-03704 did exactly that and put `tina` (German) on Portuguese,
    // which is worse than the bug it was fixing.
    it('keeps a real Nova voice for a cascade-routed language Nova can still voice', () => {
      const pt = resolveNovaSonicVoiceOrFallback({ language: 'pt' });
      expect(pt.fallback).toBe(false);
      expect(pt.voice).not.toBe(resolveNovaSonicVoiceOrFallback({ language: 'de' }).voice);
    });

    it('only reports a substitution when Nova genuinely has no voice', () => {
      // ru/pl/ar/zh/sr are absent from Nova's voice table entirely, so a
      // substitution here is honest. Anything else reporting fallback=true
      // means a voice entry was dropped, not that Nova lacks the voice.
      for (const lang of ['ru', 'pl', 'ar', 'zh', 'sr', 'tr']) {
        expect(resolveNovaSonicVoiceOrFallback({ language: lang }).fallback).toBe(true);
      }
      for (const lang of ['en', 'de', 'fr', 'es', 'pt']) {
        expect(resolveNovaSonicVoiceOrFallback({ language: lang }).fallback).toBe(false);
      }
    });
  });

  // VTID-04445 — rule 2 changed at the owner's instruction: Vitana speaks
  // with a woman's voice and Devon with a man's voice, in every language.
  // The pre/post-login parity VTID-03704 protected still holds: a new session
  // is always Vitana (anonymous or signed-in) — only a hand-off inside a
  // session makes Devon the speaker.
  describe('rule 2 — Vitana female, Devon male, every language', () => {
    const FEMALE = ['amy', 'tina', 'ambre', 'lupe', 'carolina'];
    const MALE = ['matthew', 'lennart', 'florian', 'carlos', 'leo'];

    it('Vitana and the anonymous (persona-less) case resolve the same female voice', () => {
      for (const lang of ALL_LANGUAGES) {
        const anonymous = resolveNovaSonicVoiceOrFallback({ language: lang }).voice;
        const vitana = resolveNovaSonicVoiceOrFallback({ language: lang, persona: 'vitana' }).voice;
        expect(anonymous).toBe(vitana);
        expect(FEMALE).toContain(vitana);
      }
    });

    it('Devon resolves a male voice in every language, fallback included', () => {
      for (const lang of ALL_LANGUAGES) {
        expect(MALE).toContain(resolveNovaSonicVoiceOrFallback({ language: lang, persona: 'devon' }).voice);
      }
    });
  });
});
