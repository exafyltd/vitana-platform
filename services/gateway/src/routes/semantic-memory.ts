/**
 * VTID-01184: Supabase Semantic Memory Routes
 *
 * API endpoints for semantic (vector) memory operations using pgvector.
 *
 * Endpoints:
 * - POST /api/v1/memory/semantic/search    - Semantic similarity search
 * - POST /api/v1/memory/semantic/write     - Write with embedding
 * - POST /api/v1/memory/semantic/context   - Build semantic context for prompts
 * - GET  /api/v1/memory/semantic/health    - Service health check
 *
 * Admin Endpoints (service-role only):
 * - POST /api/v1/memory/admin/embeddings/generate - Generate missing embeddings
 * - POST /api/v1/memory/admin/embeddings/reembed  - Trigger re-embedding
 * - GET  /api/v1/memory/admin/embeddings/status   - Embedding pipeline status
 *
 * Dependencies:
 * - VTID-01184 migration (pgvector, embedding columns)
 * - Embedding service (OpenAI/Gemini)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  semanticSearch,
  writeMemoryItem,
  buildSemanticContext,
  getItemsNeedingEmbeddings,
  updateEmbeddings,
  markForReembed,
  VTID,
  EMBEDDING_DIMENSIONS,
} from '../services/supabase-semantic-memory';
import {
  generateEmbedding,
  generateBatchEmbeddings,
  isEmbeddingServiceAvailable,
} from '../services/embedding-service';
import {
  ContextLens,
  validateContextLens,
  createDevSandboxLens,
} from '../types/context-lens';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// Request Validation Schemas
// =============================================================================

const ContextLensSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  workspace_scope: z.enum(['product', 'dev']),
  active_role: z.string().optional(),
  allowed_categories: z.array(z.string()).optional(),
  visibility_scope: z.enum(['private', 'shared', 'public']).optional(),
  max_age_hours: z.number().int().positive().optional(),
});

const SemanticSearchRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  query_embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS).optional(),
  top_k: z.number().int().min(1).max(100).default(10),
  lens: ContextLensSchema,
  recency_boost: z.boolean().default(true),
});

const SemanticWriteRequestSchema = z.object({
  content: z.string().min(1, 'Content is required'),
  content_json: z.record(z.unknown()).optional(),
  source: z.enum(['orb_text', 'orb_voice', 'diary', 'upload', 'system']),
  category_key: z.string().optional(),
  importance: z.number().int().min(0).max(100).default(10),
  occurred_at: z.string().datetime().optional(),
  lens: ContextLensSchema,
  vtid: z.string().optional(),
  origin_service: z.string().optional(),
  conversation_id: z.string().uuid().optional(),
  embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS).optional(),
  embedding_model: z.string().optional(),
});

const SemanticContextRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  top_k: z.number().int().min(1).max(50).default(10),
  lens: ContextLensSchema,
});

const ReembedRequestSchema = z.object({
  tenant_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  category_key: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

const GenerateEmbeddingsRequestSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
  tenant_id: z.string().uuid().optional(),
  category_key: z.string().optional(),
  since: z.string().datetime().optional(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if request is from dev sandbox
 */
function isDevSandbox(req: Request): boolean {
  const env = (process.env.ENVIRONMENT || '').toLowerCase();
  return env.includes('dev') || env.includes('sandbox');
}

/**
 * Get Context Lens from request, using dev sandbox defaults if appropriate
 */
function getLensFromRequest(req: Request, body: { lens?: unknown }): ContextLens | null {
  // If lens provided in body, validate it
  if (body.lens) {
    const parsed = ContextLensSchema.safeParse(body.lens);
    if (parsed.success) {
      return parsed.data as ContextLens;
    }
    return null;
  }

  // In dev sandbox, use default dev lens
  if (isDevSandbox(req)) {
    return createDevSandboxLens();
  }

  return null;
}

// =============================================================================
// Semantic Search Endpoint
// =============================================================================

/**
 * POST /api/v1/memory/semantic/search
 *
 * Perform semantic similarity search on memory items.
 * Requires query embedding (or computes one from query text).
 *
 * Request:
 * {
 *   query: string,
 *   query_embedding?: number[],  // 1536 dimensions
 *   top_k?: number,
 *   lens: ContextLens,
 *   recency_boost?: boolean
 * }
 *
 * Response:
 * {
 *   ok: boolean,
 *   results: SemanticSearchResult[],
 *   query: string,
 *   total_found: number,
 *   search_time_ms: number
 * }
 */
