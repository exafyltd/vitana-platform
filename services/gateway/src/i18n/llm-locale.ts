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

import type { GatewayLocale } from './catalog';

// Mirrors the edge-function names + adds the languages the catalog supports.
const LANGUAGE_NAMES: Record<GatewayLocale, string> = {
  de: 'German (Deutsch)',
  en: 'English',
  sr: 'Serbian (Srpski)',
  es: 'Spanish (Español)',
};

// Per-language register hints. Friendly informal tone, mirrors the brand voice.
const REGISTER_HINTS: Partial<Record<GatewayLocale, string>> = {
  de: 'Use du-form (informal "du"), NOT Sie-form. The brand voice is informal and friendly.',
  sr: 'Use ti-form (informal), NOT Vi-form. Friendly, casual register.',
  es: 'Use tú-form (informal), NOT usted. Friendly tone.',
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
  if (lower.startsWith('de')) return buildLocalizedSystemPrompt(basePrompt, 'de');
  if (lower.startsWith('en')) return buildLocalizedSystemPrompt(basePrompt, 'en');
  if (lower.startsWith('sr')) return buildLocalizedSystemPrompt(basePrompt, 'sr');
  if (lower.startsWith('es')) return buildLocalizedSystemPrompt(basePrompt, 'es');
  return basePrompt; // unsupported locale → don't constrain
}
