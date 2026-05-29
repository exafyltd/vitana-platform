/**
 * Anthropic-via-Bedrock provider — Phase 1 W1 (VTID-03181 VOICE-LAT).
 *
 * DORMANT in W1. Activates in W3+ once an AWS account is provisioned and
 * BEDROCK_ROLE_ARN env var is set. The runtime check below early-returns
 * a typed error so callers can fall back to Vertex/Anthropic seamlessly.
 *
 * The @aws-sdk/client-bedrock-runtime dep is NOT added in W1 — we use a
 * dynamic require() inside the function so the build stays green without
 * the install. When BEDROCK_ROLE_ARN is set in W3, the corresponding PR
 * also runs `npm i @aws-sdk/client-bedrock-runtime` in the same commit.
 *
 * Wire path: conversation-router.ts (W4 migration) reads
 * preferred_provider='bedrock' and routes here. Until then, this module
 * is unreferenced — included only so the import surface is fixed.
 */

export interface BedrockInvokeRequest {
  model: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
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
  error: 'not_configured' | 'sdk_missing' | 'invoke_failed';
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
      message: 'BEDROCK_ROLE_ARN env var not set; Bedrock is dormant until W3 AWS provisioning lands',
    };
  }

  let BedrockRuntimeClient: unknown;
  let InvokeModelCommand: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@aws-sdk/client-bedrock-runtime');
    BedrockRuntimeClient = mod.BedrockRuntimeClient;
    InvokeModelCommand = mod.InvokeModelCommand;
  } catch {
    return {
      ok: false,
      error: 'sdk_missing',
      message: '@aws-sdk/client-bedrock-runtime not installed; run `npm i @aws-sdk/client-bedrock-runtime` then redeploy',
    };
  }

  const start = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (BedrockRuntimeClient as any)({ region: BEDROCK_REGION });
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: req.max_tokens ?? 2048,
      temperature: req.temperature ?? 0.5,
      messages: req.messages,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const command = new (InvokeModelCommand as any)({
      modelId: req.model,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (client as any).send(command);
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
