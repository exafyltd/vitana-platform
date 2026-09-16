/**
 * VTID-03885 — Partner Health Test Integration: admin portal routes.
 * VTID-03932 — generalized (Commerce Partner Onboarding Phase 1) so a
 * partner org's OWN staff/professional members can use these same
 * handlers for their org's orders, not just a Vitana tenant admin.
 *
 * Mounted at /api/v1/admin/partner-health. Gated by
 * requirePartnerHealthAccess, which grants either:
 *   - { scope: 'admin' }: exafy_admin or Vitana tenant admin — sees/acts on
 *     everything, byte-for-byte the original VTID-03885 behavior.
 *   - { scope: 'org' }: a partner_organization_members row — org_admin/
 *     staff get full access to their org's linked partner_registry rows;
 *     professional gets access ONLY to orders assigned to them
 *     (assigned_professional_user_id), never a standing "see everything
 *     for this patient" grant. See services/partner-health/org-access.ts.
 *
 * This is the fallback UI that makes the whole feature usable for
 * DoctorBox TODAY, with zero DoctorBox API access: an admin (or now a
 * partner's own staff) creates an order after being told about it
 * out-of-band, uploads the result they received by email/portal, and —
 * the one hard-stop safety requirement in the whole spec — an
 * ambiguous/no-match result can only ever be resolved into a real order
 * by an EXPLICIT confirm-match call. Nothing here writes to
 * partner_health_results/biomarker_results directly; every write goes
 * through services/partner-health/ingestion.ts.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { findClickCorrelationCandidates } from '../services/partner-health/id-matching';
import { ingestPartnerResult, recordStatusChange, quarantineUnmatchedResult, type PartnerOrderRow } from '../services/partner-health/ingestion';
import doctorBoxAdapter from '../services/partner-health/doctorbox-adapter';
import type { CanonicalHealthTestStatus, PartnerResultPayload } from '../services/partner-health/types';
import {
  resolveOrgHealthAccess,
  hasFullPartnerAccess,
  canActOnOrder,
  allVisiblePartnerIds,
  type PartnerHealthAccess,
} from '../services/partner-health/org-access';

const router = Router();

interface PartnerHealthRequest extends AuthenticatedRequest {
  partnerHealthAccess?: PartnerHealthAccess;
}

/**
 * VTID-03932: replaces the old requireTenantAdmin gate. Grants
 * { scope: 'admin' } to exafy_admin/Vitana tenant admins (unchanged
 * behavior) or { scope: 'org' } to a partner org's own staff/professional
 * member. 403s only when the caller is neither.
 */
async function requirePartnerHealthAccess(req: Request, res: Response, next: NextFunction) {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const identity = (req as AuthenticatedRequest).identity;
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  if (identity.exafy_admin) {
    (req as PartnerHealthRequest).partnerHealthAccess = { scope: 'admin' };
    return next();
  }

  if (identity.tenant_id) {
    const { data: tenantRow } = await supabase
      .from('user_tenants')
      .select('active_role')
      .eq('user_id', identity.user_id)
      .eq('tenant_id', identity.tenant_id)
      .maybeSingle();
    if ((tenantRow as { active_role?: string } | null)?.active_role === 'admin') {
      (req as PartnerHealthRequest).partnerHealthAccess = { scope: 'admin' };
      return next();
    }
  }

  const orgAccess = await resolveOrgHealthAccess(supabase, identity.user_id);
  if (orgAccess) {
    (req as PartnerHealthRequest).partnerHealthAccess = orgAccess;
    return next();
  }

  return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Requires Vitana tenant-admin access or membership in a partner organization.' });
}

function getAccess(req: Request): PartnerHealthAccess {
  // requirePartnerHealthAccess always sets this before next() — a missing
  // value here is a routing bug, not a runtime possibility to degrade from.
  return (req as PartnerHealthRequest).partnerHealthAccess as PartnerHealthAccess;
}

const ADAPTERS: Record<string, { receiveResult: typeof doctorBoxAdapter.receiveResult; validateResult: typeof doctorBoxAdapter.validateResult }> = {
  doctorbox: doctorBoxAdapter,
};

function getAdminId(req: Request): string | null {
  const auth = req as AuthenticatedRequest;
  return auth.identity?.user_id ?? null;
}

function toOrderRow(row: {
  id: string;
  tenant_id: string;
  user_id: string;
  partner_id: string;
  status: CanonicalHealthTestStatus;
  test_name: string;
  partner_registry?: { display_name: string } | { display_name: string }[] | null;
}): PartnerOrderRow {
  const pr = row.partner_registry;
  const partnerDisplayName = Array.isArray(pr) ? pr[0]?.display_name : pr?.display_name;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    partner_id: row.partner_id,
    partner_display_name: partnerDisplayName ?? '',
    status: row.status,
    test_name: row.test_name,
  };
}

