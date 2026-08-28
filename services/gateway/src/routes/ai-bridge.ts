/**
 * AI Bridge — Gemini-shaped facade over Bedrock (Aurora migration B7,
 * VTID-03764 chain / AURORA-B7-EDGE-FUNCTIONS-INVENTORY.md).
 *
 * Why this exists: 23 of vitana-v1's 74 Supabase edge functions call the
 * Gemini Developer API or Vertex AI directly, in direct violation of this
 * repo's own standing rule (CLAUDE.md ALWAYS 10a/10b — "Always use Claude via
 * AWS Bedrock. Always... Never route a stage at the direct Anthropic API" —
 * and by extension, never at Google, per NEVER 27/IF-THEN 27). Six of those
 * functions (ai-chat, extract-diary-insights, generate-enhanced-
 * recommendations, generate-proactive-greeting, social-media-import,
 * transcribe-audio) are frontend-reachable and share one call surface:
 * `_shared/gemini-client.ts`'s `generateContent()` / `extractTextFromResponse()`
 * / `extractFunctionCall()`.
 *
 * Rather than give every edge function its own AWS SDK dependency (Deno edge
 * runtimes are not where `BEDROCK_ROLE_ARN`/IAM-role credentials live, and
 * duplicating `invokeBedrock()`'s HTTP/1.1-forcing client six times risks the
 * exact "five copies drift" failure mode this codebase's own CHANGE LOG has
 * hit repeatedly), this route puts ONE Bedrock call point on the gateway
 * (which already owns `invokeBedrock()`, VTID-03403/03496/03579) and has each
 * edge function's shared client call it instead — the vitana-v1 companion is
 * `supabase/functions/_shared/bedrock-bridge-client.ts`, which intentionally
 * mirrors `gemini-client.ts`'s exact function signatures so each consuming
 * edge function needs only a one-line import swap.
 *
 * The request/response shapes below are deliberately Gemini-response-shaped
 * (`candidates[0].content.parts[]`) rather than Bedrock/Anthropic-shaped —
 * that is what lets `extractTextFromResponse`/`extractFunctionCall` on the
 * vitana-v1 side stay byte-for-byte the same functions, reading the same
 * paths, regardless of which provider answered.
 *
 * Auth: this is a service-to-service call (Supabase edge function → gateway),
 * never a user-facing route, so it is gated by the same
 * `requireServiceOrAdmin` used for self-healing's `/report` — a
 * `GATEWAY_SERVICE_TOKEN` bearer token (or an exafy_admin JWT, for manual
 * testing from the Command Hub) is required. There is no anonymous path.
 */

import { Router, Request, Response } from 'express';
import { invokeBedrock, type BedrockContentBlock, type BedrockTool } from '../providers/bedrock';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';

const router = Router();

// Same cross-region inference profile default the rest of the codebase uses
// (constants/llm-defaults.ts PROVIDER_FLAGSHIPS.bedrock) — kept as a local
// literal fallback here deliberately: this route must not require importing
// the full llm-router module graph just to resolve one default string.
const DEFAULT_BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6';

interface BridgeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface BridgeToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface BridgeGenerateOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  // topP/topK accepted for interface parity with GeminiGenerateOptions but
  // Bedrock's Anthropic wire shape has no equivalent knob — silently ignored,
  // same as any other provider-specific option a shared caller doesn't use.
  topP?: number;
  topK?: number;
}

interface BridgeGenerateRequestBody {
  messages?: BridgeMessage[];
  options?: BridgeGenerateOptions;
  tools?: BridgeToolDeclaration[];
}

/**
 * Gemini's `generateContent` takes a flat message list including any
 * `role: 'system'` entries; Anthropic/Bedrock wants the system prompt
 * top-level and only user/assistant turns in `messages`. Concatenating
 * multiple system entries (rare, but Gemini's shape technically allows it)
 * keeps this a lossless translation instead of silently dropping any but
 * the first.
 */
function splitSystemAndTurns(messages: BridgeMessage[]): {
  system: string | undefined;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      turns.push({ role: m.role, content: m.content });
    }
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, turns };
}

function toBedrockTools(tools?: BridgeToolDeclaration[]): BedrockTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/**
 * Bedrock/Anthropic-shape response body -> Gemini-shape response body.
 * A tool call becomes a `functionCall` part; plain text becomes a `text`
 * part. Anthropic can in principle return several tool_use blocks in one
 * turn — Gemini's shape has no multi-call convention `extractFunctionCall`
 * understands, so (matching that function's own single-call contract) only
 * the first is surfaced as a part; the rest are simply not representable in
 * this facade today and would need a real multi-call caller before adding.
 */
function toGeminiShapedResponse(
  text: string,
  toolCall: { name: string; arguments: Record<string, unknown> } | undefined,
): unknown {
  const parts: unknown[] = [];
  if (toolCall) {
    parts.push({ functionCall: { name: toolCall.name, args: toolCall.arguments } });
  }
  if (text) {
    parts.push({ text });
  }
  return { candidates: [{ content: { role: 'model', parts } }] };
}

router.post('/generate', requireServiceOrAdmin, async (req: Request, res: Response) => {
  const body = req.body as BridgeGenerateRequestBody;

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    res.status(400).json({ ok: false, error: 'messages must be a non-empty array' });
    return;
  }

  const { system, turns } = splitSystemAndTurns(body.messages);
  if (turns.length === 0) {
    res.status(400).json({ ok: false, error: 'messages must contain at least one user/assistant turn' });
    return;
  }

  const bedrockMessages: Array<{ role: 'user' | 'assistant'; content: string | BedrockContentBlock[] }> =
    turns.map((t) => ({ role: t.role, content: t.content }));

  const result = await invokeBedrock({
    model: body.options?.model || DEFAULT_BEDROCK_MODEL,
    messages: bedrockMessages,
    system,
    max_tokens: body.options?.maxOutputTokens,
    temperature: body.options?.temperature,
    tools: toBedrockTools(body.tools),
  });

  if (!result.ok) {
    // 502: the caller's request was well-formed, but the upstream provider
    // (Bedrock itself, or its not-yet-provisioned state) failed to answer.
    res.status(502).json({ ok: false, error: result.error, message: result.message });
    return;
  }

  res.status(200).json(toGeminiShapedResponse(result.text, result.toolCall));
});

export default router;
