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
 *
 * VTID-05055 (Health Hub Phase 0 / D8):
 *   - confirm-match is now a PROPOSAL. It writes the proposal onto the inbox
 *     row (member_link_status = 'pending_member'), notifies the member and
 *     answers 202. The link + order are created only when the member
 *     confirms (routes/partner-health-member.ts →
 *     services/partner-health/link-confirmation.ts). Without the VTID-05055
 *     migration it answers 503 — never the old direct link.
 *   - GET /orders, /inbox and /candidates/:inboxId write a
 *     health_test.staff_read OASIS event (ids and counts only) before
 *     answering, and fail closed (503 AUDIT_UNAVAILABLE) if it cannot be
 *     written.
 *   - upload-result takes partner_key from the order's own partner_registry
 *     row. The body's partner_key is ignored (a mismatch is logged); there is
 *     no 'doctorbox' default any more.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { notifyUserAsync } from '../services/notification-service';
import { tt } from '../i18n/catalog';
import { getUserLocale } from '../i18n/server-locale';
import { isMissingSchemaError } from '../services/partner-health/link-confirmation';
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

type ResultAdapter = { receiveResult: typeof doctorBoxAdapter.receiveResult; validateResult: typeof doctorBoxAdapter.validateResult };

const ADAPTERS: Record<string, ResultAdapter> = {
  doctorbox: doctorBoxAdapter,
};

/**
 * VTID-05055: the documented JSON format staff paste for a partner that has
 * no adapter of its own (integration_mode 'portal_manual', i.e. a
 * self-registered partner org). It is the generic shape the DoctorBox parser
 * reads — { external_order_ref, result_date?, biomarkers: [{ code?, name,
 * value, unit, ref_low?, ref_high? }] } — reused under its own explicit name
 * and recorded on every result it parses (raw_payload._upload_format). It is
 * never a silent fallback: a partner that is neither registered in ADAPTERS
 * nor portal_manual gets 400 NO_ADAPTER.
 */
export const MANUAL_UPLOAD_FORMAT: { name: 'vitana_manual_json_v1'; adapter: ResultAdapter } = {
  name: 'vitana_manual_json_v1',
  adapter: doctorBoxAdapter,
};

const VTID_D8 = 'VTID-05055';

/**
 * VTID-05055: one audit event per staff read of member health data. Ids and
 * counts only — never raw_payload, test names or results. Returns false when
 * the event could not be written; the caller then fails closed (503).
 */