// ==================== Orders ====================

router.get('/orders', requireAuth, requirePartnerHealthAccess, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const access = getAccess(req);

  const status = typeof req.query.status === 'string' ? req.query.status : null;
  let query = supabase
    .from('partner_health_test_orders')
    .select('id, tenant_id, user_id, partner_id, assigned_professional_user_id, external_order_ref, test_name, status, status_updated_at, ordered_at, partner_registry(display_name)')
    .order('ordered_at', { ascending: false })
    .limit(200);
  if (status) query = query.eq('status', status);
  const visiblePartnerIds = allVisiblePartnerIds(access);
  if (visiblePartnerIds !== null) query = query.in('partner_id', visiblePartnerIds);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  // VTID-03932: a professional-only org grant is assigned-order-only —
  // filtered here rather than in SQL to keep the query builder simple;
  // this never returns rows the caller couldn't already list partner_ids for.
  const orders = ((data ?? []) as Array<{ partner_id: string; assigned_professional_user_id: string | null }>).filter(
    (o) => canActOnOrder(access, o)
  );
  return res.json({ ok: true, orders });
});

router.patch('/orders/:id', requireAuth, requirePartnerHealthAccess, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: the state transition IS recorded — via
  // recordStatusChange() below, which emits health_test.status_changed
  // itself. This handler's own body has no direct emitOasisEvent call
  // because the ingestion pipeline (not this route) owns that emission.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const access = getAccess(req);

  const orderId = req.params.id;
  const toStatus = typeof req.body?.status === 'string' ? (req.body.status as CanonicalHealthTestStatus) : null;
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  if (!toStatus) return res.status(400).json({ ok: false, error: 'status is required' });
  // result_ready is a derived state that only ingestPartnerResult() may set
  // (it has to land alongside a real result row) — a manual PATCH to it
  // would desync the order from the truth in partner_health_results.
  if (toStatus === 'result_ready') {
    return res.status(400).json({ ok: false, error: 'result_ready can only be set by uploading a result — use POST /inbox/:id/upload-result or the webhook path' });
  }

  const { data: orderRow, error: orderErr } = await supabase
    .from('partner_health_test_orders')
    .select('id, tenant_id, user_id, partner_id, assigned_professional_user_id, status, test_name, partner_registry(display_name)')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) return res.status(500).json({ ok: false, error: orderErr.message });
  if (!orderRow) return res.status(404).json({ ok: false, error: 'order not found' });
  if (!canActOnOrder(access, orderRow as { partner_id: string; assigned_professional_user_id: string | null })) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  }

  const order = toOrderRow(orderRow);
  const outcome = await recordStatusChange(supabase, {
    order,
    to_status: toStatus,
    changed_by: 'portal_admin',
    source_ref: getAdminId(req) ?? undefined,
    note,
  });
  if (!outcome.ok) return res.status(500).json({ ok: false, error: outcome.error });
  return res.json({ ok: true });
});

// ==================== Inbox (quarantine queue) ====================

// Inbox rows precede a real order, so there is no assigned_professional
// yet to scope by — visibility here is full-partner-access only
// (org_admin/staff, or admin). A professional-only grant sees none of
// this, matching least-privilege: they act on orders explicitly assigned
// to them, not on their org's whole unresolved queue.
router.get('/inbox', requireAuth, requirePartnerHealthAccess, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const access = getAccess(req);

  let query = supabase
    .from('partner_health_result_inbox')
    .select('id, partner_id, raw_payload, candidate_user_ids, reason, resolved, created_at, partner_registry(display_name)')
    .eq('resolved', false)
    .order('created_at', { ascending: true })
    .limit(100);
  if (access.scope === 'org') query = query.in('partner_id', access.fullAccessPartnerIds);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, inbox: data ?? [] });
});

router.get('/candidates/:inboxId', requireAuth, requirePartnerHealthAccess, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const access = getAccess(req);

  const { data: inboxRow, error: inboxErr } = await supabase
    .from('partner_health_result_inbox')
    .select('id, partner_id, raw_payload, created_at')
    .eq('id', req.params.inboxId)
    .maybeSingle();
  if (inboxErr) return res.status(500).json({ ok: false, error: inboxErr.message });
  if (!inboxRow) return res.status(404).json({ ok: false, error: 'inbox row not found' });
  if (!hasFullPartnerAccess(access, (inboxRow as { partner_id: string }).partner_id)) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  }

  const raw = (inboxRow as { raw_payload: Record<string, unknown>; partner_id: string; created_at: string }).raw_payload;
  const merchantId = typeof raw?.merchant_id === 'string' ? raw.merchant_id : null;
  if (!merchantId) {
    return res.json({ ok: true, candidates: [], note: 'No merchant_id on this inbox row — candidate matching needs the DoctorBox merchants.id to correlate against product_clicks.' });
  }

  const candidates = await findClickCorrelationCandidates(
    supabase,
    merchantId,
    (inboxRow as { created_at: string }).created_at
  );
  return res.json({ ok: true, candidates });
});

