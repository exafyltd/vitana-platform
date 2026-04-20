/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: OpenAI (ChatGPT) provider adapter.
 *
 * Current state: verify() hits /v1/models (same pattern as the existing
 * /verify/chatgpt route). call() throws `scaffold_not_wired` — Phase 7 will
 * replace it with a real Chat Completions call plus token counting.
 *
 * Pricing table below is a seed for MODEL_COSTS — kept local for now so
 * this adapter is self-contained. Phase 7 can migrate to constants/llm-defaults.ts
 * if we want to share with other surfaces.
 */
import type { DelegationContext, DelegationResult, ProviderAdapter } from '../types';

const PROVIDER_ID = 'chatgpt';

export const adapter: ProviderAdapter = {
  manifest: {
    providerId: PROVIDER_ID,
    displayName: 'ChatGPT',
    defaultModel: 'gpt-4o-mini',
    availableModels: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'],
    strengths: ['reasoning', 'code', 'vision', 'multilingual', 'factual'],
    supportsStreaming: true,
    costRates: {
      // USD per 1M tokens (input / output). Seed values — Phase 7 reads
      // MODEL_COSTS from constants/llm-defaults.ts so there is one source of truth.
      'gpt-4o':      { input: 2.50,  output: 10.00 },
      'gpt-4o-mini': { input: 0.15,  output: 0.60 },
      'o1-mini':     { input: 3.00,  output: 12.00 },
    },
  },

  async verify(apiKey: string) {
    try {
      const resp = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
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
      'BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: OpenAI adapter.call() not wired yet. Phase 7 ships the real implementation.',
    );
  },
};
