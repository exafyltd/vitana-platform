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

export interface BedrockInvokeRequest {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Top-level system prompt, matching Anthropic's Messages API shape
   *  (including via Bedrock) — NOT a role:'system' entry in `messages`. */
  system?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
}

export interface BedrockInvokeResponse {
  ok: true;
  text: string;
  model: string;
  upstream_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface BedrockInvokeError {
  ok: false;
  error: 'not_configured' | 'invoke_failed';
  message: string;
}

const BEDROCK_ROLE_ARN = process.env.BEDROCK_ROLE_ARN;
const BEDROCK_REGION = process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';

export async function invokeBedrock(
  req: BedrockInvokeRequest,
): Promise<BedrockInvokeResponse | BedrockInvokeError> {
  if (!BEDROCK_ROLE_ARN) {
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
      region: BEDROCK_REGION,
      requestHandler: new NodeHttpHandler(),
    });
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: req.max_tokens ?? 2048,
      temperature: req.temperature ?? 0.5,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
    });
    const command = new InvokeModelCommand({
      modelId: req.model,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });
    const resp = await client.send(command);
    const payload = JSON.parse(new TextDecoder().decode(resp.body));
    const text = Array.isArray(payload.content) && payload.content[0]?.text ? payload.content[0].text : '';
    return {
      ok: true,
      text,
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
