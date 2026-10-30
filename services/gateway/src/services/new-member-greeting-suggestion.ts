/**
 * VTID-05207 — composes ONE "Say Hello 👋" greeting SUGGESTION for the member
 * who opened the composer on a newcomer's card.
 *
 * Plan `.kiro/specs/new-member-welcome/plan-sparring.md` Part B. The member
 * edits the suggestion and must press Send before anything is delivered — this
 * service only SUGGESTS, it never sends a DM.
 *
 * Claude on AWS Bedrock only (CLAUDE.md 10a–10c): the primary AND the fallback
 * are per-call Bedrock overrides, so the stage's stored policy can never route
 * this to Google or to the direct Anthropic API. The prompt is an English
 * intent (rule 41: no hardcoded user-facing sentence); the language and the
 * du-form come from the SENDER's locale via buildLocalizedSystemPromptForLang.
 *
 * Validation mirrors composer.ts: no links, no markdown, a length cap, the
 * right script for the sender's locale. An `avoid` list of suggestions already
 * offered this session lets "Try another" vary and never repeat. A failed or
 * invalid composition returns ok:false — the caller answers 503 and the member
 * can retry; there is no hardcoded template fallback.
 */
import { callViaRouter, type LLMRouterResult } from './llm-router';
import { buildLocalizedSystemPromptForLang } from '../i18n/llm-locale';
import { resolveLocaleStrict } from '../i18n/catalog';

const VTID = 'VTID-05207';
// The stage only labels telemetry here: both providers are overridden per call.
const STAGE = 'operator' as const;

export const GREETING_SUGGESTION_MAX_CHARS = 120;
/** Bedrock models, overridable by env; defaults mirror the companion composer. */
export const GREETING_SUGGESTION_MODEL =
  process.env.NEW_MEMBER_GREETING_SUGGESTION_MODEL || 'eu.anthropic.claude-sonnet-4-6';
export const GREETING_SUGGESTION_FALLBACK_MODEL =
  process.env.NEW_MEMBER_GREETING_SUGGESTION_FALLBACK_MODEL || 'eu.anthropic.claude-sonnet-4-6';

export const GREETING_SUGGESTION_BASE_PROMPT = [
  'You are helping a Vitanaland community member write a short, warm greeting to a NEW member who just joined the longevity community.',
  'Write ONE greeting the member can send as a private message, as if they were speaking.',
  'Rules:',
  '- One short sentence, at most 120 characters, plain text only: no markdown, no lists, no headings, no links.',
  '- Address the newcomer by their FIRST NAME only, exactly as given. Never invent or alter the name.',
  '- Warm, natural and casual, like: "Hi {name}, lovely to have you here!", "Welcome to MAXINA, {name}!", "Hey {name}, just stopping by to say hello!".',
  '- Vary the wording and sentence structure each time; do not reuse a greeting that was already offered.',
  '- NEVER invent familiarity or claim shared interests, shared history, or anything you do not actually know about the newcomer.',
  '- At most one emoji (a wave 👋 or a smile 😊 is fine). No hashtags, no @mentions.',
  '- Output the greeting sentence only, with no preamble, no quotation marks and no sign-off.',
].join('\n');

export type GreetingSuggestionResult =
  | { ok: true; suggestion: string; language: string; model: string }
  | { ok: false; error: string };

export type RouterCall = typeof callViaRouter;

export interface GreetingSuggestionInput {
  /** Newcomer's first name, already resolved by the caller (may be empty). */
  firstName: string | null | undefined;
  /** The sender's locale short code ('de', 'en', …) — governs output language. */
  senderLocale: string | null | undefined;
  /** Suggestions already offered this session, so "Try another" never repeats. */
  avoid?: ReadonlyArray<string>;
}