async function auditStaffRead(
  req: Request,
  access: PartnerHealthAccess,
  route: string,
  details: Record<string, unknown>
): Promise<boolean> {
  const actorId = getAdminId(req);
  try {
    const result = await emitOasisEvent({
      vtid: VTID_D8,
      type: 'health_test.staff_read',
      source: 'admin-partner-health',
      status: 'info',
      message: `Staff read ${route} (partner health).`,
      payload: { route, access_scope: access.scope, ...details },
      actor_id: actorId ?? undefined,
      actor_role: access.scope === 'admin' ? 'admin' : 'user',
    });
    if (!result?.ok) {
      console.error(`[VTID-05055] health_test.staff_read not written for ${route}: ${result?.error ?? 'unknown'} — failing closed`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[VTID-05055] health_test.staff_read threw for ${route}: ${String(err)} — failing closed`);
    return false;
  }
}

function uniqueStrings(values: Array<unknown>): string[] {
  return Array.from(new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0)));
}

function auditUnavailable(res: Response) {
  return res.status(503).json({ ok: false, error: 'AUDIT_UNAVAILABLE' });
}

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
  partner_registry?: { display_name: string; partner_key?: string | null; integration_mode?: string | null } | { display_name: string; partner_key?: string | null; integration_mode?: string | null }[] | null;
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
  const orders = ((data ?? []) as Array<{ id?: string; user_id?: string; partner_id: string; assigned_professional_user_id: string | null }>).filter(
    (o) => canActOnOrder(access, o)
  );
  const audited = await auditStaffRead(req, access, 'GET /orders', {
    partner_ids: uniqueStrings(orders.map((o) => o.partner_id)),
    row_count: orders.length,
    subject_user_ids: uniqueStrings(orders.map((o) => o.user_id)),
    order_ids: uniqueStrings(orders.map((o) => o.id)),
    status_filter: status,
  });
  if (!audited) return auditUnavailable(res);
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

  const LEGACY_COLUMNS = 'id, partner_id, raw_payload, candidate_user_ids, reason, resolved, created_at, partner_registry(display_name)';
  // VTID-05055: the proposal state so staff see "awaiting member" / "declined".
  const D8_COLUMNS = `${LEGACY_COLUMNS}, member_link_status, proposed_at, proposed_user_id`;
  const runQuery = (columns: string) => {
    let query = supabase
      .from('partner_health_result_inbox')
      .select(columns)
      .eq('resolved', false)
      .order('created_at', { ascending: true })
      .limit(100);
    if (access.scope === 'org') query = query.in('partner_id', access.fullAccessPartnerIds);
    return query;
  };

  let { data, error } = await runQuery(D8_COLUMNS);
  if (error && isMissingSchemaError(error)) {
    // Migration not applied yet — the legacy column list (F18 pattern).
    ({ data, error } = await runQuery(LEGACY_COLUMNS));
  }
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const inbox = (data ?? []) as unknown as Array<{ id?: string; partner_id?: string; candidate_user_ids?: string[] | null; proposed_user_id?: string | null }>;
  const audited = await auditStaffRead(req, access, 'GET /inbox', {
    partner_ids: uniqueStrings(inbox.map((r) => r.partner_id)),
    row_count: inbox.length,
    subject_user_ids: uniqueStrings(inbox.flatMap((r) => [...(r.candidate_user_ids ?? []), r.proposed_user_id])),
    inbox_ids: uniqueStrings(inbox.map((r) => r.id)),
    status_filter: 'unresolved',
  });
  if (!audited) return auditUnavailable(res);
  return res.json({ ok: true, inbox });
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

  const inboxPartnerId = (inboxRow as { partner_id: string }).partner_id;
  const raw = (inboxRow as { raw_payload: Record<string, unknown>; partner_id: string; created_at: string }).raw_payload;
  const merchantId = typeof raw?.merchant_id === 'string' ? raw.merchant_id : null;
  if (!merchantId) {
    const audited = await auditStaffRead(req, access, 'GET /candidates/:inboxId', {
      partner_ids: [inboxPartnerId],
      row_count: 0,
      subject_user_ids: [],
      inbox_id: req.params.inboxId,
    });
    if (!audited) return auditUnavailable(res);
    return res.json({ ok: true, candidates: [], note: 'No merchant_id on this inbox row — candidate matching needs the DoctorBox merchants.id to correlate against product_clicks.' });
  }

  const candidates = await findClickCorrelationCandidates(
    supabase,
    merchantId,
    (inboxRow as { created_at: string }).created_at
  );
  const audited = await auditStaffRead(req, access, 'GET /candidates/:inboxId', {
    partner_ids: [inboxPartnerId],
    row_count: candidates.length,
    subject_user_ids: uniqueStrings((candidates as Array<{ user_id?: string }>).map((c) => c.user_id)),
    inbox_id: req.params.inboxId,
  });
  if (!audited) return auditUnavailable(res);
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
  // VTID-05055: informational only. The partner is the order's own partner —
  // a body value never chooses the adapter, the consent check or the
  // lab_reports provenance, and there is no 'doctorbox' default.
  const bodyPartnerKey = typeof req.body?.partner_key === 'string' ? req.body.partner_key : null;
  const rawResult = req.body?.result;
  if (!orderId) return res.status(400).json({ ok: false, error: 'order_id is required — confirm a match first (POST /inbox/:id/confirm-match) if this came from the inbox' });
  if (!rawResult || typeof rawResult !== 'object') return res.status(400).json({ ok: false, error: 'result is required' });

  const { data: orderRow, error: orderErr } = await supabase
    .from('partner_health_test_orders')
    .select('id, tenant_id, user_id, partner_id, assigned_professional_user_id, status, test_name, partner_registry(partner_key, display_name, integration_mode)')
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

  const prRaw = (orderRow as { partner_registry?: unknown }).partner_registry;
  const registry = (Array.isArray(prRaw) ? prRaw[0] : prRaw) as { partner_key?: string | null; integration_mode?: string | null } | null | undefined;
  const partnerKey = typeof registry?.partner_key === 'string' && registry.partner_key ? registry.partner_key : null;
  if (!partnerKey) {
    console.error(`[VTID-05055] upload-result: order ${orderId} has no partner_registry row — refusing (no default partner).`);
    return res.status(500).json({ ok: false, error: 'PARTNER_NOT_REGISTERED' });
  }

  if (bodyPartnerKey && bodyPartnerKey !== partnerKey) {
    console.warn(`[VTID-05055] upload-result: body partner_key=${bodyPartnerKey} ignored; order ${orderId} belongs to partner_key=${partnerKey}.`);
    await emitOasisEvent({
      vtid: VTID_D8,
      type: 'health_test.partner_key_mismatch',
      source: 'admin-partner-health',
      status: 'warning',
      message: `upload-result for order ${orderId}: body partner_key ignored, the order's own partner was used.`,
      payload: { order_id: orderId, partner_key: partnerKey, body_partner_key: bodyPartnerKey, partner_key_mismatch: true },
      actor_id: getAdminId(req) ?? undefined,
    }).catch(() => undefined);
  }

  let adapter: ResultAdapter | undefined = ADAPTERS[partnerKey];
  let uploadFormat: string = partnerKey;
  if (!adapter && registry?.integration_mode === 'portal_manual') {
    adapter = MANUAL_UPLOAD_FORMAT.adapter;
    uploadFormat = MANUAL_UPLOAD_FORMAT.name;
  }
  if (!adapter) return res.status(400).json({ ok: false, error: 'NO_ADAPTER', message: `no adapter registered for partner_key=${partnerKey}` });

  const order = toOrderRow(orderRow);
  const payload: PartnerResultPayload = await adapter.receiveResult(rawResult as Record<string, unknown>);
  if (uploadFormat === MANUAL_UPLOAD_FORMAT.name) {
    // Recorded on the result itself (partner_health_results.raw_payload).
    payload.raw = { ...(payload.raw ?? {}), _upload_format: MANUAL_UPLOAD_FORMAT.name };
  }

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
  return res.json({ ...outcome, ok: true, partner_key: partnerKey, upload_format: uploadFormat });
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

// VTID-05055: confirm-match PROPOSES the member; it no longer creates the
// customer link or the order. Those are created only when the proposed
// member confirms in the app (routes/partner-health-member.ts). Kept to
// full-partner-access (org_admin/staff, or admin) only, same as the inbox
// listing above; a professional cannot propose a brand-new order.
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
    .select('id, partner_id, resolved, member_link_status, member_declined_user_ids, partner_registry(display_name)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (inboxErr) {
    if (isMissingSchemaError(inboxErr)) {
      // Migration not applied: never fall back to the old direct link.
      return res.status(503).json({ ok: false, error: 'MEMBER_CONFIRMATION_UNAVAILABLE' });
    }
    return res.status(500).json({ ok: false, error: inboxErr.message });
  }
  if (!inboxRow) return res.status(404).json({ ok: false, error: 'inbox row not found' });
  const inbox = inboxRow as {
    id: string;
    partner_id: string;
    resolved: boolean;
    member_link_status: 'pending_member' | 'confirmed' | 'declined' | null;
    member_declined_user_ids: string[] | null;
    partner_registry?: { display_name: string } | { display_name: string }[] | null;
  };
  if (inbox.resolved) return res.status(409).json({ ok: false, error: 'already resolved' });
  if (!hasFullPartnerAccess(access, inbox.partner_id)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  if (inbox.member_link_status === 'pending_member') {
    return res.status(409).json({ ok: false, error: 'PENDING_MEMBER', message: 'already sent to a member for confirmation' });
  }
  if ((inbox.member_declined_user_ids ?? []).includes(matchedUserId)) {
    return res.status(409).json({ ok: false, error: 'MEMBER_DECLINED', message: 'this member already said this result is not theirs' });
  }

  // The named user must belong to the named tenant (same lookup shape as
  // requirePartnerHealthAccess). Re-checked again inside the member's confirm.
  const { data: membership, error: membershipErr } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', matchedUserId)
    .eq('tenant_id', matchedTenantId)
    .maybeSingle();
  if (membershipErr) return res.status(500).json({ ok: false, error: membershipErr.message });
  if (!membership) return res.status(400).json({ ok: false, error: 'USER_NOT_IN_TENANT' });

  const adminId = getAdminId(req);

  // Compare-and-set: only from "no proposal" or "declined" (by someone else).
  const { data: proposed, error: proposeErr } = await supabase
    .from('partner_health_result_inbox')
    .update({
      member_link_status: 'pending_member',
      proposed_user_id: matchedUserId,
      proposed_tenant_id: matchedTenantId,
      proposed_test_name: testName,
      proposed_external_order_ref: externalOrderRef,
      proposed_by_admin_id: adminId,
      proposed_at: new Date().toISOString(),
      member_decided_at: null,
    })
    .eq('id', inbox.id)
    .eq('resolved', false)
    .or('member_link_status.is.null,member_link_status.eq.declined')
    .select('id');
  if (proposeErr) {
    if (isMissingSchemaError(proposeErr)) return res.status(503).json({ ok: false, error: 'MEMBER_CONFIRMATION_UNAVAILABLE' });
    return res.status(500).json({ ok: false, error: proposeErr.message });
  }
  if (!Array.isArray(proposed) || proposed.length === 0) {
    return res.status(409).json({ ok: false, error: 'PENDING_MEMBER', message: 'the row changed while proposing; reload the inbox' });
  }

  const pr = inbox.partner_registry;
  const partnerName = (Array.isArray(pr) ? pr[0]?.display_name : pr?.display_name) ?? '';
  const locale = await getUserLocale(supabase, matchedUserId);
  notifyUserAsync(
    matchedUserId,
    matchedTenantId,
    'partner_link_request',
    {
      title: tt('notif.partner_link_request.title', locale, { partner_name: partnerName }),
      body: tt('notif.partner_link_request.body', locale, { partner_name: partnerName, test_name: testName }),
      data: { inbox_id: inbox.id, url: '/patient/results' },
    },
    supabase
  );

  await emitOasisEvent({
    vtid: VTID_D8,
    type: 'health_test.link_proposed',
    source: 'admin-partner-health',
    status: 'info',
    message: `Staff proposed a member for inbox row ${inbox.id}; waiting for the member to confirm.`,
    payload: { inbox_id: inbox.id, partner_id: inbox.partner_id, proposed_user_id: matchedUserId, proposed_tenant_id: matchedTenantId },
    actor_id: adminId ?? undefined,
  });

  return res.status(202).json({ ok: true, status: 'pending_member', inbox_id: inbox.id });
});

export default router;
