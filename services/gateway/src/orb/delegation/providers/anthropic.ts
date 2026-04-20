/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Anthropic (Claude) provider adapter.
 *
 * Current state: verify() posts a 1-token ping to /v1/messages (same pattern
 * as the existing /verify/claude route). call() throws `scaffold_not_wired` —
 * Phase 7 replaces it with a real Messages API call.
 */
import type { DelegationContext, DelegationResult, ProviderAdapter } from '../types';

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
      // USD per 1M tokens (input / output). Seed values — Phase 7 moves to
      // constants/llm-defaults.ts for shared truth.
      'claude-opus-4-7':           { input: 15.00, output: 75.00 },
      'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
      'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00 },
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

  async call(_ctx: DelegationContext, _apiKey: string, _model: string): Promise<DelegationResult> {
    throw new Error(
      'BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Anthropic adapter.call() not wired yet. Phase 7 ships the real implementation.',
    );
  },
};
