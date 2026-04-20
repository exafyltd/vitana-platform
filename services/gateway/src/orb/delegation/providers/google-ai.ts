/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Google AI (public generativelanguage
 * API) provider adapter.
 *
 * IMPORTANT: this is the user-provided-key PUBLIC Google AI Studio API
 * (generativelanguage.googleapis.com/v1beta). It is distinct from the
 * internal Vertex Live API that Vitana uses for its own orb voice —
 * Vertex Live runs on the gateway's service account credentials. When the
 * user connects their own Google AI key here, we delegate via that key
 * exactly like we do for OpenAI/Anthropic.
 */
import type { DelegationContext, DelegationResult, ProviderAdapter } from '../types';

const PROVIDER_ID = 'google-ai';

export const adapter: ProviderAdapter = {
  manifest: {
    providerId: PROVIDER_ID,
    displayName: 'Google AI (Gemini)',
    defaultModel: 'gemini-2.0-flash',
    availableModels: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-2.0-flash-thinking-exp'],
    strengths: ['multilingual', 'vision', 'factual', 'long_context'],
    supportsStreaming: true,
    costRates: {
      // Placeholder rates; Phase 7 refreshes with current pricing.
      'gemini-2.0-flash':             { input: 0.075, output: 0.30 },
      'gemini-2.0-pro':               { input: 1.25,  output: 5.00 },
      'gemini-2.0-flash-thinking-exp':{ input: 0.075, output: 0.30 },
    },
  },

  async verify(apiKey: string) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { method: 'GET' },
      );
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
      'BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Google AI adapter.call() not wired yet. Phase 7 ships the real implementation.',
    );
  },
};
