/**
 * Amazon Titan Text Embeddings provider (Bedrock).
 *
 * Closes finding #1/#2 of `docs/GATEWAY-GOOGLE-DEPENDENCY-AUDIT-2026-08-28.md`:
 * `embedding-service.ts` fell back to the Gemini Developer API
 * (`GOOGLE_GEMINI_API_KEY`) on every OpenAI embedding failure, unconditionally
 * and unflagged, on the hot path behind every memory/semantic-search write —
 * a live, quiet violation of CLAUDE.md's standing "no Google dependency left
 * at all" rule (NEVER 27 / IF-THEN 27).
 *
 * That audit flagged this as real architectural work, not a one-line swap,
 * specifically because "Titan's embedding dimension doesn't match the
 * existing vector(1536)/vector(768) columns either." That is true of
 * **Titan Text Embeddings V2** (`amazon.titan-embed-text-v2:0`), which only
 * supports 256/512/1024-dim output. It is NOT true of **V1**
 * (`amazon.titan-embed-text-v1`), which has always emitted a fixed
 * 1536-dim vector — verified against the live API in `eu-central-1`
 * 2026-08-28 (`aws bedrock-runtime invoke-model`, real `embedding.length`
 * checked, not assumed from docs) — an exact match for
 * `memory_items.embedding vector(1536)` with zero migration. V1 is the
 * model this provider uses; do not "upgrade" to V2 without also migrating
 * the column and every existing vector it holds.
 *
 * Same deliberate-opt-in shape as `titan-image.ts` (§2d) and
 * `providers/bedrock.ts` (§2b): gated on `BEDROCK_ROLE_ARN` alone, no
 * separate feature flag. Unset (today's default everywhere `bedrock-role`
 * provisioning hasn't landed) means this reports `not_configured` and
 * `embedding-service.ts` falls through to its pre-existing behavior —
 * importing this file changes nothing until Bedrock is actually configured,
 * matching every other Bedrock-gated seam in this codebase. Once
 * `BEDROCK_ROLE_ARN` is set (already required for the standing
 * Claude-on-Bedrock LLM routing decision, VTID-03563), this closes the
 * Google gap automatically — no second flag to remember to flip.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/** Fixed native output size of amazon.titan-embed-text-v1. Not configurable. */
export const TITAN_EMBEDDING_DIMENSIONS = 1536;

export function getTitanEmbeddingRegion(): string {
  return (
    process.env.AWS_TITAN_EMBEDDING_REGION ||
    process.env.AWS_BEDROCK_REGION ||
    process.env.AWS_REGION ||
    'us-east-1'
  );
}

export function getTitanEmbeddingModelId(): string {
  return process.env.TITAN_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v1';
}

export interface TitanEmbeddingSuccess {
  ok: true;
  embedding: number[];
  model: string;
  dimensions: number;
  latency_ms: number;
}

export interface TitanEmbeddingError {
  ok: false;
  error: 'not_configured' | 'invoke_failed' | 'empty_output';
  message: string;
  latency_ms?: number;
}

export type TitanEmbeddingResult = TitanEmbeddingSuccess | TitanEmbeddingError;

let titanEmbeddingClient: BedrockRuntimeClient | null = null;
function getTitanEmbeddingClient(): BedrockRuntimeClient {
  if (!titanEmbeddingClient) {
    // Same HTTP/1.1 forcing as providers/bedrock.ts / titan-image.ts — the
    // SDK's default handler can negotiate HTTP/2, which has broken before in
    // a sandboxed container network stack (NGHTTP2_PROTOCOL_ERROR, VTID-03403).
    titanEmbeddingClient = new BedrockRuntimeClient({
      region: getTitanEmbeddingRegion(),
      requestHandler: new NodeHttpHandler(),
    });
  }
  return titanEmbeddingClient;
}

/** Test seam — drop the memoized client so a new region/mock applies. */
export function resetTitanEmbeddingClientForTests(): void {
  titanEmbeddingClient = null;
}

/** Generate a single embedding via Titan Text Embeddings V1. */
export async function generateTitanEmbedding(text: string): Promise<TitanEmbeddingResult> {
  if (!process.env.BEDROCK_ROLE_ARN) {
    return {
      ok: false,
      error: 'not_configured',
      message: 'BEDROCK_ROLE_ARN not set; Titan embeddings dormant',
    };
  }

  const model = getTitanEmbeddingModelId();
  const start = Date.now();
  try {
    const resp = await getTitanEmbeddingClient().send(
      new InvokeModelCommand({
        modelId: model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text }),
      }),
    );
    const payload = JSON.parse(new TextDecoder().decode(resp.body)) as {
      embedding?: number[];
    };
    const embedding = payload.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      return {
        ok: false,
        error: 'empty_output',
        message: 'Titan returned no embedding',
        latency_ms: Date.now() - start,
      };
    }
    return {
      ok: true,
      embedding,
      model,
      dimensions: embedding.length,
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      error: 'invoke_failed',
      message: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    };
  }
}