// ==================== Upload result (manual, no DoctorBox API) ====================

router.post('/inbox/:id/upload-result', requireAuth, requirePartnerHealthAccess, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: ingestPartnerResult() below emits
  // health_test.result_ready / health_test.result_quarantined itself —
  // this route only orchestrates the call.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const access = getAccess(req);

  const orderId = typeof req.body?.order_id === 'string' ? req.body.order_id : null;
  const partnerKey = typeof req.body?.partner_key === 'string' ? req.body.partner_key : 'doctorbox';
  const rawResult = req.body?.result;
  if (!orderId) return res.status(400).json({ ok: false, error: 'order_id is required — confirm a match first (POST /inbox/:id/confirm-match) if this came from the inbox' });
  if (!rawResult || typeof rawResult !== 'object') return res.status(400).json({ ok: false, error: 'result is required' });

  const adapter = ADAPTERS[partnerKey];
  if (!adapter) return res.status(400).json({ ok: false, error: `no adapter registered for partner_key=${partnerKey}` });

  const { data: orderRow, error: orderErr } = await supabase
    .from('partner_health_test_orders')
    .select('id, tenant_id, user_id, partner_id, assigned_professional_user_id, status, test_name, partner_registry(display_name)')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) return res.status(500).json({ ok: false, error: orderErr.message });
  if (!orderRow) return res.status(404).json({ ok: false, error: 'order not found' });
  // VTID-03932: this is the shared upload primitive — a partner's own
  // assigned professional may upload the result for THEIR order, exactly
  // as a Vitana admin (or the org's own staff) already could.
  if (!canActOnOrder(access, orderRow as { partner_id: string; assigned_professional_user_id: string | null })) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  }

  const order = toOrderRow(orderRow);
  const payload: PartnerResultPayload = await adapter.receiveResult(rawResult as Record<string, unknown>);

  const outcome = await ingestPartnerResult(supabase, {
    order,
    partner_key: partnerKey,
    received_via: 'portal_manual_upload',
    payload,
    validate: adapter.validateResult,
    changed_by: 'portal_admin',
    source_ref: getAdminId(req) ?? undefined,
  });
  if (!outcome.ok) return res.status(500).json({ ok: false, error: outcome.error });
  return res.json({ ...outcome, ok: true });
});

// ==================== Manual inbox entry (VTID-03974) ====================

// A self-registered health partner has no webhook/API integration yet
// (integration_mode: 'portal_manual' — see partner-orgs.ts's activation
// bridge) and quarantineUnmatchedResult() was, until now, only ever
// invoked from the DoctorBox webhook path — so a brand-new partner could
// never get their first order into their own Inbox tab at all. This is
// that missing entry point: staff/org_admin key in a received result by
// hand, and it lands in the SAME inbox row shape + the SAME hard-stop
// confirm-match flow every other partner already uses — no new write
// path, this just reuses quarantineUnmatchedResult() from ingestion.ts.
// Full-partner-access only (org_admin/staff, or admin), same gate as the
// inbox listing and confirm-match above — a professional cannot create a
// brand-new unresolved entry any more than they can confirm-match one.
router.post('/inbox/manual', requireAuth, requirePartnerHealthAccess, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: the state transition IS recorded — via
  // quarantineUnmatchedResult() below, which emits
  // health_test.result_quarantined itself (ingestion.ts). Same pattern as
  // PATCH /orders/:id above: this route's own body has no direct
  // emitOasisEvent call because the ingestion pipeline owns that emission.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const access = getAccess(req);

  const partnerId = typeof req.body?.partner_id === 'string' ? req.body.partner_id : null;
  const rawPayload = req.body?.raw_payload;
  const candidateUserIds = Array.isArray(req.body?.candidate_user_ids)
    ? req.body.candidate_user_ids.filter((v: unknown): v is string => typeof v === 'string')
    : [];

  if (!partnerId) return res.status(400).json({ ok: false, error: 'partner_id is required' });
  if (!rawPayload || typeof rawPayload !== 'object') return res.status(400).json({ ok: false, error: 'raw_payload is required' });
  if (!hasFullPartnerAccess(access, partnerId)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

  // Same "never auto-resolve" rule as every other entry point into the
  // inbox: even a single named candidate still requires an explicit
  // confirm-match call afterward, never applied automatically here.
  const reason: 'no_match' | 'ambiguous_match' = candidateUserIds.length > 0 ? 'ambiguous_match' : 'no_match';
  const outcome = await quarantineUnmatchedResult(supabase, partnerId, rawPayload as Record<string, unknown>, candidateUserIds, reason);
  if (!outcome.ok) return res.status(500).json({ ok: false, error: outcome.error });
  return res.status(201).json({ ok: true, inbox_id: outcome.inbox_id });
});

