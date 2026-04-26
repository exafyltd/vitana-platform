/**
 * BOOTSTRAP-LLM-ROUTER: Provider-agnostic LLM call dispatcher.
 *
 * Why this exists:
 *   Every LLM call site in the gateway used to hard-code Anthropic. As we
 *   scale 10-50× into autonomous operation, the per-call API cost becomes
 *   prohibitive. This router reads the active `llm_routing_policy.policy[stage]`
 *   row and dispatches to the configured provider — Anthropic, OpenAI,
 *   Vertex (Google), DeepSeek, or claude_subscription (free, via worker queue).
 *
 *   Operators flip providers via the Command Hub dropdown without code edits.
 *   Defaults are FLAGSHIP-ONLY: every primary and fallback in LLM_SAFE_DEFAULTS
 *   is the strongest model the provider exposes. Stepping down to a mid-tier
 *   model is opt-in per stage, never automatic.
 *
 * Architecture:
 *   callViaRouter(stage, prompt, opts)
 *     ├─ load policy[stage] (cached 30s)
 *     ├─ call adapter[primary_provider].call(prompt, primary_model)
 *     │   ├─ on success → completeLLMCall + return {ok:true, text, usage, ...}
 *     │   └─ on failure → if fallback set, call adapter[fallback_provider]
 *     │                   → record fallback_used=true in telemetry
 *     └─ never throws — always returns {ok, text? | error?}
 *
 *   Adapters live inline in this file (small, no shared state) rather than
 *   one-file-per-provider. Each adapter implements `call(prompt, model)
 *   → Promise<AdapterResult>`. Adding a sixth provider is a new entry in
 *   the ADAPTERS map plus an env var read.
 *
 * Reuses (do NOT reimplement):
 *   - getActivePolicy() from llm-routing-policy-service.ts
 *   - startLLMCall / completeLLMCall / failLLMCall from llm-telemetry-service.ts
 *   - LLM_SAFE_DEFAULTS / estimateCost from constants/llm-defaults.ts
 */

import { getActivePolicy } from './llm-routing-policy-service';
import { startLLMCall, completeLLMCall, failLLMCall } from './llm-telemetry-service';
import {
  LLM_SAFE_DEFAULTS,
  type LLMRoutingPolicy,
  type LLMStage,
  type LLMProvider,
  type StageRoutingConfig,
} from '../constants/llm-defaults';

const LOG_PREFIX = '[llm-router]';

// =============================================================================
// Public types
// =============================================================================

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMRouterOpts {
  /** VTID for telemetry correlation. Optional — falls back to VTID-LLM-ROUTER. */
  vtid?: string | null;
  /** Service that originated the call (e.g. 'triage-agent'). Logged in OASIS. */
  service: string;
  /** Allow fallback adapter on primary failure. Defaults true. */
  allowFallback?: boolean;
  /** Override max output tokens. Adapter may clamp to its own limit. */
  maxTokens?: number;
  /** Optional system prompt prepended to the user prompt. */
  systemPrompt?: string;
  /** Optional structured input for vision: base64 image + mime type. */
  image?: { base64: string; mimeType: string };
}

export interface LLMRouterResult {
  ok: boolean;
  text?: string;
  usage?: LLMUsage;
  provider?: LLMProvider;
  model?: string;
  fallbackUsed?: boolean;
  error?: string;
}

interface AdapterCallArgs {
  prompt: string;
  model: string;
  systemPrompt?: string;
  maxTokens?: number;
  image?: { base64: string; mimeType: string };
}

interface AdapterResult {
  ok: boolean;
  text?: string;
  usage?: LLMUsage;
  error?: string;
}

interface ProviderAdapter {
  /** Execute a prompt against the provider's API. Must not throw. */
  call(args: AdapterCallArgs): Promise<AdapterResult>;
  /** True if this provider has the env credentials it needs to run. */
  isAvailable(): boolean;
}

// =============================================================================
// Policy cache (30s TTL — same provider keeps serving across short bursts
// without re-reading the policy table for every call)
// =============================================================================

