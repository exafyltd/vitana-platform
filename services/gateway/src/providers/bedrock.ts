import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/**
 * Anthropic-via-Bedrock provider (VTID-03181 VOICE-LAT W1; wired in
 * VTID-03403 W3/W4, reopened from VTID-03402 after an autopilot false
 * completion — see VTID-03402/03403 spec history).
 *
 * Still dormant until BEDROCK_ROLE_ARN is set on a real deployment (AWS
 * IAM/model-access provisioning is tracked separately in VTID-03403 and
 * requires AWS console/CLI access). The runtime check below early-returns
 * a typed error so callers can fall back to another provider seamlessly.
 *
 * Wire path: services/gateway/src/services/llm-router.ts registers a
 * `bedrockAdapter` in its `ADAPTERS` map, calling `invokeBedrock()` below.
 * There is no `conversation-router.ts` and no `preferred_provider` field —
 * that mechanism never existed; the real dispatch is per-stage via the
 * DB-backed `llm_routing_policy`, same as every other provider.
 */

/**
 * Anthropic Messages API content blocks, as accepted by Bedrock's
 * `anthropic_version: 'bedrock-2023-05-31'` payload. Identical wire shape to
 * the direct Anthropic API — that equivalence is the whole reason vision and
 * tool-calling work here without a second serializer.
 */
export type BedrockContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  // VTID-03579: the two blocks an agentic loop needs. A tool-calling turn is
  // three messages, not one — the model's tool_use, the caller's tool_result,
  // and the model's follow-up — and Anthropic pairs them by `id`/`tool_use_id`.
  // Without these the operator's tool round-trip cannot be expressed at all.
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  // VTID-04868: extended-thinking blocks. Opaque — they must be echoed back
  // unchanged (signature / data included) on the assistant turn they came from.
  | BedrockThinkingBlock;

/**
 * VTID-04868: a thinking block as returned by the Messages API. Kept as an
 * open record on purpose: any field the API adds later is carried back
 * verbatim instead of being stripped by a narrower type.
 */
export type BedrockThinkingBlock =
  | ({ type: 'thinking'; thinking: string; signature: string } & Record<string, unknown>)
  | ({ type: 'redacted_thinking'; data: string } & Record<string, unknown>);

/** VTID-04868: adaptive thinking (Claude 4.6+). */
export type BedrockThinkingConfig = { type: 'adaptive' };
/** VTID-04868: output_config.effort levels accepted by Opus 4.6. */
export type BedrockEffort = 'low' | 'medium' | 'high' | 'max';

export interface BedrockTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments (Anthropic calls this input_schema). */
  input_schema: unknown;
}

/** Anthropic's tool_choice. 'any' forces some tool; 'tool' forces a named one. */
export type BedrockToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface BedrockInvokeRequest {
  model: string;
  /**
   * VTID-03496: `content` widened from `string` to also accept structured
   * blocks, which is what carries images. Plain strings still work unchanged.
   */
  messages: Array<{ role: 'user' | 'assistant'; content: string | BedrockContentBlock[] }>;
  /** Top-level system prompt, matching Anthropic's Messages API shape
   *  (including via Bedrock) — NOT a role:'system' entry in `messages`. */
  system?: string;
  max_tokens?: number;
  temperature?: number;
  /**
   * VTID-03496: previously declared here but NEVER serialized into the request
   * body — callers passing tools got a plain text completion with no error and
   * no tool call. Now actually sent.
   */
  tools?: BedrockTool[];
  tool_choice?: BedrockToolChoice;
  /**
   * VTID-04868: extended thinking. Omitted ⇒ not sent (default, unchanged
   * request body). When set, `temperature` is NOT sent — the Messages API
   * rejects a non-default temperature alongside thinking.
   */
  thinking?: BedrockThinkingConfig;
  /** VTID-04868: passed through as `output_config` (e.g. `{ effort: 'high' }`). Omitted ⇒ not sent. */
  output_config?: { effort?: BedrockEffort };
}

export interface BedrockToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /**
   * VTID-03579: the provider-assigned tool_use id. Required to send the result
   * back — Anthropic matches a tool_result to its tool_use by this id, and a
   * mismatched or missing id is a hard 400, not a soft degradation.
   */
  id?: string;
}

