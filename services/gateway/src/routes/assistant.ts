/**
 * VTID-0538: Assistant Routes - Knowledge Hub API
 *
 * Provides the Knowledge Hub search API endpoint for internal use
 * by Gemini tools and external integrations.
 *
 * Endpoints:
 * - POST /api/v1/assistant/knowledge/search - Search Vitana knowledge base
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { searchKnowledge } from '../services/knowledge-hub';

const router = Router();

// ==================== Schemas ====================

const KnowledgeSearchSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  role: z.string().optional().default('operator'),
  tenant: z.string().optional(),
  maxResults: z.number().int().min(1).max(20).optional().default(5)
});

// ==================== Routes ====================

/**
 * POST /knowledge/search → /api/v1/assistant/knowledge/search
 * VTID-0538: Knowledge Hub search endpoint
 *
 * Request body:
 * {
 *   "query": "What is the Vitana Index?",
 *   "role": "operator",
 *   "tenant": "vitana"
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "answer": "The Vitana Index is...",
 *   "docs": [
 *     { "id": "...", "title": "...", "snippet": "...", "source": "...", "score": 0.95 }
 *   ]
 * }
 */
router.post('/knowledge/search', async (req: Request, res: Response) => {
  console.log('[VTID-0538] Knowledge search API called');

  try {
    const validation = KnowledgeSearchSchema.safeParse(req.body);
    if (!validation.success) {
      console.warn('[VTID-0538] Validation failed:', validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const { query, role, tenant, maxResults } = validation.data;

    const result = await searchKnowledge({
      query,
      role,
      tenant,
      maxResults
    });

    return res.status(result.ok ? 200 : 500).json(result);

  } catch (error: any) {
    console.error('[VTID-0538] Knowledge search error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * GET /knowledge/health → /api/v1/assistant/knowledge/health
 * Health check for Knowledge Hub
 */
router.get('/knowledge/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_ROLE;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'knowledge-hub',
    version: '1.0.0',
    vtid: 'VTID-0538',
    timestamp: new Date().toISOString(),
    capabilities: {
      database_connection: hasSupabaseUrl && hasSupabaseKey,
      full_text_search: true,
      gemini_integration: !!process.env.GOOGLE_GEMINI_API_KEY
    }
  });
});

export default router;
