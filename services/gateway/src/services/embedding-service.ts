/**
 * VTID-01184: Embedding Generation Service
 *
 * Provides embedding generation for semantic memory operations.
 * Supports multiple providers with fallback:
 * 1. OpenAI text-embedding-3-small (primary)
 * 2. Amazon Titan Text Embeddings V1 via Bedrock (fallback — AWS-native,
 *    gated on BEDROCK_ROLE_ARN; see providers/titan-embedding.ts)
 * 3. Gemini embedding (last-resort only — see the "Google is a policy
 *    violation, not a normal fallback" note below generateEmbedding())
 *
 * This service is STATELESS - it only generates embeddings,
 * it does not store them. Storage is handled by Supabase.
 */

import { emitOasisEvent } from './oasis-event-service';
// VTID-01970 Tier 1: in-process LRU cache for embeddings (sha256(text)→vector)
import { getCachedEmbedding, setCachedEmbedding, getCacheStats } from './embedding-cache';
// Closes GATEWAY-GOOGLE-DEPENDENCY-AUDIT-2026-08-28 finding #1/#2 — see
// providers/titan-embedding.ts header for why V1 (not V2) is the right model.
import {
  generateTitanEmbedding,
  getTitanEmbeddingModelId,
  TITAN_EMBEDDING_DIMENSIONS,
  type TitanEmbeddingResult,
} from '../providers/titan-embedding';

// =============================================================================
// Configuration
// =============================================================================

const VTID = 'VTID-01184';
const SERVICE_NAME = 'embedding-service';

// Embedding dimensions — must match memory_items.embedding column (vector(1536))
// and OpenAI text-embedding-3-small native output (1536). VTID-01978: corrected
// from stale 768 (Gemini value) which silently rejected every search request.
export const EMBEDDING_DIMENSIONS = 1536;

// Provider configurations
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';

// Timeout for embedding requests
const EMBEDDING_TIMEOUT_MS = 10000;

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
// OpenAI Embedding Provider
// =============================================================================

/**
 * Generate embedding using OpenAI API
 */
async function generateOpenAIEmbedding(
  text: string,
  model: string = OPENAI_EMBEDDING_MODEL
): Promise<EmbeddingResponse> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: 'OPENAI_API_KEY not configured'
    };
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        input: text,
        model: model,
        encoding_format: 'float'
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorBody}`);
    }

    const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
    const embedding = data.data?.[0]?.embedding;

    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Invalid embedding response format');
    }

    const latencyMs = Date.now() - startTime;

    return {
      ok: true,
      embedding,
      model,
      dimensions: embedding.length,
      latency_ms: latencyMs
    };

  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.error(`[${VTID}] OpenAI embedding error:`, err.message);

    return {
      ok: false,
      latency_ms: latencyMs,
      error: err.message
    };
  }
}

/**
 * Generate batch embeddings using OpenAI API
 */
async function generateOpenAIBatchEmbeddings(
  texts: string[],
  model: string = OPENAI_EMBEDDING_MODEL
): Promise<BatchEmbeddingResponse> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: 'OPENAI_API_KEY not configured'
    };
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS * 2); // Longer timeout for batch

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        input: texts,
        model: model,
        encoding_format: 'float'
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorBody}`);
    }

    const data = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid batch embedding response format');
    }

    // Sort by index to maintain order
    const sortedData = data.data.sort((a, b) => a.index - b.index);
    const embeddings = sortedData.map((item) => item.embedding);

    const latencyMs = Date.now() - startTime;

    return {
      ok: true,
      embeddings,
      model,
      dimensions: embeddings[0]?.length ?? EMBEDDING_DIMENSIONS,
      latency_ms: latencyMs
    };

  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.error(`[${VTID}] OpenAI batch embedding error:`, err.message);

    return {
      ok: false,
      latency_ms: latencyMs,
      error: err.message
    };
  }
}

// =============================================================================
// Gemini Embedding Provider (Fallback)
// =============================================================================

/**
 * Generate embedding using Gemini API (fallback)
 */
