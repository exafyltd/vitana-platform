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
import { invokeBedrock, type BedrockContentBlock } from '../providers/bedrock';
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
  /**
   * VTID-03579: prior turns, oldest first. `prompt` remains the CURRENT user
   * turn and is appended after these — so every existing caller is unaffected
   * and a single-turn call is still literally a string.
   */
  history?: LLMRouterMessage[];
}

/** Returned when `forceTool` is set and the model emitted a tool call. */
export interface LLMRouterToolCall {
  name: string;
  /** Already-parsed JSON arguments. Adapters parse the provider-specific shape. */
  arguments: Record<string, unknown>;
  /**
   * VTID-03579: provider-assigned id for this call. Opaque here, but it must be
   * echoed back on the matching tool result — Anthropic pairs them by id and
   * rejects a mismatch outright.
   */
  id?: string;
}

/**
 * VTID-03579: one prior turn of a multi-turn exchange.
 *
 * Deliberately provider-neutral and deliberately NOT a raw provider payload:
 * an agentic caller should describe what happened (the model asked for tools /
 * here are the results), and each adapter renders that into its own wire shape.
 * Passing Anthropic content blocks straight through would work today and pin
 * every future caller to Anthropic, which is the coupling this whole file
 * exists to prevent.
 */
export type LLMRouterMessage =
  | { role: 'user' | 'assistant'; content: string }
  /** The model asked to call tools. */
  | { role: 'assistant'; toolCalls: LLMRouterToolCall[]; content?: string }
  /** The caller ran them; these are the outcomes, in the same order. */
  | {
      role: 'user';
      toolResults: Array<{ id?: string; name: string; result: string; isError?: boolean }>;
    };

export interface LLMRouterResult {
  ok: boolean;
  text?: string;
  /** Populated when `forceTool` was set and the model emitted a structured call. */
  toolCall?: LLMRouterToolCall;
  /**
   * VTID-03579: ALL tool calls from this turn. A model can request several at
   * once; reading `toolCall` alone drops the rest and then waits forever for
   * results the caller was never told to produce.
   */
  toolCalls?: LLMRouterToolCall[];
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
  /** VTID-03579: prior turns; `prompt` is appended as the current user turn. */
  history?: LLMRouterMessage[];
}

interface AdapterResult {
  ok: boolean;
  text?: string;
  toolCall?: LLMRouterToolCall;
  /** VTID-03579: every tool the model asked for this turn, in order. */
  toolCalls?: LLMRouterToolCall[];
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
// Permissive safety thresholds for Gemini. The default filters block benign
// wellness/coaching topics (relationships, weight, mental health, substance
// recovery) — e.g. a goal of "Find a life partner" came back empty and the
// planner surfaced no_plan_generated. BLOCK_ONLY_HIGH still blocks
// high-confidence harmful content while letting legitimate coaching through.
const GEMINI_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

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

    // VTID-02690: Preview models (e.g. `gemini-3.1-pro-preview`) are NOT
    // in the Vertex v1 publisher catalog the @google-cloud/vertexai Node
    // SDK queries — they're exposed via the consumer Generative Language
    // API (AI Studio). The Python google-genai used by livekit-plugins-
    // google with vertexai=True talks to a different Vertex endpoint
    // that DOES expose them. Until we migrate to @google/genai for Node,
    // route preview models directly to AI Studio (skips Vertex entirely).
    const isPreviewModel = /-preview\b/i.test(model);
    const aiStudioKey = process.env.GOOGLE_GEMINI_API_KEY;
    const skipVertex = isPreviewModel && Boolean(aiStudioKey);