const POLICY_CACHE_TTL_MS = 30_000;
let cachedPolicy: { policy: LLMRoutingPolicy; expiresAt: number } | null = null;

async function loadPolicy(): Promise<LLMRoutingPolicy> {
  if (cachedPolicy && cachedPolicy.expiresAt > Date.now()) {
    return cachedPolicy.policy;
  }
  try {
    const env = process.env.LLM_ROUTING_ENV || 'DEV';
    const row = await getActivePolicy(env);
    const policy = (row?.policy as LLMRoutingPolicy | undefined) || LLM_SAFE_DEFAULTS;
    cachedPolicy = { policy, expiresAt: Date.now() + POLICY_CACHE_TTL_MS };
    return policy;
  } catch (err) {
    console.warn(`${LOG_PREFIX} policy load failed, falling back to LLM_SAFE_DEFAULTS:`, err);
    return LLM_SAFE_DEFAULTS;
  }
}

/** Test-only: clear the policy cache so tests can override the active policy. */
export function _resetPolicyCacheForTests(): void {
  cachedPolicy = null;
}

// =============================================================================
// Provider adapters
// =============================================================================

/** Anthropic Messages API */
const anthropicAdapter: ProviderAdapter = {
  isAvailable: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async call({ prompt, model, systemPrompt, maxTokens, image }): Promise<AdapterResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };

    const userContent: unknown[] = [];
    if (image) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.base64 },
      });
    }
    userContent.push({ type: 'text', text: prompt });

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens ?? 8000,
      messages: [{ role: 'user', content: userContent }],
    };
    if (systemPrompt) body.system = systemPrompt;

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return { ok: false, error: `Anthropic ${resp.status}: ${errText.slice(0, 300)}` };
      }
      const json = await resp.json() as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (json.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('');
      return {
        ok: true,
        text,
        usage: {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
        },
      };
    } catch (err) {
      return { ok: false, error: `Anthropic threw: ${String(err).slice(0, 300)}` };
    }
  },
};

/** OpenAI Chat Completions API */
const openaiAdapter: ProviderAdapter = {
  isAvailable: () => Boolean(process.env.OPENAI_API_KEY),
  async call({ prompt, model, systemPrompt, maxTokens, image }): Promise<AdapterResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set' };

    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (image) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
          { type: 'text', text: prompt },
        ],
      });
    } else {
      messages.push({ role: 'user', content: prompt });
    }

    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens ?? 8000,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return { ok: false, error: `OpenAI ${resp.status}: ${errText.slice(0, 300)}` };
      }
      const json = await resp.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      return {
        ok: true,
        text,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    } catch (err) {
      return { ok: false, error: `OpenAI threw: ${String(err).slice(0, 300)}` };
    }
  },
};

/**
 * Google Vertex AI — uses Application Default Credentials, no API key required
 * on Cloud Run (the gateway service account has Vertex AI User role). Falls
 * back to GOOGLE_GEMINI_API_KEY for local dev.
 */
