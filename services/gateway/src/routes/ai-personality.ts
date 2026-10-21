/**
 * AI Personality Configuration Routes
 *
 * CRUD API for managing AI assistant personality across all surfaces.
 *
 * Endpoints:
 * - GET  /api/v1/ai-personality                     — List all surfaces
 * - GET  /api/v1/ai-personality/:surface_key        — Get single surface
 * - PUT  /api/v1/ai-personality/:surface_key        — Update surface config
 * - POST /api/v1/ai-personality/:surface_key/reset  — Reset to defaults
 */

import { Router, Request, Response } from 'express';
import {
  getAllPersonalityConfigs,
  getPersonalityConfig,
  updatePersonalityConfig,
  resetPersonalityConfig,
  VALID_SURFACE_KEYS,
  PersonalitySurfaceKey,
} from '../services/ai-personality-service';

const router = Router();

/**
 * GET / — List all personality surfaces with current config and defaults
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const surfaces = await getAllPersonalityConfigs();
    return res.json({
      ok: true,
      surfaces,
      count: surfaces.length,
    });
  } catch (error: any) {
    console.error('[AI-PERSONALITY] Error listing configs:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /:surface_key — Get single surface config
 */
router.get('/:surface_key', async (req: Request, res: Response) => {
  const surfaceKey = req.params.surface_key as PersonalitySurfaceKey;

  if (!VALID_SURFACE_KEYS.includes(surfaceKey)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid surface_key: ${surfaceKey}. Valid keys: ${VALID_SURFACE_KEYS.join(', ')}`,
    });
  }

  try {
    const surface = await getPersonalityConfig(surfaceKey);
    return res.json({ ok: true, surface });
  } catch (error: any) {
    console.error(`[AI-PERSONALITY] Error fetching ${surfaceKey}:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * PUT /:surface_key — Update surface config
 *
 * Body: { config: Record<string, unknown>, reason: string }
 */
router.put('/:surface_key', async (req: Request, res: Response) => {
  const surfaceKey = req.params.surface_key as PersonalitySurfaceKey;

  if (!VALID_SURFACE_KEYS.includes(surfaceKey)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid surface_key: ${surfaceKey}`,
    });
  }

  const { config, reason } = req.body;

  if (!config || typeof config !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing or invalid "config" object in body' });
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing "reason" string in body' });
  }

  // Extract identity from request (if auth middleware is present)
  const updatedBy = (req as any).identity?.user_id || 'command-hub-user';
  const updatedByRole = (req as any).identity?.role || 'developer';

  try {
    const result = await updatePersonalityConfig(
      surfaceKey,
      config,
      reason.trim(),
      updatedBy,
      updatedByRole
    );

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    // Return updated config
    const updated = await getPersonalityConfig(surfaceKey);
    return res.json({ ok: true, surface: updated });
  } catch (error: any) {
    console.error(`[AI-PERSONALITY] Error updating ${surfaceKey}:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /:surface_key/reset — Reset to defaults
 *
 * Body: { reason: string }
 */
router.post('/:surface_key/reset', async (req: Request, res: Response) => {
  const surfaceKey = req.params.surface_key as PersonalitySurfaceKey;

  if (!VALID_SURFACE_KEYS.includes(surfaceKey)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid surface_key: ${surfaceKey}`,
    });
  }

  const { reason } = req.body;
  const resetReason = (reason && typeof reason === 'string') ? reason.trim() : 'Manual reset from Command Hub';

  const updatedBy = (req as any).identity?.user_id || 'command-hub-user';
  const updatedByRole = (req as any).identity?.role || 'developer';

  try {
    const result = await resetPersonalityConfig(surfaceKey, resetReason, updatedBy, updatedByRole);

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    const updated = await getPersonalityConfig(surfaceKey);
    return res.json({ ok: true, surface: updated });
  } catch (error: any) {
    console.error(`[AI-PERSONALITY] Error resetting ${surfaceKey}:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
