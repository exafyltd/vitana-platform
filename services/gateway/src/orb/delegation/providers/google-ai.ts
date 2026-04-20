/**
 * BOOTSTRAP-ORB-DELEGATION-PROVIDERS: Google AI (public generativelanguage
 * API) provider adapter.
 *
 * IMPORTANT: this is the user-provided-key PUBLIC Google AI Studio API
 * (generativelanguage.googleapis.com/v1beta). It is distinct from the
 * internal Vertex Live API that Vitana uses for its own orb voice —
 * Vertex Live runs on the gateway's service account credentials.
 *
 * Implemented via raw fetch (not @google/generative-ai) to avoid adding a
 * heavyweight SDK for what is effectively one REST call with a JSON body.
 * Token counts come back in the response under usageMetadata.
 */
import type { DelegationContext, DelegationResult, ProviderAdapter } from '../types';
import { buildProviderPrompt } from '../context-builder';
import { computeCostUsd } from '../usage';

const PROVIDER_ID = 'google-ai';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

export const adapter: ProviderAdapter = {
  manifest: {
    providerId: PROVIDER_ID,
    displayName: 'Google AI (Gemini)',
    defaultModel: 'gemini-2.0-flash',
    availableModels: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-2.0-flash-thinking-exp'],
    strengths: ['multilingual', 'vision', 'factual', 'long_context'],
    supportsStreaming: true,
    costRates: {
      'gemini-2.0-flash':              { input: 0.075, output: 0.30 },
      'gemini-2.0-pro':                { input: 1.25,  output: 5.00 },
      'gemini-2.0-flash-thinking-exp': { input: 0.075, output: 0.30 },
    },
  },

  async verify(apiKey: string) {
    try {
      const resp = await fetch(
        `${API_BASE}/models?key=${encodeURIComponent(apiKey)}`,
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

  async call(ctx: DelegationContext, apiKey: string, model: string): Promise<DelegationResult> {
    const prompt = buildProviderPrompt(ctx);

    const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      systemInstruction: { parts: [{ text: prompt.system }] },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => '');
      throw new Error(`Google AI ${resp.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await resp.json()) as GenerateContentResponse;

    if (data.error) {
      throw new Error(`Google AI error: ${data.error.message ?? data.error.status ?? 'unknown'}`);
    }

    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');

    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    const rates = adapter.manifest.costRates[model];
    const costUsd = rates ? computeCostUsd(inputTokens, outputTokens, rates) : 0;

    return {
      text,
      providerId: PROVIDER_ID,
      model,
      usage: { inputTokens, outputTokens, costUsd },
      latencyMs: Date.now() - ctx.startedAt,
      metadata: {
        finish_reason: candidate?.finishReason ?? null,
      },
    };
  },
};