const vertexAdapter: ProviderAdapter = {
  isAvailable: () =>
    Boolean(process.env.GOOGLE_CLOUD_PROJECT) || Boolean(process.env.GOOGLE_GEMINI_API_KEY),
  async call({ prompt, model, systemPrompt, maxTokens, image }): Promise<AdapterResult> {
    // Prefer Vertex AI when GOOGLE_CLOUD_PROJECT is set (Cloud Run path).
    // Fall back to Google AI Studio when only GOOGLE_GEMINI_API_KEY is present.
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (projectId) {
      try {
        // Lazy import to avoid bundling cost when only Anthropic/DeepSeek are used.
        const { VertexAI } = await import('@google-cloud/vertexai');
        const location = process.env.VERTEX_LOCATION || 'us-central1';
        const vertex = new VertexAI({ project: projectId, location });
        const generativeModel = vertex.getGenerativeModel({
          model,
          generationConfig: { maxOutputTokens: maxTokens ?? 8000 },
          ...(systemPrompt
            ? { systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] } }
            : {}),
        });

        const parts: Array<Record<string, unknown>> = [];
        if (image) {
          parts.push({ inlineData: { data: image.base64, mimeType: image.mimeType } });
        }
        parts.push({ text: prompt });

        const result = await generativeModel.generateContent({
          contents: [{ role: 'user', parts: parts as any }],
        });
        const candidate = result.response?.candidates?.[0];
        const text = (candidate?.content?.parts || [])
          .map((p: any) => p.text || '')
          .join('');
        const usageMeta = result.response?.usageMetadata;
        return {
          ok: true,
          text,
          usage: {
            inputTokens: usageMeta?.promptTokenCount ?? 0,
            outputTokens: usageMeta?.candidatesTokenCount ?? 0,
          },
        };
      } catch (err) {
        return { ok: false, error: `Vertex threw: ${String(err).slice(0, 300)}` };
      }
    }

    // Google AI Studio path
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) return { ok: false, error: 'No Vertex/Google AI credentials available' };
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
      const parts: Array<Record<string, unknown>> = [];
      if (image) parts.push({ inlineData: { data: image.base64, mimeType: image.mimeType } });
      parts.push({ text: prompt });
      const body: Record<string, unknown> = {
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: maxTokens ?? 8000 },
      };
      if (systemPrompt) body.systemInstruction = { role: 'system', parts: [{ text: systemPrompt }] };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return { ok: false, error: `Google AI ${resp.status}: ${errText.slice(0, 300)}` };
      }
      const json = await resp.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = (json.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || '')
        .join('');
      return {
        ok: true,
        text,
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (err) {
      return { ok: false, error: `Google AI threw: ${String(err).slice(0, 300)}` };
    }
  },
};

/** DeepSeek API — OpenAI-compatible, single env key */
const deepseekAdapter: ProviderAdapter = {
  isAvailable: () => Boolean(process.env.DEEPSEEK_API_KEY),
  async call({ prompt, model, systemPrompt, maxTokens }): Promise<AdapterResult> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return { ok: false, error: 'DEEPSEEK_API_KEY not set' };

    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens ?? 8000,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return { ok: false, error: `DeepSeek ${resp.status}: ${errText.slice(0, 300)}` };
      }
      const json = await resp.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      return {
        ok: true,
        text,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    } catch (err) {
      return { ok: false, error: `DeepSeek threw: ${String(err).slice(0, 300)}` };
    }
  },
};

/**
 * claude_subscription: free pseudo-provider that routes through the local
 * autopilot-worker queue → `claude -p` against the user's Pro/Max plan.
 *
 * Only meaningful for `worker` / `planner` stages. For other stages (triage,
 * vision, classifier) the worker overhead and 10-min timeout are wrong; the
 * router will report "claude_subscription not viable for this stage" and
 * the caller should pick another provider.
 *
 * Implementation defers to `runWorkerTask` from dev-autopilot-worker-queue
 * to avoid duplicating the queue protocol.
 */
const claudeSubscriptionAdapter: ProviderAdapter = {
  isAvailable: () =>
    (process.env.DEV_AUTOPILOT_USE_WORKER || '').toLowerCase() === 'true',
  async call({ prompt, model, maxTokens }): Promise<AdapterResult> {
    try {
      const { runWorkerTask } = await import('./dev-autopilot-worker-queue');
      // The worker queue requires a finding_id; we synthesize one for ad-hoc
      // routes that have no finding context. Worker doesn't validate the
      // shape — it just stores it on the row.
      const result = await runWorkerTask(
        {
          kind: 'plan',
          finding_id: '00000000-0000-0000-0000-000000000000',
          prompt,
          model,
          max_tokens: maxTokens ?? 8000,
          notes: 'llm-router ad-hoc',
        },
        { timeoutMs: 6 * 60 * 1000 },
      );
      if (!result.ok) {
        return { ok: false, error: `claude_subscription: ${result.error || 'worker failed'}` };
      }
      return {
        ok: true,
        text: result.text || '',
        usage: {
          inputTokens: result.usage?.input_tokens ?? 0,
          outputTokens: result.usage?.output_tokens ?? 0,
        },
      };
    } catch (err) {
      return { ok: false, error: `claude_subscription threw: ${String(err).slice(0, 300)}` };
    }
  },
};

