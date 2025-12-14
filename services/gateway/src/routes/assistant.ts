/**
 * Assistant Routes - VTID-0150-B + VTID-0151
 *
 * API endpoints for the global Vitana Assistant.
 * Separate from Operator Chat (/api/v1/operator/chat).
 *
 * Endpoints:
 * - POST /api/v1/assistant/chat - Global assistant brain entrypoint (VTID-0150-B)
 * - POST /api/v1/assistant/live/init - Initialize live session (VTID-0151)
 * - POST /api/v1/assistant/live/frame - Process camera/screen frames (VTID-0151)
 * - POST /api/v1/assistant/live/audio - Process audio chunks (VTID-0151)
 *
 * IMPORTANT:
 * - These endpoints are READ-ONLY. No destructive operations.
 * - Does NOT modify Operator Chat.
 * - All operations logged to OASIS.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AssistantChatRequestSchema } from '../types/assistant';
import { processAssistantMessage } from '../services/assistant-service';
import {
  initLiveSession,
  processFrame,
  processAudio,
  getSessionInfo,
  LiveSessionInitRequest,
  FrameProcessRequest,
  AudioProcessRequest
} from '../services/assistant-core';

const router = Router();

// ==================== VTID-0151 Schemas ====================

const LiveSessionInitSchema = z.object({
  sessionId: z.string().uuid().optional(),
  role: z.string().min(1, 'Role is required'),
  tenant: z.string().min(1, 'Tenant is required'),
  route: z.string().min(1, 'Route is required'),
  selectedId: z.string().default('')
});

const FrameProcessSchema = z.object({
  sessionId: z.string().uuid('Invalid session ID format'),
  frame: z.string().min(1, 'Frame data is required'),
  source: z.enum(['camera', 'screen'], {
    errorMap: () => ({ message: 'Source must be "camera" or "screen"' })
  }),
  route: z.string().min(1, 'Route is required'),
  selectedId: z.string().default('')
});

const AudioProcessSchema = z.object({
  sessionId: z.string().uuid('Invalid session ID format'),
  audio: z.string().min(1, 'Audio data is required'),
  route: z.string().min(1, 'Route is required'),
  selectedId: z.string().default('')
});

// ==================== VTID-0150-B Routes ====================

/**
 * POST /chat -> /api/v1/assistant/chat
 *
 * Global assistant brain entrypoint for the ORB.
 * VTID-0150-B: Dev-only, text-only, read-only Q&A.
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

// ==================== VTID-0151 Routes ====================

/**
 * POST /live/init -> /api/v1/assistant/live/init
 *
 * Creates a Live Session configuration for the frontend.
 * Returns session ID, model metadata, and API key reference.
 */
router.post('/live/init', async (req: Request, res: Response) => {
  console.log('[VTID-0151] POST /assistant/live/init');

  try {
    const validation = LiveSessionInitSchema.safeParse(req.body);
    if (!validation.success) {
      console.warn('[VTID-0151] Validation failed:', validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const request: LiveSessionInitRequest = {
      sessionId: validation.data.sessionId,
      role: validation.data.role,
      tenant: validation.data.tenant,
      route: validation.data.route,
      selectedId: validation.data.selectedId
    };

    const result = await initLiveSession(request);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Failed to initialize live session'
      });
    }

    console.log(`[VTID-0151] Live session initialized: ${result.sessionId}`);

    return res.status(200).json({
      ok: true,
      sessionId: result.sessionId,
      config: result.config
    });

  } catch (error: any) {
    console.error('[VTID-0151] Live init error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * POST /live/frame -> /api/v1/assistant/live/frame
 *
 * Accepts camera or screen frames for processing.
 * Logs metadata and optionally analyzes with Gemini Vision.
 */
router.post('/live/frame', async (req: Request, res: Response) => {
  console.log('[VTID-0151] POST /assistant/live/frame');

  try {
    const validation = FrameProcessSchema.safeParse(req.body);
    if (!validation.success) {
      console.warn('[VTID-0151] Validation failed:', validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const request: FrameProcessRequest = {
      sessionId: validation.data.sessionId,
      frame: validation.data.frame,
      source: validation.data.source,
      route: validation.data.route,
      selectedId: validation.data.selectedId
    };

    const result = await processFrame(request);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        sessionId: result.sessionId,
        frameId: result.frameId,
        error: result.error
      });
    }

    console.log(`[VTID-0151] Frame processed: ${result.frameId}`);

    return res.status(200).json({
      ok: true,
      sessionId: result.sessionId,
      frameId: result.frameId,
      source: result.source,
      analysis: result.analysis,
      meta: result.meta
    });

  } catch (error: any) {
    console.error('[VTID-0151] Frame processing error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * POST /live/audio -> /api/v1/assistant/live/audio
 *
 * Accepts audio chunks (PCM16 or WAV) for processing.
 * Logs metadata and optionally transcribes with Gemini.
 */
router.post('/live/audio', async (req: Request, res: Response) => {
  console.log('[VTID-0151] POST /assistant/live/audio');

  try {
    const validation = AudioProcessSchema.safeParse(req.body);
    if (!validation.success) {
      console.warn('[VTID-0151] Validation failed:', validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const request: AudioProcessRequest = {
      sessionId: validation.data.sessionId,
      audio: validation.data.audio,
      route: validation.data.route,
      selectedId: validation.data.selectedId
    };

    const result = await processAudio(request);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        sessionId: result.sessionId,
        error: result.error
      });
    }

    console.log(`[VTID-0151] Audio chunk processed for session: ${result.sessionId}`);

    return res.status(200).json({
      ok: true,
      sessionId: result.sessionId,
      transcript: result.transcript,
      meta: result.meta
    });

  } catch (error: any) {
    console.error('[VTID-0151] Audio processing error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * GET /live/session/:sessionId -> /api/v1/assistant/live/session/:sessionId
 *
 * Get session info (for debug/health checks)
 */
router.get('/live/session/:sessionId', async (req: Request, res: Response) => {
  console.log('[VTID-0151] GET /assistant/live/session/:sessionId');

  try {
    const { sessionId } = req.params;

    // Validate UUID format
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(sessionId)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid session ID format'
      });
    }

    const info = getSessionInfo(sessionId);

    if (!info.exists) {
      return res.status(404).json({
        ok: false,
        error: 'Session not found'
      });
    }

    return res.status(200).json({
      ok: true,
      sessionId,
      config: info.config,
      stats: info.stats
    });

  } catch (error: any) {
    console.error('[VTID-0151] Session info error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// ==================== Health Check ====================

/**
 * GET /health -> /api/v1/assistant/health
 *
 * Health check for Assistant Core.
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'assistant-core',
    vtids: ['VTID-0150-B', 'VTID-0151'],
    capabilities: ['chat', 'live-session', 'frame-processing', 'audio-processing'],
    gemini_configured: !!process.env.GOOGLE_GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

export default router;
