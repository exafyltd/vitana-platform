/**
 * VTID-01184: Embedding Generation Service
 *
 * Embeddings for the non-memory vector columns (user_intents, vtid_ledger
 * dedup, the navigation catalog). User memory uses `memory-embedding.ts`
 * (Titan V2, 1024 dims) instead.
 *
 * VTID-04457: one provider, Amazon Titan Text Embeddings V1 via Bedrock
 * (1536 dims, the size of these columns; see providers/titan-embedding.ts).
 * The OpenAI rung and the Gemini rung are gone:
 *   - OpenAI failed 219 times in the 30 days before this change, and when it
 *     did succeed it wrote vectors into the same columns as Titan. Vectors
 *     from two providers are not comparable even at the same length, so
 *     similarity across that mix is meaningless.
 *   - Gemini was the last resort and fired twice on 2026-09-22: a Google
 *     dependency the platform rules forbid.
 * A failure is returned as `ok:false` and reported once; the callers already
 * treat a missing embedding as non-fatal (the intent worker retries NULLs).
 *
 * This service is STATELESS - it only generates embeddings,
 * it does not store them. Storage is handled by Supabase.
 */

import { emitOasisEvent } from './oasis-event-service';
// VTID-01970 Tier 1: in-process LRU cache for embeddings (sha256(text)→vector)
import { getCachedEmbedding, setCachedEmbedding } from './embedding-cache';
import {
  generateTitanEmbedding,
  getTitanEmbeddingModelId,
  TITAN_EMBEDDING_DIMENSIONS,
} from '../providers/titan-embedding';

// =============================================================================
// Configuration
// =============================================================================

const VTID = 'VTID-01184';
const SERVICE_NAME = 'embedding-service';

/** Size of the vector columns this service writes (Titan V1 native output). */
export const EMBEDDING_DIMENSIONS = TITAN_EMBEDDING_DIMENSIONS;

// =============================================================================
// Types
// =============================================================================

export interface EmbeddingRequest {
  text: string;
  model?: string;
}

export interface EmbeddingResponse {
  ok: boolean;
  embedding?: number[];
  model?: string;
  dimensions?: number;
  latency_ms?: number;
  error?: string;
}

export interface BatchEmbeddingRequest {
  texts: string[];
  model?: string;
}

export interface BatchEmbeddingResponse {
  ok: boolean;
  embeddings?: number[][];
  model?: string;
  dimensions?: number;
  latency_ms?: number;
  error?: string;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate an embedding for one text with Titan (Bedrock).
 *
 * @returns Embedding vector (1536 dimensions), or ok:false
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResponse> {
  // VTID-01970 Tier 1 hot cache — return cached vector when available.
  const cached = getCachedEmbedding(text);
  if (cached) {
    return {
      ok: true,
      embedding: cached.vector,
      model: cached.model,
      dimensions: cached.dimensions,
      latency_ms: 0, // hot-cache hit
    };
  }

  const titan = await generateTitanEmbedding(text);
  if (titan.ok) {
    setCachedEmbedding(text, titan.embedding, titan.model, titan.dimensions);
    return {
      ok: true,
      embedding: titan.embedding,
      model: titan.model,
      dimensions: titan.dimensions,
      latency_ms: titan.latency_ms,
    };
  }

  const error = `${titan.error}: ${titan.message}`;
  console.error(`[${VTID}] Titan embedding failed: ${error}`);
  await emitOasisEvent({
    vtid: VTID,
    type: 'embedding.all_providers_failed',
    source: SERVICE_NAME,
    status: 'error',
    message: `Titan embedding failed: ${error}`,
    payload: { provider: 'titan_bedrock', model: getTitanEmbeddingModelId(), titan_error: error },
  }).catch(() => {});

  return { ok: false, error };
}

/**
 * Generate embeddings for several texts, one Titan call each (Titan has no
 * batch endpoint). Fails as a whole on the first failure, so the caller never
 * gets a partial list whose indexes no longer line up with its input.
 */
export async function generateBatchEmbeddings(texts: string[]): Promise<BatchEmbeddingResponse> {
  const model = getTitanEmbeddingModelId();
  if (texts.length === 0) {
    return { ok: true, embeddings: [], model, dimensions: EMBEDDING_DIMENSIONS, latency_ms: 0 };
  }

  const start = Date.now();
  const embeddings: number[][] = [];
  for (const text of texts) {
    const r = await generateEmbedding(text);
    if (!r.ok || !r.embedding) {
      return { ok: false, error: `Batch failed at index ${embeddings.length}: ${r.error}` };
    }
    embeddings.push(r.embedding);
  }

  const latency = Date.now() - start;
  console.log(`[${VTID}] Batch embeddings generated: ${texts.length} texts, ${latency}ms`);
  await emitOasisEvent({
    vtid: VTID,
    type: 'embedding.batch_generated',
    source: SERVICE_NAME,
    status: 'success',
    message: `Generated ${texts.length} embeddings via titan_bedrock/${model}`,
    payload: {
      count: texts.length,
      dimensions: EMBEDDING_DIMENSIONS,
      latency_ms: latency,
      // VTID-03579: always name who served the request.
      provider: 'titan_bedrock',
      model,
    },
  }).catch(() => {});

  return { ok: true, embeddings, model, dimensions: EMBEDDING_DIMENSIONS, latency_ms: latency };
}

/**
 * Check if embedding service is available (Titan needs BEDROCK_ROLE_ARN).
 */
export function isEmbeddingServiceAvailable(): { available: boolean; providers: string[] } {
  const providers = process.env.BEDROCK_ROLE_ARN ? ['titan_bedrock'] : [];
  return { available: providers.length > 0, providers };
}
