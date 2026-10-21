// VTID-03134 — Phase D.3.b-e of the decision-contract refactor.
//
// Locks the contract for the 4 voice-mapping accessors that replaced
// the inline Records in orb-live.ts. Byte-identical fallback parity
// + resolver-seeded overrides + protocol shape for the Neural2-enabled
// array case.

import {
  getLiveLanguageVoice,
  getGeminiTtsVoice,
  getNeural2TtsVoice,
  getNeural2EnabledLanguages,
  isNeural2EnabledFor,
} from '../../../../src/orb/live/voice/voice-mapping';
import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
} from '../../../../src/services/decision-contract/policy-resolver';

const NOW_ISO = new Date().toISOString();

function seed(key: string, value: unknown) {
  configurePolicyResolverForTests({
    decisionPolicy: [
      {
        policy_key: key,
        tenant_id: null,
        version: 1,
        value_json: value,
        effective_from: NOW_ISO,
        effective_until: null,
      },
    ],
  });
}

describe('VTID-03134 Phase D.3.b-e voice mapping accessors', () => {
  afterEach(() => {
    __resetPolicyResolverForTests();
  });

  describe('cold-cache fallback parity (byte-identical to pre-D.3.b-e Records)', () => {
    beforeEach(() => {
      __resetPolicyResolverForTests();
    });

    it('LIVE_LANGUAGE_VOICES — getLiveLanguageVoice across 8 langs', () => {
      expect(getLiveLanguageVoice('en')).toBe('Callirrhoe');
      expect(getLiveLanguageVoice('de')).toBe('Achernar');
      expect(getLiveLanguageVoice('fr')).toBe('Leda');
      expect(getLiveLanguageVoice('es')).toBe('Aoede');
      expect(getLiveLanguageVoice('ar')).toBe('Sulafat');
      expect(getLiveLanguageVoice('zh')).toBe('Laomedeia');
      expect(getLiveLanguageVoice('sr')).toBe('Vindemiatrix');
      expect(getLiveLanguageVoice('ru')).toBe('Gacrux');
    });

    it('GEMINI_TTS_VOICES — getGeminiTtsVoice returns {name, languageCode}', () => {
      expect(getGeminiTtsVoice('en')).toEqual({ name: 'Kore', languageCode: 'en-US' });
      expect(getGeminiTtsVoice('de')).toEqual({ name: 'Kore', languageCode: 'de-DE' });
      expect(getGeminiTtsVoice('fr')).toEqual({ name: 'Kore', languageCode: 'fr-FR' });
      expect(getGeminiTtsVoice('es')).toEqual({ name: 'Kore', languageCode: 'es-ES' });
      expect(getGeminiTtsVoice('ar')).toEqual({ name: 'Kore', languageCode: 'ar-XA' });
      expect(getGeminiTtsVoice('zh')).toEqual({ name: 'Kore', languageCode: 'cmn-CN' });
      expect(getGeminiTtsVoice('sr')).toEqual({ name: 'Kore', languageCode: 'sr-RS' });
      expect(getGeminiTtsVoice('ru')).toEqual({ name: 'Kore', languageCode: 'ru-RU' });
    });

    it('NEURAL2_TTS_VOICES — Neural2/WaveNet/Standard fallback chain preserved', () => {
      expect(getNeural2TtsVoice('de').name).toBe('de-DE-Neural2-G');
      expect(getNeural2TtsVoice('en').name).toBe('en-US-Neural2-H');
      expect(getNeural2TtsVoice('fr').name).toBe('fr-FR-Neural2-A');
      expect(getNeural2TtsVoice('es').name).toBe('es-ES-Neural2-A');
      expect(getNeural2TtsVoice('ar').name).toBe('ar-XA-Wavenet-D');
      expect(getNeural2TtsVoice('zh').name).toBe('cmn-CN-Wavenet-A');
      expect(getNeural2TtsVoice('ru').name).toBe('ru-RU-Wavenet-A');
      expect(getNeural2TtsVoice('sr').name).toBe('sr-RS-Standard-A');
    });

    it('NEURAL2_ENABLED_LANGUAGES — 8 supported langs', () => {
      const langs = getNeural2EnabledLanguages();
      expect(langs).toEqual(['en', 'de', 'fr', 'es', 'ar', 'zh', 'ru', 'sr']);
    });

    it('isNeural2EnabledFor returns true for all 8 supported, false otherwise', () => {
      for (const l of ['en', 'de', 'fr', 'es', 'ar', 'zh', 'ru', 'sr']) {
        expect(isNeural2EnabledFor(l)).toBe(true);
      }
      expect(isNeural2EnabledFor('jp')).toBe(false);
      expect(isNeural2EnabledFor('')).toBe(false);
    });

    it('unknown lang defaults to en safely (no throw)', () => {
      expect(getLiveLanguageVoice('jp')).toBe('Callirrhoe');
      expect(getGeminiTtsVoice('jp').name).toBe('Kore');
      expect(getNeural2TtsVoice('jp').name).toBe('en-US-Neural2-H');
    });
  });

  describe('resolver-seeded path — DB row wins', () => {
    it('seeded voice.live_language.<lang> overrides fallback', () => {
      seed('voice.live_language.de', 'NewGermanVoice');
      expect(getLiveLanguageVoice('de')).toBe('NewGermanVoice');
    });

    it('seeded voice.gemini_tts.<lang> overrides fallback (JSON shape)', () => {
      seed('voice.gemini_tts.en', { name: 'Aoede', languageCode: 'en-GB' });
      expect(getGeminiTtsVoice('en')).toEqual({ name: 'Aoede', languageCode: 'en-GB' });
    });

    it('seeded voice.neural2_tts.<lang> overrides fallback', () => {
      seed('voice.neural2_tts.fr', { name: 'fr-FR-Studio-A', languageCode: 'fr-FR' });
      expect(getNeural2TtsVoice('fr').name).toBe('fr-FR-Studio-A');
    });

    it('seeded voice.neural2.enabled_languages array overrides fallback', () => {
      seed('voice.neural2.enabled_languages', ['en', 'de']);
      expect(getNeural2EnabledLanguages()).toEqual(['en', 'de']);
      expect(isNeural2EnabledFor('en')).toBe(true);
      expect(isNeural2EnabledFor('fr')).toBe(false);
    });
  });

  describe('defensive', () => {
    it('malformed enabled_languages row (not an array) falls back to literal', () => {
      seed('voice.neural2.enabled_languages', 'oops_not_an_array' as unknown);
      // Defensive guard returns the safety net.
      expect(getNeural2EnabledLanguages()).toEqual(['en', 'de', 'fr', 'es', 'ar', 'zh', 'ru', 'sr']);
    });
  });
});
