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

/**
 * Tool definition for function calling. Provider-neutral — the adapter
 * translates to each provider's wire format (Anthropic `tools`, OpenAI
 * `tools` + `tool_choice`, Vertex `function_declarations`, DeepSeek
 * (OpenAI-compatible)). The router enforces tool_choice='required' on
 * the named tool so the model emits the structured call instead of free
 * text.
 */
export interface LLMRouterTool {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input. */
  inputSchema: Record<string, unknown>;
}

/** Optional inputs for image / vision / multiple images per call. */
export interface LLMRouterImage {
  base64: string;
  mimeType: string;
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
  /** Single image input (back-compat). Use `images` for multi-image. */
  image?: LLMRouterImage;
  /** Multi-image input — Vertex / Anthropic / OpenAI all accept ordered images
   *  attached as parts on the user message. */
  images?: LLMRouterImage[];
  /**
   * Tools the model may call. When set with `forceTool`, the router asks the
   * provider to emit a tool call deterministically and returns it in
   * `LLMRouterResult.toolCall`. Used by vision (structured metadata) and
   * triage (multi-step investigation).
   */
  tools?: LLMRouterTool[];
  /**
   * Force the model to invoke `tools[forceTool].name` and return the parsed
   * arguments instead of free text. Index into `tools` array.
   */
  forceTool?: number;
}

/** Returned when `forceTool` is set and the model emitted a tool call. */
export interface LLMRouterToolCall {
  name: string;
  /** Already-parsed JSON arguments. Adapters parse the provider-specific shape. */
  arguments: Record<string, unknown>;
}

export interface LLMRouterResult {
  ok: boolean;
  text?: string;
  /** Populated when `forceTool` was set and the model emitted a structured call. */
  toolCall?: LLMRouterToolCall;
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
  image?: LLMRouterImage;
  images?: LLMRouterImage[];
  tools?: LLMRouterTool[];
  forceTool?: number;
}

interface AdapterResult {
  ok: boolean;
  text?: string;
  toolCall?: LLMRouterToolCall;
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

/** Anthropic Messages API — supports text, multi-image, and tool_use. */
const anthropicAdapter: ProviderAdapter = {
  isAvailable: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async call({ prompt, model, systemPrompt, maxTokens, image, images, tools, forceTool }): Promise<AdapterResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };

