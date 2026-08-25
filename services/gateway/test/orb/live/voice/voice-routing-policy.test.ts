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
const ALL_LANGUAGES = ['de', 'en', 'es', 'fr', 'pt', 'pl', 'ru', 'sr', 'ar', 'zh'];

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
      for (const lang of ['ru', 'pl', 'ar', 'zh', 'sr']) {
        expect(resolveNovaSonicVoiceOrFallback({ language: lang }).fallback).toBe(true);
      }
      for (const lang of ['en', 'de', 'fr', 'es', 'pt']) {
        expect(resolveNovaSonicVoiceOrFallback({ language: lang }).fallback).toBe(false);
      }
    });
  });

  describe('rule 2 — one female voice per language, persona-independent', () => {
    const PERSONAS = ['vitana', 'devon', 'atlas', 'sage', 'mira', 'unknown-persona', ''];

    it('resolves the same voice for every persona, in every Nova language', () => {
      for (const lang of NOVA_SONIC_SUPPORTED_LANGUAGES) {
        const voices = new Set(
          PERSONAS.map((persona) => resolveNovaSonicVoice({ language: lang, persona })),
        );
        // One distinct voice across all personas — this is the pre/post-login
        // parity guarantee stated as code.
        expect(voices.size).toBe(1);
      }
    });

    it('resolves the same voice with no persona at all — the anonymous case', () => {
      // An anonymous (pre-login) session passes no persona. If this ever
      // diverges from the signed-in result, the reported bug is back.
      for (const lang of NOVA_SONIC_SUPPORTED_LANGUAGES) {
        const anonymous = resolveNovaSonicVoice({ language: lang });
        const signedIn = resolveNovaSonicVoice({ language: lang, persona: 'devon' });
        expect(anonymous).toBe(signedIn);
      }
    });

    it('never resolves one of the retired masculine voice ids', () => {
      const RETIRED = ['lennart', 'florian', 'carlos', 'leo', 'matthew'];
      for (const lang of ALL_LANGUAGES) {
        for (const persona of PERSONAS) {
          const voice = resolveNovaSonicVoiceOrFallback({ language: lang, persona }).voice;
          expect(RETIRED).not.toContain(voice);
        }
      }
    });
  });
});
