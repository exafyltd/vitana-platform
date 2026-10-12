/**
 * VTID-05099 — writes Vitana's personal note for one companion message.
 *
 * Claude on AWS Bedrock only (CLAUDE.md 10a–10c): the primary AND the
 * fallback are per-call Bedrock overrides, so the stage's stored policy can
 * never route this to Google or to the direct Anthropic API. The prompt is an
 * English intent plus the member's facts (rule 41: no hardcoded sentence);
 * the language and du-form come from buildLocalizedSystemPromptForLang.
 *
 * A failed or invalid composition returns ok:false — the caller skips the
 * member for today. There is no template fallback.
 */
import { callViaRouter, type LLMRouterResult } from '../llm-router';
import { buildLocalizedSystemPromptForLang } from '../../i18n/llm-locale';
import type { CompanionConfig } from './config';
import type { MemberContext, MomentCandidate } from './moments';

const VTID = 'VTID-05099';
// The stage only labels telemetry here: both providers are overridden per call.
const STAGE = 'operator' as const;
export const MAX_MESSAGE_CHARS = 700;

export const COMPANION_BASE_PROMPT = [
  'You are Vitana, a warm, personal life companion inside the Vitanaland longevity community.',
  'You are writing ONE short proactive message into the member\'s private chat with you.',
  'Rules:',
  '- 2 to 4 short sentences, plain text only: no markdown, no lists, no headings, no links, no emojis beyond one at most.',
  '- Use only the facts provided. Never invent numbers, names, dates or events.',
  '- No medical diagnosis, no medical claims, no promises of health outcomes.',
  '- Do not describe or repeat the card text; a card with its own button appears under your message.',
  '- Never mention commissions, earnings for Vitana, or that this message was scheduled or automated.',
  '- Write the message itself only, with no preamble and no sign-off line.',
].join('\n');

export type ComposeResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string };

export type RouterCall = typeof callViaRouter;

export function buildComposePrompt(ctx: MemberContext, moment: MomentCandidate): string {
  return [
    `Intent: ${moment.intent}`,
    `Member first name: ${ctx.firstName?.trim() || '(unknown — greet warmly without a name)'}`,
    `Facts (JSON): ${JSON.stringify(moment.facts)}`,
  ].join('\n');
}

const SCRIPT_CHECK: Record<string, RegExp> = {
  ar: /[؀-ۿ]/,
  zh: /[一-鿿]/,
  ru: /[Ѐ-ӿ]/,
};

/** Returns the cleaned text, or an error code when the output must not be sent. */
export function validateComposition(raw: string | undefined, locale: string): { ok: true; text: string } | { ok: false; error: string } {
  const text = (raw ?? '').trim().replace(/^["“]|["”]$/g, '').trim();
  if (!text) return { ok: false, error: 'empty' };
  if (text.length > MAX_MESSAGE_CHARS) return { ok: false, error: 'too_long' };
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, error: 'contains_link' };
  if (/^\s*(#|[-*]\s|\d+\.\s)/m.test(text)) return { ok: false, error: 'contains_markdown' };
  const script = SCRIPT_CHECK[locale.slice(0, 2)];
  if (script && !script.test(text)) return { ok: false, error: 'wrong_script' };
  return { ok: true, text };
}

export async function composeCompanionMessage(
  ctx: MemberContext,
  moment: MomentCandidate,
  config: CompanionConfig,
  call: RouterCall = callViaRouter,
): Promise<ComposeResult> {
  let result: LLMRouterResult;
  try {
    result = await call(STAGE, buildComposePrompt(ctx, moment), {
      vtid: VTID,
      service: 'companion-messages',
      systemPrompt: buildLocalizedSystemPromptForLang(COMPANION_BASE_PROMPT, ctx.locale),
      maxTokens: 400,
      providerOverride: 'bedrock',
      modelOverride: config.model,
      fallbackOverride: { provider: 'bedrock', model: config.fallbackModel },
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
  const v = validateComposition(result.text, ctx.locale);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, text: v.text, model: result.model ?? config.model };
}
