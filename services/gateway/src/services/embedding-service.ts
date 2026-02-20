/**
 * VTID-01184: Embedding Generation Service
 *
 * Provides embedding generation for semantic memory operations.
 * Supports multiple providers with fallback:
 * 1. OpenAI text-embedding-3-small (primary)
 * 2. Gemini embedding (fallback)
 *
 * This service is STATELESS - it only generates embeddings,
 * it does not store them. Storage is handled by Supabase.
 */

import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Configuration
// =============================================================================

const VTID = 'VTID-01184';
const SERVICE_NAME = 'embedding-service';

// Embedding dimensions
export const EMBEDDING_DIMENSIONS = 768;

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
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
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
      model: 'text-embedding-004',
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
  // Try OpenAI first
  const openaiResult = await generateOpenAIEmbedding(text);

  if (openaiResult.ok) {
    console.log(`[${VTID}] Embedding generated (OpenAI): ${openaiResult.dimensions}d, ${openaiResult.latency_ms}ms`);
    return openaiResult;
  }

  // Fallback to Gemini
  console.log(`[${VTID}] OpenAI failed, trying Gemini fallback`);
  const geminiResult = await generateGeminiEmbedding(text);

  if (geminiResult.ok) {
    console.log(`[${VTID}] Embedding generated (Gemini): ${geminiResult.dimensions}d, ${geminiResult.latency_ms}ms`);

    // Emit OASIS event for fallback
    await emitOasisEvent({
      vtid: VTID,
      type: 'embedding.fallback_used',
      source: SERVICE_NAME,
      status: 'warning',
      message: 'Used Gemini fallback for embedding generation',
      payload: {
        openai_error: openaiResult.error,
        gemini_latency_ms: geminiResult.latency_ms
      }
    }).catch(() => {});

    return geminiResult;
  }

  // Both failed
  console.error(`[${VTID}] All embedding providers failed`);

  await emitOasisEvent({
    vtid: VTID,
    type: 'embedding.all_providers_failed',
    source: SERVICE_NAME,
    status: 'error',
    message: 'All embedding providers failed',
    payload: {
      openai_error: openaiResult.error,
      gemini_error: geminiResult.error
    }
  }).catch(() => {});

  return {
    ok: false,
    error: `All providers failed. OpenAI: ${openaiResult.error}, Gemini: ${geminiResult.error}`
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
      message: `Generated ${texts.length} embeddings`,
      payload: {
        count: texts.length,
        dimensions: result.dimensions,
        latency_ms: result.latency_ms
      }
    }).catch(() => {});

    return result;
  }

  // Fallback to sequential Gemini (slower but reliable)
  console.log(`[${VTID}] Batch failed, falling back to sequential Gemini`);
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

  if (process.env.GOOGLE_GEMINI_API_KEY) {
    providers.push('gemini');
  }

  return {
    available: providers.length > 0,
    providers
  };
}
