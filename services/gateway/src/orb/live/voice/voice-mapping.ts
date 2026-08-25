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

// VTID-03681 — `pt`/`pl` added. These Records are the CACHE-COLD safety nets;
// the live source of truth is the per-language `decision_policy` rows. That
// distinction decides whether editing this file does anything, so it is worth
// being exact: the seeded rows are per-language keys (`voice.live_language.de`
// and friends), and there is NO row for `pt` or `pl` — so `getValue()` returns
// the `defaultValue` below and these entries ARE what production uses. Adding
// a row later overrides them, which is the intended precedence.
//
// (The one key where that is NOT true is `voice.neural2.enabled_languages`,
// a single seeded ARRAY row that the fallback below cannot override — see the
// note on NEURAL2_ENABLED_LANGUAGES_FALLBACK.)
//
// Voices are Gemini prebuilt voices, which are language-agnostic — the voice
// speaks whatever the model emits. `pt`→Zephyr and `pl`→Despina match the
// pairing the frontend already uses for those locales (`GEMINI_VOICE_MAP` in
// vitana-v1's `useTextToSpeech.ts`: `pt-BR-Chirp3-HD-Zephyr`,
// `pl-PL-Chirp3-HD-Despina`), so a user hears the same voice identity across
// ORB and app TTS instead of two different ones for the same language. Both
// are otherwise unused here, so every language keeps a distinct voice.
const LIVE_LANGUAGE_VOICE_FALLBACKS: Record<string, string> = {
  en: 'Callirrhoe',
  de: 'Achernar',
  fr: 'Leda',
  es: 'Aoede',
  ar: 'Sulafat',
  zh: 'Laomedeia',
  sr: 'Vindemiatrix',
  ru: 'Gacrux',
  pt: 'Zephyr',
  pl: 'Despina',
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
  // VTID-03681. `pt` is pt-BR, not pt-PT — the catalog is Brazilian
  // (VTID-03577), and the same pin already exists on the Polly side
  // (`POLLY_VOICES.pt` → Camila/pt-BR). A pt-PT voice would read Brazilian
  // copy in the European variant: fluent, wrong, and nothing detects it.
  pt: { name: 'Kore', languageCode: 'pt-BR' },
  pl: { name: 'Kore', languageCode: 'pl-PL' },
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
  // VTID-03681. NOT on the live path today — `voice.neural2.enabled_languages`
  // (see below) excludes pt/pl, so `getNeural2TtsVoice` is never reached for
  // them. Added anyway, because the accessor ends `?? NEURAL2_TTS_VOICE_
  // FALLBACKS['en']`: the day someone widens that DB row, the omission would
  // not fail — it would read Portuguese text aloud with `en-US-Neural2-H`, in
  // fluent English. That is the exact defect VTID-03578 fixed in `polly.ts`
  // (`?? POLLY_VOICES['en']`), and leaving the same trap armed one table over
  // would be repeating it knowingly.
  //
  // Wavenet rather than Neural2 for both: it is the tier the other
  // non-flagship languages here already use (ar/zh/ru), so it is the
  // conservative choice for voice ids this session could not verify against
  // the live Cloud TTS API.
  pt: { name: 'pt-BR-Wavenet-A', languageCode: 'pt-BR' },
  pl: { name: 'pl-PL-Wavenet-A', languageCode: 'pl-PL' },
};

// VTID-03681 — deliberately NOT widened to pt/pl, and this one is different
// from every other table in this file: `voice.neural2.enabled_languages` is a
// single seeded `decision_policy` ARRAY row, so the DB value WINS and editing
// this fallback would change nothing in production while looking like it had.
//
// Leaving pt/pl out routes them to `getGeminiTtsVoice()` instead, which is the
// better default anyway — it needs no additional Google Cloud TTS voices at a
// moment when the direction of travel is off Google entirely (§2c).
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
