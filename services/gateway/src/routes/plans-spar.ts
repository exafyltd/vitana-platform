/**
 * VTID-04868 — Plan Sparring Gate, gateway tier. Mounted at /api/v1/plans/spar.
 *
 *   POST /             create a session and run partner round 1
 *   POST /:id/rounds   planner responses + revised plan → next partner pass
 *   GET  /:id          the record (rounds verbatim)
 *   POST /:id/approve  record the verified exafy_admin approval
 *
 * Auth: create / rounds / read accept GATEWAY_SERVICE_TOKEN or an exafy_admin
 * JWT (same rule as /vtid/allocate since VTID-04727). Approve accepts ONLY an
 * exafy_admin JWT — the approver is the verified identity on the request,
 * never a body field; it is the one path that sets human_approved_by.
 *
 * OASIS: sparring rounds and approvals live only in plan_sparring_sessions
 * (design decision F3) — the OASIS events are emitted at VTID allocation
 * (vtid.plan_sparring.attached / .missing) and by the reconciler.
 */

import { Router, Request, Response } from 'express';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import { requireAdminAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  SparringError,
  approveSparringSession,
  createSparringSession,
  defaultDeps,
  getSparringSession,
  submitPlannerRound,
  type PlanSparringDeps,
} from '../services/plan-sparring/plan-sparring-service';

type DepsFactory = () => PlanSparringDeps;

function sendError(res: Response, err: unknown): Response {
  if (err instanceof SparringError) {
    return res.status(err.status).json({ ok: false, error: err.code, ...(err.message !== err.code ? { message: err.message } : {}) });
  }
  console.error('[plans-spar] unexpected error:', err);
  return res.status(500).json({ ok: false, error: 'internal_error' });
}

/** Factory so tests inject deps; production uses `plansSparRouter` below. */
export function createPlansSparRouter(getDeps: DepsFactory = defaultDeps): Router {
  const router = Router();

  router.post('/', requireServiceOrAdmin, async (req: Request, res: Response) => {
    // impact-allow-no-oasis: sparring rounds are stored only in plan_sparring_sessions (F3); OASIS events fire at allocation.
    try {
      const { session, deduplicated } = await createSparringSession(req.body, getDeps());
      return res.status(deduplicated ? 200 : 201).json({ ok: true, deduplicated, session });
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.post('/:id/rounds', requireServiceOrAdmin, async (req: Request, res: Response) => {
    // impact-allow-no-oasis: sparring rounds are stored only in plan_sparring_sessions (F3); OASIS events fire at allocation.
    try {
      const session = await submitPlannerRound(req.params.id, req.body, getDeps());
      return res.status(200).json({ ok: true, session });
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.get('/:id', requireServiceOrAdmin, async (req: Request, res: Response) => {
    try {
      const session = await getSparringSession(req.params.id, getDeps());
      return res.status(200).json({ ok: true, session });
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.post('/:id/approve', requireAdminAuth, async (req: Request, res: Response) => {
    // impact-allow-no-oasis: the approval is recorded on the sparring record (F3); OASIS events fire at allocation.
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity || identity.exafy_admin !== true) {
      return res.status(403).json({ ok: false, error: 'exafy_admin_required' });
    }
    try {
      const session = await approveSparringSession(
        req.params.id,
        { user_id: identity.user_id, email: identity.email ?? null },
        req.body,
        getDeps(),
      );
      return res.status(200).json({ ok: true, session });
    } catch (err) {
      return sendError(res, err);
    }
  });

  return router;
}

export const plansSparRouter = createPlansSparRouter();
export default plansSparRouter;