    const userContent: unknown[] = [];
    const allImages: LLMRouterImage[] = [];
    if (images && images.length > 0) allImages.push(...images);
    if (image) allImages.push(image);
    for (const img of allImages) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
      });
    }
    userContent.push({ type: 'text', text: prompt });

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens ?? 8000,
      messages: [{ role: 'user', content: userContent }],
    };
    if (systemPrompt) body.system = systemPrompt;
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
      if (typeof forceTool === 'number' && tools[forceTool]) {
        body.tool_choice = { type: 'tool', name: tools[forceTool].name };
      }
    }

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
        content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (json.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('');
      const toolBlock = (json.content || []).find(c => c.type === 'tool_use');
      const toolCall = toolBlock && toolBlock.name && toolBlock.input
        ? { name: toolBlock.name, arguments: toolBlock.input }
        : undefined;
      return {
        ok: true,
        text,
        toolCall,
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

/** OpenAI Chat Completions API — supports text, multi-image, and function calling. */
const openaiAdapter: ProviderAdapter = {
  isAvailable: () => Boolean(process.env.OPENAI_API_KEY),
  async call({ prompt, model, systemPrompt, maxTokens, image, images, tools, forceTool }): Promise<AdapterResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set' };

    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

    const allImages: LLMRouterImage[] = [];
    if (images && images.length > 0) allImages.push(...images);
    if (image) allImages.push(image);
    if (allImages.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      for (const img of allImages) {
        content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
      }
      content.push({ type: 'text', text: prompt });
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: prompt });
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens ?? 8000,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      if (typeof forceTool === 'number' && tools[forceTool]) {
        body.tool_choice = { type: 'function', function: { name: tools[forceTool].name } };
      }
    }

    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return { ok: false, error: `OpenAI ${resp.status}: ${errText.slice(0, 300)}` };
      }
      const json = await resp.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = json.choices?.[0]?.message;
      const text = msg?.content ?? '';
      let toolCall: LLMRouterToolCall | undefined;
      const tc = msg?.tool_calls?.[0];
      if (tc?.function?.name && tc.function.arguments) {
        try {
          toolCall = { name: tc.function.name, arguments: JSON.parse(tc.function.arguments) };
        } catch {
          // Tool call not JSON-parseable — leave undefined; caller falls back to text.
        }
      }
      return {
        ok: true,
        text,
        toolCall,
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
 * back to GOOGLE_GEMINI_API_KEY for local dev. Supports text, multi-image,
 * and function calling.
 */
const vertexAdapter: ProviderAdapter = {
  isAvailable: () =>
    Boolean(process.env.GOOGLE_CLOUD_PROJECT) || Boolean(process.env.GOOGLE_GEMINI_API_KEY),
  async call({ prompt, model, systemPrompt, maxTokens, image, images, tools, forceTool }): Promise<AdapterResult> {
    const allImages: LLMRouterImage[] = [];
    if (images && images.length > 0) allImages.push(...images);
    if (image) allImages.push(image);

    const fnDecls = tools && tools.length > 0
      ? tools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema }))
      : undefined;

    // Prefer Vertex AI when GOOGLE_CLOUD_PROJECT is set (Cloud Run path).
    // Fall back to Google AI Studio when only GOOGLE_GEMINI_API_KEY is present.
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (projectId) {
      try {
        const { VertexAI } = await import('@google-cloud/vertexai');
        const location = process.env.VERTEX_LOCATION || 'us-central1';
        const vertex = new VertexAI({ project: projectId, location });
        const modelInit: Record<string, unknown> = {
          model,
          generationConfig: { maxOutputTokens: maxTokens ?? 8000 },
        };
        if (systemPrompt) {
          modelInit.systemInstruction = { role: 'system', parts: [{ text: systemPrompt }] };
        }
        if (fnDecls) {
          modelInit.tools = [{ functionDeclarations: fnDecls }];
          if (typeof forceTool === 'number' && tools && tools[forceTool]) {
            modelInit.toolConfig = {
              functionCallingConfig: {
                mode: 'ANY',
                allowedFunctionNames: [tools[forceTool].name],
              },
            };
          }
        }
        const generativeModel = vertex.getGenerativeModel(modelInit as any);

        const parts: Array<Record<string, unknown>> = [];
        for (const img of allImages) {
          parts.push({ inlineData: { data: img.base64, mimeType: img.mimeType } });
        }
        parts.push({ text: prompt });

        const result = await generativeModel.generateContent({
          contents: [{ role: 'user', parts: parts as any }],
        });
        const candidate = result.response?.candidates?.[0];
        const candidateParts = (candidate?.content?.parts || []) as Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }>;
        const text = candidateParts.map(p => p.text || '').join('');
        const fnPart = candidateParts.find(p => !!p.functionCall);
        const toolCall = fnPart?.functionCall?.name && fnPart.functionCall.args
          ? { name: fnPart.functionCall.name, arguments: fnPart.functionCall.args }
          : undefined;
        const usageMeta = result.response?.usageMetadata;
        return {
          ok: true,
          text,
          toolCall,
          usage: {
            inputTokens: usageMeta?.promptTokenCount ?? 0,
            outputTokens: usageMeta?.candidatesTokenCount ?? 0,
          },
        };
      } catch (err) {
        const errStr = String(err);
        // VTID-02689: fall through to AI Studio when Vertex doesn't have
        // the model. Preview models like `gemini-3.1-pro-preview` are
        // exposed via generativelanguage.googleapis.com (consumer/AI Studio
        // endpoint) but not the Vertex v1 publisher catalog used by the
        // @google-cloud/vertexai Node SDK. The Python google-genai SDK
        // (used by livekit-plugins-google with vertexai=True) talks to a
        // different Vertex endpoint that DOES expose the preview models.
        // Until we migrate this adapter to @google/genai, AI Studio is the
        // path that works for preview models.
        if (errStr.match(/Publisher Model.*not found|404 Not Found|model.*not.*supported/i)
          && process.env.GOOGLE_GEMINI_API_KEY) {
          console.log(`[llm-router] Vertex returned 404 for model "${model}" — falling through to AI Studio`);
          // fall through to AI Studio block below
        } else {
          return { ok: false, error: `Vertex threw: ${errStr.slice(0, 300)}` };
        }
      }
    }

    // Google AI Studio path
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) return { ok: false, error: 'No Vertex/Google AI credentials available' };
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
      const parts: Array<Record<string, unknown>> = [];
      for (const img of allImages) {
        parts.push({ inlineData: { data: img.base64, mimeType: img.mimeType } });
      }
      parts.push({ text: prompt });
      const body: Record<string, unknown> = {
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: maxTokens ?? 8000 },
      };
      if (systemPrompt) body.systemInstruction = { role: 'system', parts: [{ text: systemPrompt }] };
      if (fnDecls) {
        body.tools = [{ functionDeclarations: fnDecls }];
        if (typeof forceTool === 'number' && tools && tools[forceTool]) {
          body.toolConfig = {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: [tools[forceTool].name],
            },
          };
        }
      }
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
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const candidateParts = json.candidates?.[0]?.content?.parts || [];
      const text = candidateParts.map(p => p.text || '').join('');
      const fnPart = candidateParts.find(p => !!p.functionCall);
      const toolCall = fnPart?.functionCall?.name && fnPart.functionCall.args
        ? { name: fnPart.functionCall.name, arguments: fnPart.functionCall.args }
        : undefined;
      return {
        ok: true,
        text,
        toolCall,
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

/**
 * DeepSeek API — OpenAI-compatible. Supports text + function calling but
 * NOT vision (DeepSeek hasn't shipped a multimodal model). When images are
 * passed they're ignored and only the text prompt is sent; the router's
 * fallback chain is responsible for routing vision calls to a different
 * provider via the `vision` stage policy.
 */
const deepseekAdapter: ProviderAdapter = {
  isAvailable: () => Boolean(process.env.DEEPSEEK_API_KEY),
  async call({ prompt, model, systemPrompt, maxTokens, image, images, tools, forceTool }): Promise<AdapterResult> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return { ok: false, error: 'DEEPSEEK_API_KEY not set' };

    if (image || (images && images.length > 0)) {
      return {
        ok: false,
        error: 'DeepSeek does not support vision input — route vision calls to a different provider',
      };
    }

    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens ?? 8000,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      if (typeof forceTool === 'number' && tools[forceTool]) {
        body.tool_choice = { type: 'function', function: { name: tools[forceTool].name } };
      }
    }

    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return { ok: false, error: `DeepSeek ${resp.status}: ${errText.slice(0, 300)}` };
      }
      const json = await resp.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = json.choices?.[0]?.message;
      const text = msg?.content ?? '';
      let toolCall: LLMRouterToolCall | undefined;
      const tc = msg?.tool_calls?.[0];
      if (tc?.function?.name && tc.function.arguments) {
        try {
          toolCall = { name: tc.function.name, arguments: JSON.parse(tc.function.arguments) };
        } catch {
          // Tool call not JSON-parseable — leave undefined.
        }
      }
      return {
        ok: true,
        text,
        toolCall,
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
    images: opts.images,
    tools: opts.tools,
    forceTool: opts.forceTool,
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
      toolCall: result.toolCall,
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
