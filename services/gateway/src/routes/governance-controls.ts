/**
 * VTID-01181: Governance Controls API Routes
 *
 * Provides endpoints for reading and updating system controls:
 * - GET /api/v1/governance/controls - List all controls
 * - POST /api/v1/governance/controls/:key - Update a control (arm/disarm)
 * - GET /api/v1/governance/controls/:key/history - Get audit history
 *
 * HARD GOVERNANCE:
 * - Role gate: only Dev Admin or Governance Admin can modify controls
 * - Reason is mandatory for all changes
 * - Duration is mandatory for arming (except "until manually off" for specific roles)
 * - All changes are audited and emit OASIS events
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getAllSystemControls,
  getSystemControl,
  updateSystemControl,
  getControlAuditHistory,
} from '../services/system-controls-service';

const router = Router();

// =============================================================================
// Role Validation
// =============================================================================

const ALLOWED_ROLES = ['dev_admin', 'governance_admin', 'admin'];

/**
 * Extract and validate user role from request headers.
 * In production, this would come from authenticated session.
 */
function getUserInfo(req: Request): { userId: string; role: string } {
  // For now, accept role from headers (would be from auth middleware in production)
  const userId = req.headers['x-user-id']?.toString() || req.headers['x-operator-id']?.toString() || 'unknown';
  const role = req.headers['x-user-role']?.toString() || 'operator';
  return { userId, role };
}

/**
 * Check if user has permission to modify controls
 */
function canModifyControls(role: string): boolean {
  return ALLOWED_ROLES.includes(role.toLowerCase());
}

// =============================================================================
// Request Schemas
// =============================================================================

const UpdateControlSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1, 'Reason is required'),
  duration_minutes: z.number().int().positive().optional().nullable(),
});

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /api/v1/governance/controls
 * List all system controls with their current state
 */
router.get('/', async (_req: Request, res: Response) => {
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
router.get('/:key', async (req: Request, res: Response) => {
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
 * Body:
 * {
 *   "enabled": true,
 *   "reason": "Testing VTID-01181 end-to-end",
 *   "duration_minutes": 60
 * }
 *
 * Rules:
 * - enabled=true (arming) requires duration_minutes unless role is dev_admin
 * - enabled=false (disarming) does not require duration
 * - reason is always required
 */
router.post('/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { userId, role } = getUserInfo(req);

    // Role check
    if (!canModifyControls(role)) {
      console.warn(`[VTID-01181] Unauthorized control update attempt by ${userId} (role: ${role})`);
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'Only Dev Admin or Governance Admin can modify system controls',
      });
    }

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

    // Additional validation: arming requires duration (unless dev_admin)
    if (enabled && !duration_minutes && role !== 'dev_admin') {
      return res.status(400).json({
        ok: false,
        error: 'validation_failed',
        message: 'Duration is required when arming a control (only dev_admin can use indefinite)',
      });
    }

    // Update the control
    const result = await updateSystemControl(key, {
      enabled,
      reason,
      duration_minutes: duration_minutes || null,
      updated_by: userId,
      updated_by_role: role,
    });

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: 'update_failed',
        message: result.error,
      });
    }

    console.log(
      `[VTID-01181] Control '${key}' ${enabled ? 'ARMED' : 'DISARMED'} by ${userId} (${role}): ${reason}`
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
router.get('/:key/history', async (req: Request, res: Response) => {
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