    // Prefer Vertex AI when GOOGLE_CLOUD_PROJECT is set (Cloud Run path).
    // Fall back to Google AI Studio when only GOOGLE_GEMINI_API_KEY is present.
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (projectId && !skipVertex) {
      try {
        const { VertexAI } = await import('@google-cloud/vertexai');
        const location = process.env.VERTEX_LOCATION || 'us-central1';
        const vertex = new VertexAI({ project: projectId, location });
        const modelInit: Record<string, unknown> = {
          model,
          generationConfig: { maxOutputTokens: maxTokens ?? 8000 },
          safetySettings: GEMINI_SAFETY_SETTINGS,
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
        const candidateParts = (candidate?.content?.parts || []) as Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown> } }>;
        // Drop the model's "thinking" parts — gemini thinking models emit reasoning
        // as parts flagged thought=true; only the non-thought parts hold the answer.
        const text = candidateParts.filter(p => !p.thought).map(p => p.text || '').join('');
        const fnPart = candidateParts.find(p => !!p.functionCall);
        const toolCall = fnPart?.functionCall?.name && fnPart.functionCall.args
          ? { name: fnPart.functionCall.name, arguments: fnPart.functionCall.args }
          : undefined;
        const usageMeta = result.response?.usageMetadata;
        if (!text && !toolCall) {
          const finishReason = (candidate as any)?.finishReason;
          const blockReason = (result.response as any)?.promptFeedback?.blockReason;
          return { ok: false, error: `gemini_no_output finishReason=${finishReason ?? 'none'} blockReason=${blockReason ?? 'none'}` };
        }
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
    const apiKey = aiStudioKey;
    if (!apiKey) return { ok: false, error: 'No Vertex/Google AI credentials available' };
    if (skipVertex) {
      console.log(`[llm-router] preview model "${model}" — routing direct to AI Studio (skip Vertex)`);
    }
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
        safetySettings: GEMINI_SAFETY_SETTINGS,
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
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown> } }> } }>;
        promptFeedback?: { blockReason?: string };
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const candidate0 = json.candidates?.[0];
      const candidateParts = candidate0?.content?.parts || [];
      // Drop "thinking" parts (thought=true) — only non-thought parts hold the answer.
      const text = candidateParts.filter(p => !p.thought).map(p => p.text || '').join('');
      const fnPart = candidateParts.find(p => !!p.functionCall);
      const toolCall = fnPart?.functionCall?.name && fnPart.functionCall.args
        ? { name: fnPart.functionCall.name, arguments: fnPart.functionCall.args }
        : undefined;
      if (!text && !toolCall) {
        return {
          ok: false,
          error: `gemini_no_output finishReason=${candidate0?.finishReason ?? 'none'} blockReason=${json.promptFeedback?.blockReason ?? 'none'}`,
        };
      }
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
  async call({ prompt, model, systemPrompt, maxTokens, image, images, tools, forceTool, history }): Promise<AdapterResult> {
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

    // VTID-03579: DeepSeek is the standing fallback for every Bedrock stage, so
    // it has to carry conversation history too — otherwise a Bedrock blip would
    // silently drop the whole exchange and the model would answer the current
    // turn with no idea what came before. That is worse than a visible failure,
    // because it looks like the assistant simply forgot.
    //
    // DeepSeek speaks the OpenAI shape, where a tool round-trip is an assistant
    // message carrying `tool_calls` and one `role:'tool'` message per result —
    // not Anthropic's content blocks. Rendering happens here so the caller only
    // ever describes what happened, never a provider's wire format.
    for (const m of history ?? []) {
      if ('toolCalls' in m && m.toolCalls) {
        messages.push({
          role: 'assistant',
          content: m.content ?? null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id ?? tc.name,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else if ('toolResults' in m && m.toolResults) {
        for (const tr of m.toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: tr.id ?? tr.name,
            content: tr.result,
          });
        }
      } else if ('content' in m && typeof m.content === 'string') {
        messages.push({ role: m.role, content: m.content });
      }
    }

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

/**
 * Anthropic Claude via Amazon Bedrock — dormant until BEDROCK_ROLE_ARN is
 * set on a real deployment (VTID-03403; AWS IAM/model-access provisioning
 * requires AWS console/CLI access outside this codebase). Vision and tool
 * calling are not yet supported — see `call()` below.
 */
const bedrockAdapter: ProviderAdapter = {
  isAvailable: () => Boolean(process.env.BEDROCK_ROLE_ARN),
  async call({ prompt, model, systemPrompt, maxTokens, image, images, tools, forceTool, history }): Promise<AdapterResult> {
    // VTID-03496: images and tools are now supported. Bedrock speaks the same
    // Anthropic Messages API shape as `anthropicAdapter` above, so the content
    // blocks, tool schema key (`input_schema`) and `tool_choice` are built
    // identically — deliberately mirrored so the two stay easy to diff.
    const allImages: LLMRouterImage[] = [];
    if (images && images.length > 0) allImages.push(...images);
    if (image) allImages.push(image);

    // Text-only stays a plain string: it is the overwhelmingly common path and
    // keeps the request byte-identical to what shipped under VTID-03403.
    const content: BedrockContentBlock[] | string =
      allImages.length > 0
        ? [
            ...allImages.map(
              (img): BedrockContentBlock => ({
                type: 'image',
                source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
              }),
            ),
            { type: 'text', text: prompt },
          ]
        : prompt;

    const bedrockTools =
      tools && tools.length > 0
        ? tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          }))
        : undefined;

    const toolChoice =
      bedrockTools && typeof forceTool === 'number' && tools && tools[forceTool]
        ? ({ type: 'tool', name: tools[forceTool].name } as const)
        : undefined;

    // VTID-03579: prior turns render into Anthropic content blocks here rather
    // than in the caller, so an agentic caller never has to know Anthropic's
    // wire shape. tool_use/tool_result pair by id — an id that does not match
    // is a 400, not a degraded answer, so it is carried through verbatim.
    const historyMessages: Array<{
      role: 'user' | 'assistant';
      content: string | BedrockContentBlock[];
    }> = [];
    for (const m of history ?? []) {
      if ('toolCalls' in m && m.toolCalls) {
        const blocks: BedrockContentBlock[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id ?? tc.name,
            name: tc.name,
            input: tc.arguments,
          });
        }
        historyMessages.push({ role: 'assistant', content: blocks });
      } else if ('toolResults' in m && m.toolResults) {
        historyMessages.push({
          role: 'user',
          content: m.toolResults.map((tr) => ({
            type: 'tool_result' as const,
            tool_use_id: tr.id ?? tr.name,
            content: tr.result,
            ...(tr.isError ? { is_error: true } : {}),
          })),
        });
      } else if ('content' in m && typeof m.content === 'string') {
        historyMessages.push({ role: m.role, content: m.content });
      }
    }

    const result = await invokeBedrock({
      model,
      messages: [...historyMessages, { role: 'user', content }],
      system: systemPrompt,
      max_tokens: maxTokens,
      tools: bedrockTools,
      tool_choice: toolChoice,
    });

    if (!result.ok) {
      return { ok: false, error: `Bedrock ${result.error}: ${result.message}` };
    }
    return {
      ok: true,
      text: result.text,
      toolCall: result.toolCall,
      toolCalls: result.toolCalls,
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      },
    };
  },
};