export interface BedrockInvokeResponse {
  ok: true;
  text: string;
  /** VTID-03496: populated when the model emitted a `tool_use` block. */
  toolCall?: BedrockToolCall;
  /**
   * VTID-03579: ALL tool_use blocks, in order. Claude can request several tools
   * in one turn; `toolCall` reports only the first, so an agentic caller reading
   * it alone would silently drop the rest and then hang waiting for results it
   * never asked for. `toolCall` is kept as the first element for back-compat.
   */
  toolCalls?: BedrockToolCall[];
  /** Anthropic stop reason, e.g. 'tool_use' | 'end_turn' | 'max_tokens'. */
  stopReason?: string;
  /**
   * VTID-04868: thinking / redacted_thinking blocks, VERBATIM and in response
   * order. Empty unless the request enabled thinking.
   */
  thinkingBlocks?: BedrockThinkingBlock[];
  model: string;
  upstream_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface BedrockInvokeError {
  ok: false;
  error: 'not_configured' | 'invoke_failed';
  message: string;
}

// VTID-03496: read at call time, not module load. Previously these were
// captured once at import, so a task definition that sets BEDROCK_ROLE_ARN
// could not be exercised without a process restart, and tests could not
// toggle configured/not-configured. Behaviour is otherwise identical.
function bedrockRoleArn(): string | undefined {
  return process.env.BEDROCK_ROLE_ARN;
}
function bedrockRegion(): string {
  return process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
}

/**
 * Extract the text and tool_use blocks from an Anthropic Messages response.
 *
 * VTID-03496: the previous implementation read `content[0]?.text` only. With a
 * forced tool call the FIRST block is `tool_use`, which has no `.text`, so
 * text came back empty; and with multiple text blocks it silently truncated to
 * the first. Both are now handled by filtering across all blocks.
 */
export function parseBedrockContent(payload: {
  content?: Array<{
    type?: string;
    text?: string;
    name?: string;
    id?: string;
    input?: Record<string, unknown>;
    [k: string]: unknown;
  }>;
}): { text: string; toolCall?: BedrockToolCall; toolCalls: BedrockToolCall[]; thinkingBlocks: BedrockThinkingBlock[] } {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  // VTID-03579: collect EVERY tool_use block, not just the first. Claude emits
  // parallel tool calls in a single turn; taking `.find()` silently executed one
  // and dropped the others, which reads downstream as the model ignoring its own
  // request.
  const toolCalls = blocks
    .filter(
      (b) =>
        b?.type === 'tool_use' &&
        typeof b.name === 'string' &&
        b.input &&
        typeof b.input === 'object',
    )
    .map((b) => ({
      name: b.name as string,
      arguments: b.input as Record<string, unknown>,
      id: typeof b.id === 'string' ? b.id : undefined,
    }));
  // VTID-04868: thinking blocks are kept exactly as received (a shallow copy of
  // the whole block, every field) — re-serialising them from a narrower shape
  // would drop the signature and the next tool turn would be rejected.
  const thinkingBlocks = blocks
    .filter((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking')
    .map((b) => ({ ...b }) as BedrockThinkingBlock);
  return { text, toolCall: toolCalls[0], toolCalls, thinkingBlocks };
}

export async function invokeBedrock(
  req: BedrockInvokeRequest,
): Promise<BedrockInvokeResponse | BedrockInvokeError> {
  if (!bedrockRoleArn()) {
    return {
      ok: false,
      error: 'not_configured',
      message: 'BEDROCK_ROLE_ARN env var not set; Bedrock is dormant until AWS provisioning lands (VTID-03403)',
    };
  }

  const start = Date.now();
  try {
    // Force HTTP/1.1: the SDK's default handler can negotiate HTTP/2 against
    // Bedrock Runtime's regional endpoint, which breaks inside Cloud Run's
    // sandboxed network stack (NGHTTP2_PROTOCOL_ERROR — confirmed via a real
    // staging call in VTID-03403). NodeHttpHandler forces HTTP/1.1.
    const client = new BedrockRuntimeClient({
      region: bedrockRegion(),
      requestHandler: new NodeHttpHandler(),
    });
    const body = JSON.stringify(buildBedrockRequestBody(req));
    const command = new InvokeModelCommand({
      modelId: req.model,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });
    const resp = await client.send(command);
    const payload = JSON.parse(new TextDecoder().decode(resp.body));
    const { text, toolCall, toolCalls, thinkingBlocks } = parseBedrockContent(payload);
    return {
      ok: true,
      text,
      toolCall,
      toolCalls,
      ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
      stopReason: typeof payload?.stop_reason === 'string' ? payload.stop_reason : undefined,
      model: req.model,
      upstream_ms: Date.now() - start,
      usage: {
        input_tokens: payload.usage?.input_tokens,
        output_tokens: payload.usage?.output_tokens,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: 'invoke_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build the InvokeModel JSON body. Pure; exported for tests (VTID-04868).
 * Without `thinking`/`output_config` the body is exactly what shipped before.
 */
export function buildBedrockRequestBody(req: BedrockInvokeRequest): Record<string, unknown> {
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: req.max_tokens ?? 2048,
    // VTID-04868: temperature is omitted when thinking is on (the API only
    // accepts the default with extended thinking).
    ...(req.thinking ? {} : { temperature: req.temperature ?? 0.5 }),
    ...(req.system ? { system: req.system } : {}),
    messages: req.messages,
    // VTID-03496: tools/tool_choice are now serialized. Omitted entirely
    // when absent — Bedrock rejects a null/empty `tools` key rather than
    // treating it as "no tools".
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
    ...(req.thinking ? { thinking: req.thinking } : {}),
    ...(req.output_config ? { output_config: req.output_config } : {}),
  };
}