async function generateGeminiEmbedding(text: string): Promise<EmbeddingResponse> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: 'GOOGLE_GEMINI_API_KEY not configured'
    };
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: {
            parts: [{ text }]
          },
          outputDimensionality: EMBEDDING_DIMENSIONS
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorBody}`);
    }

    const data = await response.json() as { embedding?: { values?: number[] } };
    const embedding = data.embedding?.values;

    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Invalid Gemini embedding response format');
    }

    const latencyMs = Date.now() - startTime;

    return {
      ok: true,
      embedding,
      model: 'gemini-embedding-001',
      dimensions: embedding.length,
      latency_ms: latencyMs
    };

  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.error(`[${VTID}] Gemini embedding error:`, err.message);

    return {
      ok: false,
      latency_ms: latencyMs,
      error: err.message
    };
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate embedding for a single text
 *
 * Tries OpenAI first, falls back to Gemini if OpenAI fails.
 *
 * @param text - Text to embed
 * @returns Embedding vector (1536 dimensions)
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResponse> {
  // VTID-01970 Tier 1 hot cache — return cached vector when available
  // (eliminates the OpenAI/Gemini round-trip + cost for identical inputs).
  const cached = getCachedEmbedding(text);
  if (cached) {
    return {
      ok: true,
      embedding: cached.vector,
      model: cached.model,
      dimensions: cached.dimensions,
      latency_ms: 0,  // hot-cache hit
    };
  }

  // Try OpenAI first
  const openaiResult = await generateOpenAIEmbedding(text);

  if (openaiResult.ok) {
    console.log(`[${VTID}] Embedding generated (OpenAI): ${openaiResult.dimensions}d, ${openaiResult.latency_ms}ms`);
    if (openaiResult.embedding && openaiResult.dimensions && openaiResult.model) {
      setCachedEmbedding(text, openaiResult.embedding, openaiResult.model, openaiResult.dimensions);
    }
    return openaiResult;
  }

  // Fallback to Titan (Bedrock, AWS-native) — dormant (not_configured) until
  // BEDROCK_ROLE_ARN is set, at which point this replaces Gemini as the
  // fallback with zero further config, per providers/titan-embedding.ts.
  console.log(`[${VTID}] OpenAI failed, trying Titan (Bedrock) fallback`);
  const titanResult = await generateTitanEmbedding(text);

  if (titanResult.ok) {
    console.log(`[${VTID}] Embedding generated (Titan/Bedrock): ${titanResult.dimensions}d, ${titanResult.latency_ms}ms`);
    setCachedEmbedding(text, titanResult.embedding, titanResult.model, titanResult.dimensions);

    await emitOasisEvent({
      vtid: VTID,
      type: 'embedding.fallback_used',
      source: SERVICE_NAME,
      status: 'warning',
      message: `Used Titan (Bedrock) fallback for embedding generation (${titanResult.model})`,
      payload: {
        openai_error: openaiResult.error,
        titan_latency_ms: titanResult.latency_ms,
        // Same VTID-03579 reasoning as the Gemini branch below: a Titan
        // vector and an OpenAI vector of the same length are not comparable
        // (different semantic space), so recording provider/model at write
        // time is the only way to know which rows mix providers later.
        provider: 'titan_bedrock',
        model: titanResult.model,
        dimensions: titanResult.dimensions
      }
    }).catch(() => {});

    return {
      ok: true,
      embedding: titanResult.embedding,
      model: titanResult.model,
      dimensions: titanResult.dimensions,
      latency_ms: titanResult.latency_ms
    };
  }

  // Last resort: Gemini. Per CLAUDE.md NEVER-27/IF-THEN-27/29 ("no sanctioned
  // Google dependency left at all"; "a fallback that lands on Google must be
  // treated as an incident, not as normal operation") this is NOT a normal
  // rung — it only fires when BOTH OpenAI and the AWS-native Titan path have
  // failed, and it is logged at 'error' severity with an explicit
  // policy_violation marker so it cannot be mistaken for routine fallback
  // traffic the way the unconditional pre-Titan Gemini fallback was.
  console.log(`[${VTID}] Titan (Bedrock) failed (${titanResult.error}: ${titanResult.message}), trying Gemini as last resort`);
  const geminiResult = await generateGeminiEmbedding(text);

  if (geminiResult.ok) {
    console.error(`[${VTID}] GOOGLE FALLBACK USED (policy violation, both OpenAI and Titan failed): ${geminiResult.model}`);
    if (geminiResult.embedding && geminiResult.dimensions && geminiResult.model) {
      setCachedEmbedding(text, geminiResult.embedding, geminiResult.model, geminiResult.dimensions);
    }

    // Emit OASIS event for fallback — 'error' status (not 'warning'), per
    // NEVER-27/IF-THEN-29: a Google fallback is an incident to investigate
    // (why did OpenAI AND Bedrock both fail?), not routine degradation.
    await emitOasisEvent({
      vtid: VTID,
      type: 'embedding.google_fallback_used',
      source: SERVICE_NAME,
      status: 'error',
      message: `POLICY VIOLATION: used Gemini fallback for embedding generation (${geminiResult.model}) — both OpenAI and Titan/Bedrock failed`,
      payload: {
        policy_violation: true,
        openai_error: openaiResult.error,
        titan_error: `${titanResult.error}: ${titanResult.message}`,
        gemini_latency_ms: geminiResult.latency_ms,
        // VTID-03579: naming provider/model/dimensions here is not cosmetic.
        // A Gemini vector and an OpenAI/Titan vector of the SAME length are
        // not comparable — they occupy different semantic spaces — yet all
        // insert happily into memory_items.embedding (vector(1536)) and none
        // errors. Similarity across the mixed set is quietly meaningless, so
        // the only way to know which rows are affected is to have recorded
        // it at write time. 495 such fallbacks fired between 2026-05-27 and
        // 2026-07-06 with none of this captured.
        provider: 'gemini',
        model: geminiResult.model,
        dimensions: geminiResult.dimensions
      }
    }).catch(() => {});

    return geminiResult;
  }

  // All three failed
  console.error(`[${VTID}] All embedding providers failed`);

  await emitOasisEvent({
    vtid: VTID,
    type: 'embedding.all_providers_failed',
    source: SERVICE_NAME,
    status: 'error',
    message: 'All embedding providers failed',
    payload: {
      openai_error: openaiResult.error,
      titan_error: `${titanResult.error}: ${titanResult.message}`,
      gemini_error: geminiResult.error
    }
  }).catch(() => {});

  return {
    ok: false,
    error: `All providers failed. OpenAI: ${openaiResult.error}, Titan: ${titanResult.error}, Gemini: ${geminiResult.error}`
  };
}

/**
 * Generate embeddings for multiple texts (batch)
 *
 * Uses OpenAI batch API for efficiency.
 *
 * @param texts - Array of texts to embed
 * @returns Array of embedding vectors
 */
export async function generateBatchEmbeddings(texts: string[]): Promise<BatchEmbeddingResponse> {
  if (texts.length === 0) {
    return {
      ok: true,
      embeddings: [],
      model: OPENAI_EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      latency_ms: 0
    };
  }

  // Use OpenAI batch API
  const result = await generateOpenAIBatchEmbeddings(texts);

  if (result.ok) {
    console.log(`[${VTID}] Batch embeddings generated: ${texts.length} texts, ${result.latency_ms}ms`);

    await emitOasisEvent({
      vtid: VTID,
      type: 'embedding.batch_generated',
      source: SERVICE_NAME,
      status: 'success',
      message: `Generated ${texts.length} embeddings via openai/${result.model}`,
      payload: {
        count: texts.length,
        dimensions: result.dimensions,
        latency_ms: result.latency_ms,
        // VTID-03579: provider/model were absent here, so 1384 batch events over
        // 90 days recorded WHAT was embedded and never WHO embedded it. That is
        // the same blindness that let the Gemini bill hide behind a routing
        // table: only completion telemetry says who actually served a request.
        // This path is OpenAI-only by construction (there is no batch fallback),
        // but recording it explicitly means a future fallback cannot be added
        // without the events showing it.
        provider: 'openai',
        model: result.model
      }
    }).catch(() => {});

    return result;
  }

  // Fallback to sequential Titan (Bedrock, AWS-native) first — same
  // "AWS before Google" ordering as the single-embedding path above.
  console.log(`[${VTID}] Batch failed, falling back to sequential Titan (Bedrock)`);
  const titanStartTime = Date.now();
  const titanEmbeddings: number[][] = [];
  let titanFailure: TitanEmbeddingResult | null = null;

  for (const text of texts) {
    const titanResult = await generateTitanEmbedding(text);
    if (!titanResult.ok) {
      titanFailure = titanResult;
      break;
    }
    titanEmbeddings.push(titanResult.embedding);
  }

  if (!titanFailure) {
    return {
      ok: true,
      embeddings: titanEmbeddings,
      model: getTitanEmbeddingModelId(),
      dimensions: TITAN_EMBEDDING_DIMENSIONS,
      latency_ms: Date.now() - titanStartTime
    };
  }

  // Last resort: sequential Gemini — an incident, not routine, per the same
  // NEVER-27/IF-THEN-29 reasoning as the single-embedding path above.
  console.error(`[${VTID}] Titan (Bedrock) batch failed at index ${titanEmbeddings.length} (${titanFailure.error}), trying Gemini as last resort`);
  await emitOasisEvent({
    vtid: VTID,
    type: 'embedding.google_fallback_used',
    source: SERVICE_NAME,
    status: 'error',
    message: 'POLICY VIOLATION: batch falling back to sequential Gemini — both OpenAI batch and Titan/Bedrock failed',
    payload: {
      policy_violation: true,
      count: texts.length,
      titan_error: `${titanFailure.error}: ${titanFailure.message}`
    }
  }).catch(() => {});

  const startTime = Date.now();
  const embeddings: number[][] = [];

  for (const text of texts) {
    const geminiResult = await generateGeminiEmbedding(text);
    if (!geminiResult.ok || !geminiResult.embedding) {
      return {
        ok: false,
        error: `Batch failed at index ${embeddings.length}: ${geminiResult.error}`
      };
    }
    embeddings.push(geminiResult.embedding);
  }

  return {
    ok: true,
    embeddings,
    model: 'text-embedding-004',
    dimensions: EMBEDDING_DIMENSIONS,
    latency_ms: Date.now() - startTime
  };
}

/**
 * Check if embedding service is available
 */
export function isEmbeddingServiceAvailable(): { available: boolean; providers: string[] } {
  const providers: string[] = [];

  if (process.env.OPENAI_API_KEY) {
    providers.push('openai');
  }

  if (process.env.BEDROCK_ROLE_ARN) {
    providers.push('titan_bedrock');
  }

  if (process.env.GOOGLE_GEMINI_API_KEY) {
    providers.push('gemini');
  }

  return {
    available: providers.length > 0,
    providers
  };
}
