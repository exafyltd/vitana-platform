/**
 * VTID-0150-B: Assistant Core Routes
 *
 * API endpoints for the global Vitana Assistant.
 * Separate from Operator Chat (/api/v1/operator/chat).
 *
 * Endpoint:
 * - POST /api/v1/assistant/chat - Global assistant brain entrypoint
 */

import { Router, Request, Response } from 'express';
import { AssistantChatRequestSchema } from '../types/assistant';
import { processAssistantMessage } from '../services/assistant-service';

const router = Router();

/**
 * POST /chat → /api/v1/assistant/chat
 *
 * Global assistant brain entrypoint for the ORB.
 * VTID-0150-B: Dev-only, text-only, read-only Q&A.
 *
 * Request body:
 * {
 *   "message": "string",
 *   "sessionId": "optional string",
 *   "role": "string",      // e.g. "DEV"
 *   "tenant": "string",    // e.g. "Vitana-Dev"
 *   "route": "string",     // current frontend route/module
 *   "selectedId": "string" // optional: currently focused entity
 * }
 *
 * Response body:
 * {
 *   "ok": true,
 *   "reply": "string",
 *   "sessionId": "string",
 *   "oasis_ref": "string",
 *   "meta": {
 *     "model": "string",
 *     "tokens_in": 0,
 *     "tokens_out": 0,
 *     "latency_ms": 0
 *   }
 * }
 */
router.post('/chat', async (req: Request, res: Response) => {
  console.log(`[VTID-0150-B] Assistant chat request received`);

  try {
    // Validate request body
    const validation = AssistantChatRequestSchema.safeParse(req.body);

    if (!validation.success) {
      console.warn(`[VTID-0150-B] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const { message, sessionId, role, tenant, route, selectedId } = validation.data;

    // Process message through Assistant Core
    const result = await processAssistantMessage(
      message,
      sessionId,
      role,
      tenant,
      route || '',
      selectedId || ''
    );

    // Return response
    return res.status(result.ok ? 200 : 500).json(result);

  } catch (error: any) {
    console.error(`[VTID-0150-B] Unexpected error:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * GET /health → /api/v1/assistant/health
 *
 * Health check for Assistant Core.
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'assistant-core',
    vtid: 'VTID-0150-B',
    timestamp: new Date().toISOString(),
    config: {
      gemini_configured: !!process.env.GOOGLE_GEMINI_API_KEY
    }
  });
});

export default router;