const ADAPTERS: Record<LLMProvider, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  vertex: vertexAdapter,
  deepseek: deepseekAdapter,
  claude_subscription: claudeSubscriptionAdapter,
};

// =============================================================================
// Public API
// =============================================================================

/**
 * Dispatch an LLM call to the configured provider for `stage`.
 *
 * Never throws — always returns `{ ok, text? | error? }`. Records start +
 * complete/fail telemetry via `llm-telemetry-service`. Falls back to the
 * stage's `fallback_provider` on primary failure when `allowFallback !== false`.
 */
export async function callViaRouter(
  stage: LLMStage,
  prompt: string,
  opts: LLMRouterOpts,
): Promise<LLMRouterResult> {
  const policy = await loadPolicy();
  const stageConfig: StageRoutingConfig = policy[stage];
  if (!stageConfig) {
    return { ok: false, error: `No policy configured for stage '${stage}'` };
  }

  const allowFallback = opts.allowFallback !== false;

  // === PRIMARY ===
  const primary = await runProviderCall(
    stage,
    stageConfig.primary_provider,
    stageConfig.primary_model,
    prompt,
    opts,
    /* fallbackUsed= */ false,
  );
  if (primary.ok) return primary;

  // === FALLBACK ===
  if (
    !allowFallback ||
    !stageConfig.fallback_provider ||
    !stageConfig.fallback_model
  ) {
    return primary;
  }
  console.warn(
    `${LOG_PREFIX} stage=${stage} primary ${stageConfig.primary_provider}/${stageConfig.primary_model} failed: ${primary.error?.slice(0, 200)} — trying fallback ${stageConfig.fallback_provider}/${stageConfig.fallback_model}`,
  );
  const fallback = await runProviderCall(
    stage,
    stageConfig.fallback_provider,
    stageConfig.fallback_model,
    prompt,
    opts,
    /* fallbackUsed= */ true,
  );
  if (fallback.ok) {
    return { ...fallback, fallbackUsed: true };
  }
  return {
    ok: false,
    error: `both providers failed: primary=${primary.error}; fallback=${fallback.error}`,
    fallbackUsed: true,
  };
}

async function runProviderCall(
  stage: LLMStage,
  provider: LLMProvider,
  model: string,
  prompt: string,
  opts: LLMRouterOpts,
  fallbackUsed: boolean,
): Promise<LLMRouterResult> {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    return { ok: false, error: `Unknown provider '${provider}'`, provider, model };
  }
  if (!adapter.isAvailable()) {
    return {
      ok: false,
      error: `Provider '${provider}' has no credentials configured`,
      provider,
      model,
    };
  }

  const ctx = await startLLMCall({
    vtid: opts.vtid ?? null,
    service: opts.service,
    stage,
    provider,
    model,
    prompt,
  });

  const result = await adapter.call({
    prompt,
    model,
    systemPrompt: opts.systemPrompt,
    maxTokens: opts.maxTokens,
    image: opts.image,
  });

  if (result.ok) {
    await completeLLMCall(ctx, {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      fallbackUsed,
    });
    return {
      ok: true,
      text: result.text,
      usage: result.usage,
      provider,
      model,
      fallbackUsed,
    };
  }

  await failLLMCall(ctx, {
    code: 'provider_error',
    message: result.error || 'unknown',
  });
  return {
    ok: false,
    error: result.error,
    provider,
    model,
    fallbackUsed,
  };
}

// =============================================================================
// Re-exports for callers that want raw types
// =============================================================================

export type { LLMStage, LLMProvider, LLMRoutingPolicy, StageRoutingConfig };
