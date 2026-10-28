/**
 * VTID-01181: Governance Controls API Routes
 *
 * Provides endpoints for reading and updating system controls:
 * - GET /api/v1/governance/controls - List all controls
 * - POST /api/v1/governance/controls/:key - Update a control (arm/disarm)
 * - GET /api/v1/governance/controls/:key/history - Get audit history
 *
 * HARD GOVERNANCE:
 * - Auth gate (VTID-05048): POST needs GATEWAY_SERVICE_TOKEN or an exafy_admin JWT
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
import { requireServiceOrAdmin, getControlPlaneActor } from '../middleware/require-service-or-admin';

const router = Router();

// =============================================================================
// Caller identity (VTID-05048)
// =============================================================================
//
// Writes used to take the actor and role from caller-supplied x-user-id /
// x-user-role headers, with the role defaulting to 'operator' — which was on
// the allow list, so an unauthenticated POST with no headers at all flipped a
// system control (the autonomy kill switches included). The POST route now
// sits behind requireServiceOrAdmin and the actor comes from the verified
// credential only. Reads stay open: the Command Hub lists controls without a
// token.

/** Optional, informational label an in-process ORB tool adds to a service call. */
const ORB_CALLER_HEADER = 'x-orb-caller-user-id';
const ORB_CALLER_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Actor + role for the audit row. Service token → `service:internal` (plus
 * `/orb:<user_id>` when an ORB tool names the member it acted for — a label
 * only, never used for authorization); exafy_admin JWT → `admin:<user_id>`.
 */
export function resolveControlActor(req: Request): { userId: string; role: string } {
  const actor = getControlPlaneActor(req);
  if (actor.startsWith('service:')) {
    const orbCaller = req.get(ORB_CALLER_HEADER)?.trim();
    const label = orbCaller && ORB_CALLER_RE.test(orbCaller) ? `${actor}/orb:${orbCaller}` : actor;
    return { userId: label, role: 'service' };
  }
  return { userId: actor, role: 'exafy_admin' };
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
 * Auth: GATEWAY_SERVICE_TOKEN or an exafy_admin JWT (VTID-05048). The
 * x-user-id / x-user-role headers are ignored.
 *
 * Rules:
 * - enabled=false (disarming) does not require duration
 * - reason is always required
 * - both accepted callers are platform-level, so arming without a duration
 *   stays allowed (the old dev_admin/admin/operator behaviour)
 */
router.post('/:key', requireServiceOrAdmin, async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { userId, role } = resolveControlActor(req);

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
