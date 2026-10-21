/**
 * BOOTSTRAP-ORB-DELEGATION-PROVIDERS: OpenAI (ChatGPT) provider adapter.
 *
 * Uses the official `openai` SDK (v6). Wire is:
 *   - verify(): /v1/models — cheap auth check.
 *   - call(): chat.completions.create with the user's prompt + system
 *     instruction from buildProviderPrompt. Returns text + exact token
 *     counts from the response usage field.
 *
 * The executor wraps adapter.call() in a 15 s hard timeout (execute.ts),
 * so we don't need per-call timeouts here. SDK errors propagate with
 * meaningful messages; the executor catches and logs as provider_error.
 */
import OpenAI from 'openai';
import type { DelegationContext, DelegationResult, ProviderAdapter } from '../types';
import { buildProviderPrompt } from '../context-builder';
import { computeCostUsd } from '../usage';

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

  async call(ctx: DelegationContext, apiKey: string, model: string): Promise<DelegationResult> {
    const client = new OpenAI({ apiKey });
    const prompt = buildProviderPrompt(ctx);

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      // Voice-friendly envelope: bound runaway responses and keep latency low.
      // Reasoning models (o1) interpret max_tokens loosely; the cap still
      // limits end-user-visible output tokens either way.
      max_tokens: 1024,
      temperature: 0.7,
    });

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';
    const inputTokens = completion.usage?.prompt_tokens ?? 0;
    const outputTokens = completion.usage?.completion_tokens ?? 0;

    const rates = adapter.manifest.costRates[model];
    const costUsd = rates ? computeCostUsd(inputTokens, outputTokens, rates) : 0;

    return {
      text,
      providerId: PROVIDER_ID,
      model,
      usage: { inputTokens, outputTokens, costUsd },
      latencyMs: Date.now() - ctx.startedAt,
      metadata: {
        finish_reason: choice?.finish_reason ?? null,
      },
    };
  },
};
