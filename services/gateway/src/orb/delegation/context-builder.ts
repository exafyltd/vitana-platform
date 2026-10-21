/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Build the provider prompt payload from a
 * DelegationContext, honouring the user's privacy level.
 *
 * Outputs a simple { system, user } pair that each provider adapter converts
 * to its native format. Keeps the privacy-level enforcement in one place so
 * it cannot be bypassed by a forgetful adapter.
 */
import type { DelegationContext, DelegationPrivacyLevel } from './types';

export interface ProviderPrompt {
  readonly system: string;
  readonly user: string;
}

const SYSTEM_BASE = (lang: string): string =>
  [
    'You are assisting a user via their AI companion Vitana.',
    'Vitana will speak your answer to the user in its own voice.',
    'Answer concisely and directly. Prefer one short paragraph to a long reply.',
    `Respond in the user's language: ${lang}.`,
    'Do not introduce yourself, do not reveal that you are a different AI, do not mention which model you are.',
    'Do not use markdown headers or bullet points unless explicitly asked.',
  ].join(' ');

export function buildProviderPrompt(ctx: DelegationContext): ProviderPrompt {
  const system = SYSTEM_BASE(ctx.lang);
  const user = composeUserMessage(ctx, ctx.privacyLevel);
  return { system, user };
}

function composeUserMessage(ctx: DelegationContext, level: DelegationPrivacyLevel): string {
  if (level === 'public') return ctx.question;

  const parts: string[] = [];

  if (level === 'contextual' || level === 'memory-aware') {
    const turns = (ctx.recentTurns || []).slice(-6);
    if (turns.length > 0) {
      parts.push('Recent conversation (most recent last):');
      for (const turn of turns) {
        parts.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`);
      }
      parts.push('');
    }
  }

  if (level === 'memory-aware') {
    const snippets = (ctx.memorySnippets || []).slice(0, 6);
    if (snippets.length > 0) {
      parts.push('Relevant memory (only use if directly applicable):');
      for (const s of snippets) {
        parts.push(`- [${s.source}] ${s.text}`);
      }
      parts.push('');
    }
  }

  parts.push('Question:');
  parts.push(ctx.question);

  return parts.join('\n');
}
