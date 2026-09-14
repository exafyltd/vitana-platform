/**
 * VTID-03885 — Partner Health Test Integration: admin portal routes.
 *
 * Mounted at /api/v1/admin/partner-health. Gated by requireTenantAdmin,
 * same as admin-marketplace.ts.
 *
 * This is the fallback UI that makes the whole feature usable for
 * DoctorBox TODAY, with zero DoctorBox API access: an admin creates an
 * order after DoctorBox tells them about it out-of-band, uploads the
 * result they received by email/portal, and — the one hard-stop safety
 * requirement in the whole spec — an ambiguous/no-match result can only
 * ever be resolved into a real order by an EXPLICIT confirm-match call.
 * Nothing here writes to partner_health_results/biomarker_results
 * directly; every write goes through services/partner-health/ingestion.ts.
 */

import { Router, Request, Response } from 'express';
import { requireTenantAdmin } from '../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { findClickCorrelationCandidates } from '../services/partner-health/id-matching';
import { ingestPartnerResult, recordStatusChange, type PartnerOrderRow } from '../services/partner-health/ingestion';
import doctorBoxAdapter from '../services/partner-health/doctorbox-adapter';
import type { CanonicalHealthTestStatus, PartnerResultPayload } from '../services/partner-health/types';

const router = Router();

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

router.get('/orders', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const status = typeof req.query.status === 'string' ? req.query.status : null;
  let query = supabase
    .from('partner_health_test_orders')
    .select('id, tenant_id, user_id, partner_id, external_order_ref, test_name, status, status_updated_at, ordered_at, partner_registry(display_name)')
    .order('ordered_at', { ascending: false })
    .limit(200);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, orders: data ?? [] });
});

router.patch('/orders/:id', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

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
    .select('id, tenant_id, user_id, partner_id, status, test_name, partner_registry(display_name)')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) return res.status(500).json({ ok: false, error: orderErr.message });
  if (!orderRow) return res.status(404).json({ ok: false, error: 'order not found' });

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

router.get('/inbox', requireTenantAdmin, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await supabase
    .from('partner_health_result_inbox')
    .select('id, partner_id, raw_payload, candidate_user_ids, reason, resolved, created_at, partner_registry(display_name)')
    .eq('resolved', false)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, inbox: data ?? [] });
});

router.get('/candidates/:inboxId', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data: inboxRow, error: inboxErr } = await supabase
    .from('partner_health_result_inbox')
    .select('id, partner_id, raw_payload, created_at')
    .eq('id', req.params.inboxId)
    .maybeSingle();
  if (inboxErr) return res.status(500).json({ ok: false, error: inboxErr.message });
  if (!inboxRow) return res.status(404).json({ ok: false, error: 'inbox row not found' });

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

router.post('/inbox/:id/upload-result', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const orderId = typeof req.body?.order_id === 'string' ? req.body.order_id : null;
  const partnerKey = typeof req.body?.partner_key === 'string' ? req.body.partner_key : 'doctorbox';
  const rawResult = req.body?.result;
  if (!orderId) return res.status(400).json({ ok: false, error: 'order_id is required — confirm a match first (POST /inbox/:id/confirm-match) if this came from the inbox' });
  if (!rawResult || typeof rawResult !== 'object') return res.status(400).json({ ok: false, error: 'result is required' });

  const adapter = ADAPTERS[partnerKey];
  if (!adapter) return res.status(400).json({ ok: false, error: `no adapter registered for partner_key=${partnerKey}` });

  const { data: orderRow, error: orderErr } = await supabase
    .from('partner_health_test_orders')
    .select('id, tenant_id, user_id, partner_id, status, test_name, partner_registry(display_name)')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) return res.status(500).json({ ok: false, error: orderErr.message });
  if (!orderRow) return res.status(404).json({ ok: false, error: 'order not found' });

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

// ==================== Confirm match (the hard-stop step) ====================

router.post('/inbox/:id/confirm-match', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

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

  return res.json({ ok: true, order_id: (order as { id: string }).id, link_id: (link as { id: string }).id });
});

export default router;
