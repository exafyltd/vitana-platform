/**
 * VTID-01181: Governance Controls API Routes
 *
 * Provides endpoints for reading and updating system controls:
 * - GET /api/v1/governance/controls - List all controls
 * - POST /api/v1/governance/controls/:key - Update a control (arm/disarm)
 * - GET /api/v1/governance/controls/:key/history - Get audit history
 *
 * HARD GOVERNANCE:
 * - Role gate (VTID-04279): every route requires a real, verified
 *   exafy_admin session (requireAdminAuth) — not a client-suppliable header
 * - Reason is mandatory for all changes
 * - All changes are audited (verified caller identity) and emit OASIS events
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  getAllSystemControls,
  getSystemControl,
  updateSystemControl,
  getControlAuditHistory,
} from '../services/system-controls-service';

const router = Router();

// SECURITY (VTID-04279): this router arms/disarms system kill-switches
// (EXECUTION_DISARMED, AUTOPILOT_LOOP_ENABLED, ...). It previously trusted
// caller-supplied x-user-id/x-user-role headers with no signature
// verification at all — `x-user-role: admin` on any request was sufficient
// to modify a control, matching the exact pre-hardening shape
// feedback-admin.ts's own SECURITY note describes for a different route.
// requireAdminAuth verifies the JWT signature and requires
// app_metadata.exafy_admin, the same pattern admin-navigator.ts /
// feedback-admin.ts / specialists-admin.ts already use.
router.use(requireAdminAuth);

// =============================================================================
// Verified identity (VTID-04279: no longer a client-suppliable header)
// =============================================================================

/**
 * Verified user id + role for the audit trail. requireAdminAuth has already
 * run by the time any handler below executes, so req.identity is always
 * present and its exafy_admin claim already checked — read from there, never
 * from a header a caller could set to anything.
 */
function getUserInfo(req: Request): { userId: string; role: string } {
  const identity = (req as AuthenticatedRequest).identity;
  return { userId: identity?.user_id ?? 'unknown', role: 'exafy_admin' };
}

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
 * - duration_minutes is optional on any change (an exafy_admin caller may
 *   arm a control indefinitely)
 * - reason is always required
 */
router.post('/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    // VTID-04279: role gating is now requireAdminAuth (router.use above) —
    // every request reaching this handler already verified exafy_admin, so
    // there is no longer a separate role check here, and no reason to
    // require a fixed duration for arming a control (the old allowlist's
    // "trusted operator" tiers are a strict subset of exafy_admin).
    const { userId, role } = getUserInfo(req);

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
      `[VTID-01181] Control '${key}' ${enabled ? 'ENABLED' : 'DISABLED'} by ${userId} (${role}): ${reason}`
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