// ==================== Confirm match (the hard-stop step) ====================

// Confirm-match creates the customer link AND the order in one step — kept
// to full-partner-access (org_admin/staff, or admin) only, same as the
// inbox listing above; a professional cannot self-assign a brand-new order.
router.post('/inbox/:id/confirm-match', requireAuth, requirePartnerHealthAccess, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const access = getAccess(req);

  const matchedUserId = typeof req.body?.matched_user_id === 'string' ? req.body.matched_user_id : null;
  const matchedTenantId = typeof req.body?.matched_tenant_id === 'string' ? req.body.matched_tenant_id : null;
  const testName = typeof req.body?.test_name === 'string' ? req.body.test_name.trim() : '';
  const externalOrderRef = typeof req.body?.external_order_ref === 'string' ? req.body.external_order_ref : null;
  // No ambiguity permitted: the caller must name exactly one user. There is
  // no "pick the top candidate automatically" mode anywhere in this route.
  if (!matchedUserId || !matchedTenantId) {
    return res.status(400).json({ ok: false, error: 'matched_user_id and matched_tenant_id are both required — this endpoint never auto-resolves' });
  }
  if (!testName) return res.status(400).json({ ok: false, error: 'test_name is required' });

  const { data: inboxRow, error: inboxErr } = await supabase
    .from('partner_health_result_inbox')
    .select('id, partner_id, raw_payload, resolved')
    .eq('id', req.params.id)
    .maybeSingle();
  if (inboxErr) return res.status(500).json({ ok: false, error: inboxErr.message });
  if (!inboxRow) return res.status(404).json({ ok: false, error: 'inbox row not found' });
  const inbox = inboxRow as { id: string; partner_id: string; raw_payload: Record<string, unknown>; resolved: boolean };
  if (inbox.resolved) return res.status(409).json({ ok: false, error: 'already resolved' });
  if (!hasFullPartnerAccess(access, inbox.partner_id)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

  const adminId = getAdminId(req);

  // Create the customer link (manual_confirmed) + the order in one admin action.
  const { data: link, error: linkErr } = await supabase
    .from('partner_customer_links')
    .insert({
      tenant_id: matchedTenantId,
      user_id: matchedUserId,
      partner_id: inbox.partner_id,
      external_customer_ref: typeof inbox.raw_payload?.external_customer_ref === 'string' ? inbox.raw_payload.external_customer_ref : null,
      match_confidence: 'manual_confirmed',
      matched_by_admin_id: adminId,
      matched_at: new Date().toISOString(),
      raw: inbox.raw_payload,
    })
    .select('id')
    .single();
  if (linkErr || !link) return res.status(500).json({ ok: false, error: linkErr?.message ?? 'partner_customer_links insert failed' });

  const { data: order, error: orderErr } = await supabase
    .from('partner_health_test_orders')
    .insert({
      tenant_id: matchedTenantId,
      user_id: matchedUserId,
      partner_id: inbox.partner_id,
      partner_customer_link_id: (link as { id: string }).id,
      external_order_ref: externalOrderRef,
      test_name: testName,
      status: 'processing',
    })
    .select('id, tenant_id, user_id, partner_id, status, test_name')
    .single();
  if (orderErr || !order) return res.status(500).json({ ok: false, error: orderErr?.message ?? 'partner_health_test_orders insert failed' });

  await supabase
    .from('partner_health_result_inbox')
    .update({ resolved: true, resolved_by_admin_id: adminId, resolved_order_id: (order as { id: string }).id, resolved_at: new Date().toISOString() })
    .eq('id', inbox.id);

  await emitOasisEvent({
    vtid: 'VTID-03885',
    type: 'health_test.order_created',
    source: 'admin-partner-health',
    status: 'success',
    message: `Admin confirmed a match for inbox row ${inbox.id}, creating order ${(order as { id: string }).id}.`,
    payload: { inbox_id: inbox.id, order_id: (order as { id: string }).id, link_id: (link as { id: string }).id },
    actor_id: adminId ?? undefined,
  });

  return res.json({ ok: true, order_id: (order as { id: string }).id, link_id: (link as { id: string }).id });
});

export default router;
