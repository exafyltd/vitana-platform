/**
 * Shared direct-API Claude client for gateway services migrated off Gemini/Vertex.
 *
 * Single choke point so the transport (direct Anthropic API today, Bedrock
 * once AWS IAM + model access are provisioned) can change in one place
 * without touching every call site.
 */

import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_SONNET_4_6 = 'claude-sonnet-4-6';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let client: Anthropic | null = null;
try {
  if (ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
} catch {
  client = null;
}

export interface ClaudeTextCallOptions {
  model?: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Single-turn text completion. Returns null (not throw) when the client
 * isn't configured or the response has no text — callers already have
 * deterministic fallbacks for a null result.
 */
export async function callClaudeText(opts: ClaudeTextCallOptions): Promise<string | null> {
  if (!client) return null;

  const msg = await client.messages.create({
    model: opts.model ?? CLAUDE_SONNET_4_6,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.3,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
  });

  const text = msg.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return text || null;
}
