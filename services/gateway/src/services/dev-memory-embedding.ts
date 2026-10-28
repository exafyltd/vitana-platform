/**
 * VTID-03889 — Operator Memory embedding client.
 *
 * Generates embeddings for dev_agent_memory via Amazon Titan Embeddings G2
 * (amazon.titan-embed-text-v2:0, 1024 dims) over Bedrock. Deliberately NOT
 * OpenAI/Gemini (the embedding-service.ts pattern used by Memory Garden) --
 * this platform's standing rule is Bedrock for everything AI, and reusing
 * an already-provisioned BEDROCK_ROLE_ARN avoids a second credential to
 * keep alive. Verified with a real `aws bedrock-runtime invoke-model` call
 * before this file was written (2026-09-14) -- not assumed to work because
 * it's configured; see VTID-03889's acceptance doc for the raw output.
 *
 * Every caller that writes to dev_agent_memory MUST go through
 * generateDevMemoryEmbedding() and MUST fail loudly (never insert a
 * null/zero-vector fallback) if it returns ok:false -- the embedding column
 * is NOT NULL specifically so that mistake cannot compile past the DB.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export const DEV_MEMORY_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
export const DEV_MEMORY_EMBEDDING_DIMENSIONS = 1024;

export interface DevMemoryEmbeddingResult {
  ok: true;
  embedding: number[];
  model: string;
  latency_ms: number;
}

export interface DevMemoryEmbeddingError {
  ok: false;
  error: string;
  message: string;
}

function bedrockRoleArn(): string | undefined {
  return process.env.BEDROCK_ROLE_ARN;
}

function bedrockRegion(): string {
  return process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || 'eu-central-1';
}

/**
 * Generate a Titan Embeddings G2 vector for the given text.
 *
 * Same HTTP/1.1 forcing as invokeBedrock() in providers/bedrock.ts -- the
 * SDK's default handler can negotiate HTTP/2 against Bedrock Runtime's
 * regional endpoint, which breaks inside this platform's sandboxed network
 * stack (VTID-03403).
 */
export async function generateDevMemoryEmbedding(
  text: string,
): Promise<DevMemoryEmbeddingResult | DevMemoryEmbeddingError> {
  if (!bedrockRoleArn()) {
    return {
      ok: false,
      error: 'not_configured',
      message: 'BEDROCK_ROLE_ARN env var not set; cannot generate embeddings without it.',
    };
  }
  if (!text || text.trim().length === 0) {
    return { ok: false, error: 'empty_text', message: 'Cannot embed empty text.' };
  }

  const start = Date.now();
  try {
    const client = new BedrockRuntimeClient({
      region: bedrockRegion(),
      requestHandler: new NodeHttpHandler(),
    });
    const command = new InvokeModelCommand({
      modelId: DEV_MEMORY_EMBEDDING_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text }),
    });
    const resp = await client.send(command);
    const payload = JSON.parse(new TextDecoder().decode(resp.body));
    const embedding = payload?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== DEV_MEMORY_EMBEDDING_DIMENSIONS) {
      return {
        ok: false,
        error: 'unexpected_response_shape',
        message: `Expected a ${DEV_MEMORY_EMBEDDING_DIMENSIONS}-dim embedding array, got: ${JSON.stringify(payload).slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      embedding,
      model: DEV_MEMORY_EMBEDDING_MODEL,
      latency_ms: Date.now() - start,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: 'invoke_failed',
      message: err?.message || String(err),
    };
  }
}