const ADAPTERS: Record<LLMProvider, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  vertex: vertexAdapter,
  deepseek: deepseekAdapter,
  claude_subscription: claudeSubscriptionAdapter,
  bedrock: bedrockAdapter,
};

// =============================================================================
// Public API
// =============================================================================

/** Outcome of a provider preflight — see `verifyProvider()`. */
export interface ProviderVerifyResult {
  provider: LLMProvider;
  model: string;
  /** True only if the provider actually returned a completion. */
  ok: boolean;
  /** Why it failed, verbatim from the adapter — the whole point of this call. */
  error?: string;
  /** False when the provider's credentials env gate is unset (router SKIPS it). */
  available: boolean;
  latencyMs: number;
}

/**
 * Preflight a provider/model with a real, minimal completion (VTID-03565).
 *
 * This exists because nothing else in the codebase could answer "does this
 * provider actually work?". `GET /providers/health` reports env-var PRESENCE,
 * which is precisely the illusion that hid VTID-03563: `anthropic` reported
 * available while every call died on credit balance, and the router silently
 * served Gemini instead. A routing table states intent; only a real invoke
 * says who will actually serve the request.
 *
 * Deliberately routed through `ADAPTERS[provider]` — the exact map
 * `runProviderCall()` uses — so a preflight cannot pass via a code path the
 * real traffic does not take.
 *
 * Deliberately NOT recorded via startLLMCall/completeLLMCall: a preflight is
 * an operator action, not traffic, and booking it as `llm.call.completed`
 * would corrupt the very telemetry used to decide whether a flip worked.
 */
export async function verifyProvider(
  provider: LLMProvider,
  model: string,
): Promise<ProviderVerifyResult> {
  const startedAt = Date.now();
  const base = { provider, model, latencyMs: 0 };
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    return { ...base, ok: false, available: false, error: `Unknown provider '${provider}'` };
  }
  if (!adapter.isAvailable()) {
    return {
      ...base,
      ok: false,
      available: false,
      error: `Provider '${provider}' has no credentials configured — the router SKIPS it and serves the fallback instead`,
    };
  }

  try {
    const result = await adapter.call({
      prompt: 'Reply with exactly: OK',
      model,
      maxTokens: 16,
    });
    return {
      provider,
      model,
      available: true,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Adapters are contractually non-throwing, but a preflight that itself
    // throws would report as a route 500 and tell the operator nothing.
    return {
      provider,
      model,
      available: true,
      ok: false,
      error: `adapter threw: ${String(err).slice(0, 300)}`,
      latencyMs: Date.now() - startedAt,
    };
  }
}

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
  // VTID-03565: `| undefined` is not defensive typing — the ACTIVE production
  // policy really does omit `vision`/`classifier`, and `loadPolicy()` takes the
  // stored row wholesale rather than merging per-stage defaults (unlike
  // `getStageRoutingConfig()`, which does merge). The guard below was already
  // correct; only the annotation claimed otherwise.
  const stageConfig: StageRoutingConfig | undefined = policy[stage];
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
    history: opts.history,
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
      toolCalls: result.toolCalls,
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
