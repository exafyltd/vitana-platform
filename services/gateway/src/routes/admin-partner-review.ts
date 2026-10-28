/**
 * VTID-04933 — /api/v1/admin/partner-review: the exafy_admin review of
 * Commerce suppliers. Logic in services/partner-review.ts.
 *
 *   GET  /                                    suppliers waiting for a decision (?state=a,b to filter)
 *   GET  /:orgId                              one supplier: facts, checklist, offerings, terms, events
 *   POST /:orgId/approve                      { note? }   verification level 1; live only when every required step is done
 *   POST /:orgId/request-changes              { reason }  back to the supplier (needs_action)
 *   POST /:orgId/reject                       { reason }  terminal
 *   POST /:orgId/products/:productId/keep-offline   { reason }  never listed until allowed
 *   POST /:orgId/products/:productId/allow-listing  { reason? } listed now, or with the org's go-live
 *
 * Reads need an exafy_admin; every write also needs the admin's own session —
 * an AI assistant's delegated token is refused.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { requireOwnSession } from '../middleware/require-own-session';
import { getSupabase } from '../lib/supabase';
import {
  approve,
  listForReview,
  rejectOrg,
  requestChanges,
  reviewDetail,
  setOfferingListing,
} from '../services/partner-review';
import type { ServiceResult } from '../services/partner-onboarding-service';

const router = Router();
router.use(requireAuth, requireExafyAdmin);

const actorOf = (req: Request) => (req as AuthenticatedRequest).identity?.user_id ?? null;

function run(fn: (s: NonNullable<ReturnType<typeof getSupabase>>, req: Request) => Promise<ServiceResult>) {
  return async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
    try {
      const r = await fn(supabase, req);
      return res.status(r.status).json(r.body);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}

router.get('/', run((s, req) => listForReview(s, typeof req.query.state === 'string' ? req.query.state : undefined)));
router.get('/:orgId', run((s, req) => reviewDetail(s, req.params.orgId)));
router.post('/:orgId/approve', requireOwnSession, run((s, req) => approve(s, actorOf(req), req.params.orgId, req.body?.note)));
router.post('/:orgId/request-changes', requireOwnSession, run((s, req) => requestChanges(s, actorOf(req), req.params.orgId, req.body?.reason)));
router.post('/:orgId/reject', requireOwnSession, run((s, req) => rejectOrg(s, actorOf(req), req.params.orgId, req.body?.reason)));
router.post('/:orgId/products/:productId/keep-offline', requireOwnSession,
  run((s, req) => setOfferingListing(s, actorOf(req), req.params.orgId, req.params.productId, 'kept_offline', req.body?.reason)));
router.post('/:orgId/products/:productId/allow-listing', requireOwnSession,
  run((s, req) => setOfferingListing(s, actorOf(req), req.params.orgId, req.params.productId, 'allowed', req.body?.reason)));

export default router;
