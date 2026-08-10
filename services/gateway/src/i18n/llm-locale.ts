// LLM locale-injection utility for the gateway.
//
// When a gateway service calls an LLM on behalf of a user, the LLM defaults
// to English unless the system prompt explicitly directs otherwise. This
// module enforces that every AI-generation path through gateway services
// injects a language directive at the top of the system prompt.
//
// Companion to:
//   - services/gateway/src/i18n/server-locale.ts (getUserLocale + bulk)
//   - services/gateway/src/i18n/catalog.ts       (static-string catalog)
//   - supabase/functions/_shared/llm-locale.ts   (edge-function mirror)
//
// Usage:
//
//   import { buildLocalizedSystemPrompt } from '../i18n/llm-locale';
//   import { getUserLocale } from '../i18n/server-locale';
//
//   const locale = await getUserLocale(supa, userId);
//   const systemPrompt = buildLocalizedSystemPrompt(
//     `You are an expert health coach...`,
//     locale,
//   );

import { resolveLocaleStrict, type GatewayLocale } from './catalog';

// Mirrors supabase/functions/_shared/llm-locale.ts in vitana-v1. Keep the two
// in sync — they are the same directive delivered by two runtimes, and a
// locale present in one but not the other means the same user gets their own
// language from an edge function and English from the gateway.
const LANGUAGE_NAMES: Record<GatewayLocale, string> = {
  de: 'German (Deutsch)',
  en: 'English',
  es: 'Spanish (Español)',
  sr: 'Serbian (Srpski)',
  fr: 'French (Français)',
  pt: 'Portuguese (Português)',
  ru: 'Russian (Русский)',
  pl: 'Polish (Polski)',
  // Simplified named explicitly: script is a separate axis from language, and
  // an LLM told only "Chinese" may answer in Traditional, which is wrong for
  // zh-CN and which no register or coverage check would notice.
  zh: 'Simplified Chinese (简体中文)',
};

// Per-language register hints. Friendly informal tone, mirrors the brand voice.
// The brand voice is informal in EVERY language. A locale missing from this
// map gets no register directive, and LLMs default to the formal register for
// most European languages — so a merely-translated locale still reads like a
// bank letter next to the German original.
const REGISTER_HINTS: Partial<Record<GatewayLocale, string>> = {
  de: 'Use du-form (informal "du"), NOT Sie-form. The brand voice is informal and friendly.',
  sr: 'Use ti-form (informal), NOT Vi-form. Friendly, casual register.',
  es: 'Use tú-form (informal), NOT usted. Friendly tone.',
  fr: 'Use tu-form (tutoyer), NOT vous. Friendly tone.',
  pt: 'Use tu-form (European Portuguese informal), NOT você or o/a senhor(a). Friendly tone.',
  ru: 'Use ты-form (informal), NOT вы-form. Friendly, casual register.',
  pl: 'Use ty-form (informal), NOT Pan/Pani. Friendly, casual register.',
  // Chinese marks register with a pronoun CHARACTER rather than verb form, so
  // the instruction names the characters. Simplified is restated here because
  // this hint is appended to the language directive and an LLM drifting to
  // Traditional mid-response is the failure this pair of lines prevents.
  zh: 'Use 你/你的 (ordinary second person), NOT the polite 您. Write in Simplified Chinese only. Friendly, direct register.',
};

// Per-language compound-word rules (German is the only language with this
// problem at the platform scale we see, but the hook is here for others).
const COMPOUND_RULE: Partial<Record<GatewayLocale, string>> = {
  de: 'Avoid single words longer than 22 characters. For compounds that would exceed that, insert a hyphen at the natural compound boundary (e.g. "Benachrichtigungs-Einstellungen" not "Benachrichtigungseinstellungen") so they fit narrow mobile layouts.',
};

/**
 * Prepend a language directive to a system prompt.
 *
 * If `locale` is provided, returns a prompt that forces the LLM to respond
 * in the user's language with the right register and compound-word rules.
 * If `locale` is omitted, returns the prompt unchanged (use for paths that
 * are intentionally English, e.g. admin or developer tooling).
 */
export function buildLocalizedSystemPrompt(
  basePrompt: string,
  locale: GatewayLocale | null | undefined,
): string {
  if (!locale) return basePrompt;
  const languageName = LANGUAGE_NAMES[locale] ?? 'German (Deutsch)';
  const registerLine = REGISTER_HINTS[locale] ? `\n- ${REGISTER_HINTS[locale]}` : '';
  const compoundLine = COMPOUND_RULE[locale] ? `\n- ${COMPOUND_RULE[locale]}` : '';
  return `LANGUAGE: Respond ONLY in ${languageName}.
- Every word, label, heading, list item, and example in your response must be in ${languageName}.
- Do NOT mix languages. Do NOT switch to English for technical terms unless they are universally-untranslated brand names (Vitana, MAXINA, OASIS).${registerLine}${compoundLine}

${basePrompt}`;
}

/**
 * Convenience helper for callers that pass an explicit `lang` short code
 * (the orb voice path style: 'de', 'en', 'sr', etc.) instead of a
 * GatewayLocale. Normalizes to the supported set and delegates.
 */
export function buildLocalizedSystemPromptForLang(
  basePrompt: string,
  lang: string | null | undefined,
): string {
  if (!lang) return basePrompt;
  const lower = lang.toLowerCase();
  // Resolve through the catalog so language WORDS ("Polish") and ISO codes
  // behave identically here and in tt(). Hand-rolling prefix checks again is
  // exactly how 'pt'/'pl' would silently become German — both start with "po".
  const resolved = resolveLocaleStrict(lower);
  if (!resolved) return basePrompt; // unsupported locale → don't constrain
  return buildLocalizedSystemPrompt(basePrompt, resolved);
}
