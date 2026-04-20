/**
 * BOOTSTRAP-ORB-DELEGATION-PROVIDERS: Anthropic (Claude) provider adapter.
 *
 * Uses the official `@anthropic-ai/sdk`. Wire:
 *   - verify(): 1-token ping to /v1/messages (matches routes/ai-assistants.ts).
 *   - call(): messages.create with system + single user turn. Token usage
 *     comes back on the response object directly.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DelegationContext, DelegationResult, ProviderAdapter } from '../types';
import { buildProviderPrompt } from '../context-builder';
import { computeCostUsd } from '../usage';

const PROVIDER_ID = 'claude';

export const adapter: ProviderAdapter = {
  manifest: {
    providerId: PROVIDER_ID,
    displayName: 'Claude',
    defaultModel: 'claude-sonnet-4-6',
    availableModels: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    strengths: ['code', 'long_context', 'reasoning', 'creative', 'summarization'],
    supportsStreaming: true,
    costRates: {
      'claude-opus-4-7':           { input: 15.00, output: 75.00 },
      'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
      'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00 },
      // Back-compat for older allowed_models rows — keep pricing reasonable
      // so budget checks don't under-estimate and let calls through that
      // should have been capped.
      'claude-3-5-sonnet-20241022': { input: 3.00,  output: 15.00 },
      'claude-3-5-haiku-20241022':  { input: 0.80,  output: 4.00 },
    },
  },

  async verify(apiKey: string) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return { ok: resp.ok, httpStatus: resp.status };
    } catch (err) {
      return {
        ok: false,
        httpStatus: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async call(ctx: DelegationContext, apiKey: string, model: string): Promise<DelegationResult> {
    const client = new Anthropic({ apiKey });
    const prompt = buildProviderPrompt(ctx);

    const msg = await client.messages.create({
      model,
      max_tokens: 1024,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      temperature: 0.7,
    });

    // Concatenate all text blocks (usually exactly one).
    const text = msg.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const inputTokens = msg.usage?.input_tokens ?? 0;
    const outputTokens = msg.usage?.output_tokens ?? 0;
    const rates = adapter.manifest.costRates[model];
    const costUsd = rates ? computeCostUsd(inputTokens, outputTokens, rates) : 0;

    return {
      text,
      providerId: PROVIDER_ID,
      model,
      usage: { inputTokens, outputTokens, costUsd },
      latencyMs: Date.now() - ctx.startedAt,
      metadata: {
        stop_reason: msg.stop_reason ?? null,
      },
    };
  },
};
