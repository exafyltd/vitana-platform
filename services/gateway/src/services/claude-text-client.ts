/**
 * Shared Claude client for gateway services migrated off Gemini/Vertex.
 *
 * Single choke point so the transport can change in one place without
 * touching every call site. BOOTSTRAP-GEMINI-TO-CLAUDE: transport is now
 * Amazon Bedrock (`invokeBedrock()`, VTID-03403's `providers/bedrock.ts`) —
 * the user requires these Tier A call sites to run through Bedrock, not the
 * direct Anthropic API. Reuses the existing Bedrock adapter rather than
 * building a second client (`invokeBedrock()` is also what
 * `llm-router.ts`'s `bedrockAdapter` calls).
 *
 * `opts.model` (a bare model name like "claude-sonnet-4-6") is accepted for
 * call-site compatibility but ignored for the actual invocation — Bedrock
 * needs a resolved cross-region inference profile ID, read from
 * `BEDROCK_MODEL_ID` instead.
 */

import { invokeBedrock } from '../providers/bedrock';

export const CLAUDE_SONNET_4_6 = 'claude-sonnet-4-6';

const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6';

export interface ClaudeTextCallOptions {
  model?: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Single-turn text completion via Bedrock. Returns null when Bedrock isn't
 * configured (BEDROCK_ROLE_ARN unset) or the response has no text — callers
 * already have deterministic fallbacks for a null result. Throws (rather
 * than swallowing) when a configured call actually fails upstream, so the
 * real error (auth, model access, throttling, etc.) surfaces in
 * gemini_call_log via each caller's existing withGeminiLog wrapper instead
 * of being misread as "not configured".
 */
export async function callClaudeText(opts: ClaudeTextCallOptions): Promise<string | null> {
  const result = await invokeBedrock({
    model: BEDROCK_MODEL_ID,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.3,
  });

  if (!result.ok) {
    if (result.error === 'not_configured') return null;
    throw new Error(`Bedrock call failed: ${result.message}`);
  }

  return result.text || null;
}
