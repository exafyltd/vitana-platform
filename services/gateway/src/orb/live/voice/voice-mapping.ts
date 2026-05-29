// Phase D.3.b-e (decision-contract refactor) — VTID-03134.
//
// Voice mapping table resolvers. Externalizes the remaining 4 Records
// that previously lived inline in `routes/orb-live.ts`:
//   - LIVE_LANGUAGE_VOICES       → getLiveLanguageVoice(lang)
//   - GEMINI_TTS_VOICES          → getGeminiTtsVoice(lang)
//   - NEURAL2_TTS_VOICES         → getNeural2TtsVoice(lang)
//   - NEURAL2_ENABLED_LANGUAGES  → getNeural2EnabledLanguages() + isNeural2EnabledFor(lang)
//
// Behaviour preserved byte-for-byte at cache-cold. The literal Records
// below are the safety nets that match the Phase D.3.b-e seed values
// in the corresponding `decision_policy` rows.

import { getPolicyResolver } from '../../../services/decision-contract/policy-resolver';
import { POLICY_KEYS } from '../../../services/decision-contract/policy-keys';

export interface TtsVoiceConfig {
  name: string;
  languageCode: string;
}

// =============================================================================
// Cache-cold safety-net Records
// =============================================================================

const LIVE_LANGUAGE_VOICE_FALLBACKS: Record<string, string> = {
  en: 'Callirrhoe',
  de: 'Achernar',
  fr: 'Leda',
  es: 'Aoede',
  ar: 'Sulafat',
  zh: 'Laomedeia',
  sr: 'Vindemiatrix',
  ru: 'Gacrux',
};

const GEMINI_TTS_VOICE_FALLBACKS: Record<string, TtsVoiceConfig> = {
  en: { name: 'Kore', languageCode: 'en-US' },
  de: { name: 'Kore', languageCode: 'de-DE' },
  fr: { name: 'Kore', languageCode: 'fr-FR' },
  es: { name: 'Kore', languageCode: 'es-ES' },
  ar: { name: 'Kore', languageCode: 'ar-XA' },
  zh: { name: 'Kore', languageCode: 'cmn-CN' },
  sr: { name: 'Kore', languageCode: 'sr-RS' },
  ru: { name: 'Kore', languageCode: 'ru-RU' },
};

const NEURAL2_TTS_VOICE_FALLBACKS: Record<string, TtsVoiceConfig> = {
  de: { name: 'de-DE-Neural2-G', languageCode: 'de-DE' },
  en: { name: 'en-US-Neural2-H', languageCode: 'en-US' },
  fr: { name: 'fr-FR-Neural2-A', languageCode: 'fr-FR' },
  es: { name: 'es-ES-Neural2-A', languageCode: 'es-ES' },
  ar: { name: 'ar-XA-Wavenet-D', languageCode: 'ar-XA' },
  zh: { name: 'cmn-CN-Wavenet-A', languageCode: 'cmn-CN' },
  ru: { name: 'ru-RU-Wavenet-A', languageCode: 'ru-RU' },
  sr: { name: 'sr-RS-Standard-A', languageCode: 'sr-RS' },
};

const NEURAL2_ENABLED_LANGUAGES_FALLBACK: ReadonlyArray<string> = [
  'en', 'de', 'fr', 'es', 'ar', 'zh', 'ru', 'sr',
];

// =============================================================================
// Accessors
// =============================================================================

export function getLiveLanguageVoice(lang: string): string {
  const safeLang = typeof lang === 'string' && lang.length > 0 ? lang : 'en';
  const fallback = LIVE_LANGUAGE_VOICE_FALLBACKS[safeLang] ?? LIVE_LANGUAGE_VOICE_FALLBACKS['en'];
  return getPolicyResolver().getValue<string>(
    `voice.live_language.${safeLang}`,
    { defaultValue: fallback },
  );
}

export function getGeminiTtsVoice(lang: string): TtsVoiceConfig {
  const safeLang = typeof lang === 'string' && lang.length > 0 ? lang : 'en';
  const fallback =
    GEMINI_TTS_VOICE_FALLBACKS[safeLang] ?? GEMINI_TTS_VOICE_FALLBACKS['en'];
  return getPolicyResolver().getValue<TtsVoiceConfig>(
    `voice.gemini_tts.${safeLang}`,
    { defaultValue: fallback },
  );
}

export function getNeural2TtsVoice(lang: string): TtsVoiceConfig {
  const safeLang = typeof lang === 'string' && lang.length > 0 ? lang : 'en';
  const fallback =
    NEURAL2_TTS_VOICE_FALLBACKS[safeLang] ?? NEURAL2_TTS_VOICE_FALLBACKS['en'];
  return getPolicyResolver().getValue<TtsVoiceConfig>(
    `voice.neural2_tts.${safeLang}`,
    { defaultValue: fallback },
  );
}

export function getNeural2EnabledLanguages(): ReadonlyArray<string> {
  const out = getPolicyResolver().getValue<ReadonlyArray<string>>(
    POLICY_KEYS.VOICE_NEURAL2_ENABLED_LANGUAGES,
    { defaultValue: NEURAL2_ENABLED_LANGUAGES_FALLBACK },
  );
  // Defensive guard: if a malformed DB row sneaks through, return the
  // safety net rather than risk an `includes` call on a non-array.
  return Array.isArray(out) ? out : NEURAL2_ENABLED_LANGUAGES_FALLBACK;
}

export function isNeural2EnabledFor(lang: string): boolean {
  return getNeural2EnabledLanguages().includes(lang);
}
