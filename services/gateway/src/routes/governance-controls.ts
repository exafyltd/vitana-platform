/**
 * VTID-01181: Governance Controls API Routes
 *
 * Provides endpoints for reading and updating system controls:
 * - GET /api/v1/governance/controls - List all controls
 * - POST /api/v1/governance/controls/:key - Update a control (arm/disarm)
 * - GET /api/v1/governance/controls/:key/history - Get audit history
 *
 * HARD GOVERNANCE:
 * - JWT authentication required on all endpoints
 * - Write operations require exafy_admin privilege
 * - Reason is mandatory for all changes
 * - Duration is mandatory for arming (except "until manually off" for admins)
 * - All changes are audited and emit OASIS events
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import {
  getAllSystemControls,
  getSystemControl,
  updateSystemControl,
  getControlAuditHistory,
} from '../services/system-controls-service';
import { requireAuth, requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();

// =============================================================================
// Request Schemas
// =============================================================================

const UpdateControlSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1, 'Reason is required'),
  duration_minutes: z.number().int().min(0).optional().nullable(),
});

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /api/v1/governance/controls
 * List all system controls with their current state
 */
router.get('/', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const controls = await getAllSystemControls();

    return res.status(200).json({
      ok: true,
      data: controls,
    });
  } catch (error) {
    console.error('[VTID-01181] Error listing controls:', error);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/governance/controls/:key
 * Get a specific control's current state
 */
router.get('/:key', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { key } = req.params;
    const control = await getSystemControl(key);

    if (!control) {
      return res.status(404).json({
        ok: false,
        error: 'not_found',
        message: `Control '${key}' not found`,
      });
    }

    return res.status(200).json({
      ok: true,
      data: control,
    });
  } catch (error) {
    console.error(`[VTID-01181] Error fetching control:`, error);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/governance/controls/:key
 * Update a control (arm or disarm)
 *
 * Requires exafy_admin JWT privilege.
 *
 * Body:
 * {
 *   "enabled": true,
 *   "reason": "Testing VTID-01181 end-to-end",
 *   "duration_minutes": 60
 * }
 *
 * Rules:
 * - enabled=true (arming) requires duration_minutes unless user is exafy_admin
 * - enabled=false (disarming) does not require duration
 * - reason is always required
 */
router.post('/:key', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { key } = req.params;
    const userId = req.identity!.user_id;
    const isAdmin = req.identity!.exafy_admin;

    // Validate request body
    const parseResult = UpdateControlSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        ok: false,
        error: 'validation_failed',
        details: parseResult.error.errors,
      });
    }

    const { enabled, reason, duration_minutes } = parseResult.data;

    if (enabled && !duration_minutes && !isAdmin) {
      return res.status(400).json({
        ok: false,
        error: 'validation_failed',
        message: 'Duration is required when enabling a control',
      });
    }

    // Update the control
    const result = await updateSystemControl(key, {
      enabled,
      reason,
      duration_minutes: duration_minutes || null,
      updated_by: userId,
      updated_by_role: isAdmin ? 'exafy_admin' : 'authenticated',
    });

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: 'update_failed',
        message: result.error,
      });
    }

    console.log(
      `[VTID-01181] Control '${key}' ${enabled ? 'ENABLED' : 'DISABLED'} by ${userId} (exafy_admin): ${reason}`
    );

    return res.status(200).json({
      ok: true,
      data: result.control,
      audit_id: result.audit_id,
    });
  } catch (error) {
    console.error(`[VTID-01181] Error updating control:`, error);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/governance/controls/:key/history
 * Get audit history for a control
 *
 * Query params:
 * - limit: number (default: 50, max: 200)
 */
router.get('/:key/history', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { key } = req.params;
    let limit = parseInt(req.query.limit as string, 10) || 50;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    const history = await getControlAuditHistory(key, limit);

    return res.status(200).json({
      ok: true,
      data: history,
      pagination: {
        limit,
        count: history.length,
      },
    });
  } catch (error) {
    console.error(`[VTID-01181] Error fetching audit history:`, error);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