router.post('/semantic/search', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Parse and validate request
    const parsed = SemanticSearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten()
      });
    }

    const request = parsed.data;
    let queryEmbedding = request.query_embedding;

    // Generate embedding if not provided
    if (!queryEmbedding) {
      const embeddingResult = await generateEmbedding(request.query);
      if (!embeddingResult.ok || !embeddingResult.embedding) {
        return res.status(500).json({
          ok: false,
          error: 'EMBEDDING_GENERATION_FAILED',
          message: embeddingResult.error || 'Failed to generate query embedding'
        });
      }
      queryEmbedding = embeddingResult.embedding;
    }

    // Perform semantic search
    const result = await semanticSearch({
      query: request.query,
      query_embedding: queryEmbedding,
      top_k: request.top_k,
      lens: request.lens as ContextLens,
      recency_boost: request.recency_boost
    });

    const totalTime = Date.now() - startTime;

    if (!result.ok) {
      return res.status(500).json({
        ...result,
        total_time_ms: totalTime
      });
    }

    return res.json({
      ...result,
      total_time_ms: totalTime
    });

  } catch (err: any) {
    console.error(`[${VTID}] Semantic search error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

// =============================================================================
// Semantic Write Endpoint
// =============================================================================

/**
 * POST /api/v1/memory/semantic/write
 *
 * Write a memory item with optional embedding.
 * If embedding not provided, item is written without embedding
 * (embedding pipeline will generate it later).
 *
 * Request:
 * {
 *   content: string,
 *   source: string,
 *   lens: ContextLens,
 *   // ... other fields
 * }
 */
router.post('/semantic/write', async (req: Request, res: Response) => {
  try {
    // Parse and validate request
    const parsed = SemanticWriteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten()
      });
    }

    const request = parsed.data;

    // Generate embedding if requested and not provided
    let embedding = request.embedding;
    let embeddingModel = request.embedding_model;

    if (!embedding && request.content.length > 10) {
      // Try to generate embedding (fire-and-forget style - don't fail write if embedding fails)
      const embeddingResult = await generateEmbedding(request.content);
      if (embeddingResult.ok && embeddingResult.embedding) {
        embedding = embeddingResult.embedding;
        embeddingModel = embeddingResult.model;
      }
    }

    // Write memory item
    const result = await writeMemoryItem({
      content: request.content,
      content_json: request.content_json,
      source: request.source,
      category_key: request.category_key,
      importance: request.importance,
      occurred_at: request.occurred_at,
      lens: request.lens as ContextLens,
      vtid: request.vtid,
      origin_service: request.origin_service,
      conversation_id: request.conversation_id,
      embedding,
      embedding_model: embeddingModel,
    });

    if (!result.ok) {
      return res.status(500).json(result);
    }

    return res.status(201).json(result);

  } catch (err: any) {
    console.error(`[${VTID}] Semantic write error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

// =============================================================================
// Semantic Context Endpoint
// =============================================================================

/**
 * POST /api/v1/memory/semantic/context
 *
 * Build formatted memory context for prompt injection using semantic search.
 *
 * Request:
 * {
 *   query: string,
 *   top_k?: number,
 *   lens: ContextLens
 * }
 *
 * Response:
 * {
 *   ok: boolean,
 *   context: string,  // Formatted for prompt injection
 *   results: SemanticSearchResult[],
 *   results_count: number
 * }
 */
router.post('/semantic/context', async (req: Request, res: Response) => {
  try {
    // Parse and validate request
    const parsed = SemanticContextRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten()
      });
    }

    const request = parsed.data;

    // Generate query embedding
    const embeddingResult = await generateEmbedding(request.query);
    if (!embeddingResult.ok || !embeddingResult.embedding) {
      return res.status(500).json({
        ok: false,
        error: 'EMBEDDING_GENERATION_FAILED',
        message: embeddingResult.error || 'Failed to generate query embedding'
      });
    }

    // Build semantic context
    const result = await buildSemanticContext(
      request.query,
      embeddingResult.embedding,
      request.lens as ContextLens,
      request.top_k
    );

    if (!result.ok) {
      return res.status(500).json(result);
    }

    return res.json({
      ok: true,
      context: result.context,
      results: result.results,
      results_count: result.results.length
    });

  } catch (err: any) {
    console.error(`[${VTID}] Semantic context error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

// =============================================================================
// Health Check Endpoint
// =============================================================================

/**
 * GET /api/v1/memory/semantic/health
 *
 * Health check for semantic memory service.
 */
router.get('/semantic/health', async (req: Request, res: Response) => {
  const embeddingStatus = isEmbeddingServiceAvailable();

  return res.json({
    ok: true,
    vtid: VTID,
    service: 'supabase-semantic-memory',
    embedding_dimensions: EMBEDDING_DIMENSIONS,
    embedding_service: embeddingStatus,
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// Admin Endpoints
// =============================================================================

/**
 * POST /api/v1/memory/admin/embeddings/generate
 *
 * Generate embeddings for items that don't have them.
 * Service-role only operation.
 *
 * Request:
 * {
 *   limit?: number,
 *   tenant_id?: string,
 *   category_key?: string,
 *   since?: string
 * }
 */
router.post('/admin/embeddings/generate', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Parse request
    const parsed = GenerateEmbeddingsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten()
      });
    }

    const request = parsed.data;

    // Get items needing embeddings
    const itemsResult = await getItemsNeedingEmbeddings(
      request.limit,
      {
        tenant_id: request.tenant_id,
        category_key: request.category_key,
        since: request.since
      }
    );

    if (!itemsResult.ok) {
      return res.status(500).json(itemsResult);
    }

    if (itemsResult.items.length === 0) {
      return res.json({
        ok: true,
        message: 'No items need embeddings',
        processed: 0,
        total_time_ms: Date.now() - startTime
      });
    }

    // Generate embeddings in batches
    const batchSize = 20;
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < itemsResult.items.length; i += batchSize) {
      const batch = itemsResult.items.slice(i, i + batchSize);
      const texts = batch.map(item => item.content);

      const embeddingResult = await generateBatchEmbeddings(texts);

      if (!embeddingResult.ok || !embeddingResult.embeddings) {
        console.error(`[${VTID}] Batch embedding failed:`, embeddingResult.error);
        errors += batch.length;
        continue;
      }

      // Build updates
      const updates = batch.map((item, idx) => ({
        id: item.id,
        embedding: embeddingResult.embeddings![idx],
        embedding_model: embeddingResult.model || 'text-embedding-3-small'
      }));

      // Update embeddings
      const updateResult = await updateEmbeddings(updates);

      if (updateResult.ok) {
        processed += updateResult.updated_count;
      } else {
        errors += batch.length;
      }
    }

    const totalTime = Date.now() - startTime;

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'embedding.pipeline.batch_completed',
      source: 'semantic-memory-routes',
      status: errors === 0 ? 'success' : 'warning',
      message: `Generated embeddings for ${processed} items`,
      payload: {
        processed,
        errors,
        total_items: itemsResult.items.length,
        total_time_ms: totalTime
      }
    }).catch(() => {});

    return res.json({
      ok: true,
      processed,
      errors,
      total_items: itemsResult.items.length,
      total_time_ms: totalTime
    });

  } catch (err: any) {
    console.error(`[${VTID}] Generate embeddings error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * POST /api/v1/memory/admin/embeddings/reembed
 *
 * Mark items for re-embedding (clears existing embeddings).
 * Service-role only operation.
 */
router.post('/admin/embeddings/reembed', async (req: Request, res: Response) => {
  try {
    // Parse request
    const parsed = ReembedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten()
      });
    }

    const request = parsed.data;

    // Mark items for re-embedding
    const result = await markForReembed({
      tenant_id: request.tenant_id,
      user_id: request.user_id,
      category_key: request.category_key,
      since: request.since,
      until: request.until
    });

    if (!result.ok) {
      return res.status(500).json(result);
    }

    return res.json(result);

  } catch (err: any) {
    console.error(`[${VTID}] Re-embed error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * GET /api/v1/memory/admin/embeddings/status
 *
 * Get embedding pipeline status.
 */
router.get('/admin/embeddings/status', async (req: Request, res: Response) => {
  try {
    // Get items needing embeddings (small sample)
    const itemsResult = await getItemsNeedingEmbeddings(1);

    const embeddingStatus = isEmbeddingServiceAvailable();

    return res.json({
      ok: true,
      vtid: VTID,
      embedding_service: embeddingStatus,
      items_needing_embeddings: itemsResult.ok ? itemsResult.items.length > 0 : 'unknown',
      migration_available: itemsResult.ok,
      timestamp: new Date().toISOString()
    });

  } catch (err: any) {
    console.error(`[${VTID}] Status check error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

// =============================================================================
// Export Router
// =============================================================================

export default router;
