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
    };

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
}

export interface BedrockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface BedrockInvokeResponse {
  ok: true;
  text: string;
  /** VTID-03496: populated when the model emitted a `tool_use` block. */
  toolCall?: BedrockToolCall;
  /** Anthropic stop reason, e.g. 'tool_use' | 'end_turn' | 'max_tokens'. */
  stopReason?: string;
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
  content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>;
}): { text: string; toolCall?: BedrockToolCall } {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  const toolBlock = blocks.find((b) => b?.type === 'tool_use');
  const toolCall =
    toolBlock && typeof toolBlock.name === 'string' && toolBlock.input && typeof toolBlock.input === 'object'
      ? { name: toolBlock.name, arguments: toolBlock.input }
      : undefined;
  return { text, toolCall };
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
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: req.max_tokens ?? 2048,
      temperature: req.temperature ?? 0.5,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
      // VTID-03496: tools/tool_choice are now serialized. Omitted entirely
      // when absent — Bedrock rejects a null/empty `tools` key rather than
      // treating it as "no tools".
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
      ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
    });
    const command = new InvokeModelCommand({
      modelId: req.model,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });
    const resp = await client.send(command);
    const payload = JSON.parse(new TextDecoder().decode(resp.body));
    const { text, toolCall } = parseBedrockContent(payload);
    return {
      ok: true,
      text,
      toolCall,
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
