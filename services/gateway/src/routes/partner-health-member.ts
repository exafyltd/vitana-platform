/**
 * VTID-05055 — Health Hub Phase 0 / D8: the member's side of a partner link.
 *
 * Mounted at /api/v1/partner-health/member. Auth: the member's own JWT
 * (requireAuthWithTenant). Staff propose a link in the admin portal
 * (POST /api/v1/admin/partner-health/inbox/:id/confirm-match); nothing reaches
 * the member's orders, calendar, ORB tools, wake brief or results until the
 * member confirms here.
 *
 * Scoping: every query is filtered by identity.user_id ONLY — never by the
 * session's tenant. A member of several tenants still sees a request proposed
 * in another tenant; the stored proposed_tenant_id is authoritative and is
 * re-checked inside fn_confirm_partner_link_request.
 *
 * Responses carry only { id, partner_display_name, test_name, proposed_at }:
 * never raw_payload, candidate ids or any staff identity
 * (proposed_by_admin_id / resolved_by_admin_id).
 *
 * Tolerates the unapplied migration: GET answers an empty list, confirm and
 * decline answer 503 — never the old direct link.
 */

import { Router, Request, Response } from 'express';
import { requireAuthWithTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  isMissingSchemaError,
  materializeMemberConfirmedLink,
  declineMemberLink,
} from '../services/partner-health/link-confirmation';

const router = Router();
const VTID = 'VTID-05055';

function getUserId(req: Request): string | null {
  const auth = req as AuthenticatedRequest;
  return auth.identity?.user_id ?? null;
}

interface PendingRequestRow {
  id: string;
  proposed_test_name: string | null;
  proposed_at: string | null;
  partner_registry?: { display_name: string } | { display_name: string }[] | null;
}

function partnerName(pr: PendingRequestRow['partner_registry']): string {
  const name = Array.isArray(pr) ? pr[0]?.display_name : pr?.display_name;
  return name ?? '';
}

router.get('/link-requests', requireAuthWithTenant, async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await supabase
    .from('partner_health_result_inbox')
    .select('id, proposed_test_name, proposed_at, partner_registry(display_name)')
    .eq('proposed_user_id', userId)
    .eq('member_link_status', 'pending_member')
    .eq('resolved', false)
    .order('proposed_at', { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingSchemaError(error)) {
      console.warn('[VTID-05055] link-requests: proposal columns missing (migration not applied) — answering an empty list.');
      return res.json({ ok: true, requests: [] });
    }
    return res.status(500).json({ ok: false, error: 'LINK_REQUESTS_UNAVAILABLE' });
  }

  const requests = ((data ?? []) as PendingRequestRow[]).map((r) => ({
    id: r.id,
    partner_display_name: partnerName(r.partner_registry),
    test_name: r.proposed_test_name ?? '',
    proposed_at: r.proposed_at,
  }));
  return res.json({ ok: true, requests });
});

router.post('/link-requests/:id/confirm', requireAuthWithTenant, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: materializeMemberConfirmedLink() emits
  // health_test.order_created (actor = the member) itself, after the
  // transaction commits — this handler only scopes and maps the outcome.
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  // Scoped read first: a row that is not the caller's is a 404, never a 409,
  // so another member's request does not leak its existence.
  const { data: row, error } = await supabase
    .from('partner_health_result_inbox')
    .select('id, member_link_status, resolved')
    .eq('id', req.params.id)
    .eq('proposed_user_id', userId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return res.status(503).json({ ok: false, error: 'MEMBER_CONFIRMATION_UNAVAILABLE' });
    return res.status(500).json({ ok: false, error: 'CONFIRM_FAILED' });
  }
  if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const current = row as { id: string; member_link_status: string | null; resolved: boolean };
  if (current.member_link_status !== 'pending_member' || current.resolved) {
    return res.status(409).json({ ok: false, error: 'NOT_PENDING' });
  }

  const outcome = await materializeMemberConfirmedLink(supabase, { id: current.id, proposed_user_id: userId });
  if (!outcome.ok) return res.status(outcome.status).json({ ok: false, error: outcome.error });
  return res.json({ ok: true, status: 'confirmed', order_id: outcome.order_id });
});

router.post('/link-requests/:id/decline', requireAuthWithTenant, async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const outcome = await declineMemberLink(supabase, { inbox_id: req.params.id, user_id: userId });
  if (!outcome.ok) return res.status(outcome.status).json({ ok: false, error: outcome.error });

  const emitted = await emitOasisEvent({
    vtid: VTID,
    type: 'health_test.link_declined',
    source: 'partner-health-member',
    status: 'info',
    message: `Member declined the proposed partner link for inbox row ${req.params.id}.`,
    payload: { inbox_id: req.params.id },
    actor_id: userId,
    actor_role: 'user',
  }).catch((err: unknown) => ({ ok: false, error: String(err) }));
  if (!emitted.ok) console.error(`[VTID-05055] health_test.link_declined emit failed for inbox ${req.params.id}`);

  return res.json({ ok: true, status: 'declined' });
});

export default router;