export function buildGreetingSuggestionPrompt(input: GreetingSuggestionInput): string {
  const name = (input.firstName ?? '').trim();
  const avoid = (input.avoid ?? [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .slice(0, 20);
  const lines = [
    `Newcomer first name: ${name || '(unknown — greet warmly without using a name)'}`,
  ];
  if (avoid.length > 0) {
    lines.push('Do NOT repeat or lightly reword any of these already-offered greetings:');
    for (const a of avoid) lines.push(`- ${a}`);
    lines.push('Produce a clearly different greeting (different opening word and structure).');
  }
  return lines.join('\n');
}

const SCRIPT_CHECK: Record<string, RegExp> = {
  ar: /[\u0600-\u06ff]/,
  zh: /[\u4e00-\u9fff]/,
  ru: /[\u0400-\u04ff]/,
  // Serbian is written in both scripts, so Latin or Cyrillic is accepted by design.
  sr: /[\u0400-\u04ff]|[a-z]/i,
};

/** Normalises a greeting that may have been offered before, for de-duping. */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…👋😊]+$/u, '').trim();
}

/** Returns the cleaned suggestion, or an error code when the output is unusable. */
export function validateGreetingSuggestion(
  raw: string | undefined,
  locale: string,
  avoid: ReadonlyArray<string> = [],
): { ok: true; text: string } | { ok: false; error: string } {
  const text = (raw ?? '').trim().replace(/^["“]|["”]$/g, '').trim();
  if (!text) return { ok: false, error: 'empty' };
  if (text.length > GREETING_SUGGESTION_MAX_CHARS) return { ok: false, error: 'too_long' };
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, error: 'contains_link' };
  if (/^\s*(#|[-*]\s|\d+\.\s)/m.test(text)) return { ok: false, error: 'contains_markdown' };
  if (/[#@]\w/.test(text)) return { ok: false, error: 'contains_tag' };
  if (text.includes('\n')) return { ok: false, error: 'multiline' };
  const script = SCRIPT_CHECK[locale.slice(0, 2)];
  if (script && !script.test(text)) return { ok: false, error: 'wrong_script' };
  const norm = normalize(text);
  if (avoid.some((a) => normalize(a) === norm)) return { ok: false, error: 'repeated' };
  return { ok: true, text };
}

export async function composeGreetingSuggestion(
  input: GreetingSuggestionInput,
  call: RouterCall = callViaRouter,
): Promise<GreetingSuggestionResult> {
  // The sender's locale drives the language of the suggestion. An unsupported
  // or missing locale falls back to the gateway default inside
  // buildLocalizedSystemPromptForLang; `language` reports what we resolved.
  const resolved = resolveLocaleStrict((input.senderLocale ?? '').toLowerCase());
  const language = resolved ?? 'en';

  let result: LLMRouterResult;
  try {
    result = await call(STAGE, buildGreetingSuggestionPrompt(input), {
      vtid: VTID,
      service: 'new-member-greeting-suggestion',
      systemPrompt: buildLocalizedSystemPromptForLang(GREETING_SUGGESTION_BASE_PROMPT, input.senderLocale),
      maxTokens: 120,
      providerOverride: 'bedrock',
      modelOverride: GREETING_SUGGESTION_MODEL,
      fallbackOverride: { provider: 'bedrock', model: GREETING_SUGGESTION_FALLBACK_MODEL },
    });
  } catch (err: any) {
    return { ok: false, error: `router_threw: ${err?.message ?? err}` };
  }
  if (!result.ok) return { ok: false, error: result.error ?? 'router_failed' };
  if (result.provider && result.provider !== 'bedrock') {
    // Defence in depth: a non-Bedrock answer is never used (CLAUDE.md 10c).
    return { ok: false, error: `non_bedrock_provider:${result.provider}` };
  }
  if (result.truncated) return { ok: false, error: 'truncated' };
  const v = validateGreetingSuggestion(result.text, language, input.avoid ?? []);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, suggestion: v.text, language, model: result.model ?? GREETING_SUGGESTION_MODEL };
}
