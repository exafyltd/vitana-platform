/**
 * VTID-03885 — Partner Health Test Integration: result ingestion + status
 * change pipeline.
 *
 * This is the ONE place that is allowed to:
 *   - write partner_health_results
 *   - project a validated result into biomarker_results/lab_reports
 *   - flip partner_health_test_orders.status
 *   - write partner_health_test_status_history
 *   - notify the user / emit the health_test.* OASIS events
 *
 * Both the (Phase 6) DoctorBox webhook connector and the (Phase 3) admin
 * portal's confirm-match/upload-result routes call these functions rather
 * than writing to any of the above tables directly — that's what makes the
 * "never auto-resolve, always land in the inbox on doubt" rule enforceable
 * from a single place instead of being re-implemented per caller.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkDataSharingConsent } from './consent';
import type {
  CanonicalHealthTestStatus,
  PartnerResultPayload,
  PartnerResultValidationResult,
} from './types';
import { notifyUserAsync } from '../notification-service';
import { tt } from '../../i18n/catalog';
import { getUserLocale } from '../../i18n/server-locale';
import { emitOasisEvent } from '../oasis-event-service';

export interface PartnerOrderRow {
  id: string;
  tenant_id: string;
  user_id: string;
  partner_id: string;
  partner_display_name: string; // e.g. "DoctorBox" — for user-facing notification text; partner_id itself is a UUID
  status: CanonicalHealthTestStatus;
  test_name: string;
}

export type IngestChangedBy = 'partner_webhook' | 'portal_admin' | 'system';

/**
 * Quarantine an inbound result BEFORE an order/identity is even known —
 * the "no candidate" or "more than one candidate, none confirmed" case.
 * Never writes partner_health_results (there is no order to attach it to
 * yet); the raw payload lives on the inbox row itself until an admin
 * resolves it via the (Phase 3) confirm-match endpoint.
 */
export async function quarantineUnmatchedResult(
  sb: SupabaseClient,
  partnerId: string,
  rawPayload: Record<string, unknown>,
  candidateUserIds: string[],
  reason: 'no_match' | 'ambiguous_match'
): Promise<{ ok: boolean; inbox_id?: string; error?: string }> {
  const { data, error } = await sb
    .from('partner_health_result_inbox')
    .insert({
      partner_id: partnerId,
      raw_payload: rawPayload,
      candidate_user_ids: candidateUserIds,
      reason,
    })
    .select('id')
    .single();
  if (error) return { ok: false, error: error.message };

  await emitOasisEvent({
    vtid: 'VTID-03885',
    type: 'health_test.result_quarantined',
    source: 'partner-health/ingestion',
    status: 'warning',
    message: `Partner health result quarantined (${reason}) — no order to attach yet.`,
    payload: { partner_id: partnerId, reason, candidate_count: candidateUserIds.length },
  });

  return { ok: true, inbox_id: (data as { id: string }).id };
}

export interface IngestPartnerResultInput {
  order: PartnerOrderRow;
  partner_key: string;
  received_via: 'webhook' | 'portal_manual_upload';
  payload: PartnerResultPayload;
  validate: (payload: PartnerResultPayload) => PartnerResultValidationResult;
  changed_by: IngestChangedBy;
  source_ref?: string;
}

export type IngestPartnerResultOutcome =
  | { ok: true; quarantined: false; result_id: string; biomarker_result_ids: string[]; already_processed?: boolean }
  | { ok: true; quarantined: true; reason: 'consent_missing' | 'invalid_payload'; result_id?: string; inbox_id?: string }
  | { ok: false; error: string };

/**
 * The core pipeline: identity is already known (an order exists) — this
 * decides consent, validity, and (on success) projects into the tables ORB
 * already reads, then notifies + emits the result-ready event.
 *
 * Idempotent: a duplicate webhook delivery for an order that already has a
 * `valid` partner_health_results row is a no-op (returns the existing row),
 * never a second notification/event.
 */
export async function ingestPartnerResult(
  sb: SupabaseClient,
  input: IngestPartnerResultInput
): Promise<IngestPartnerResultOutcome> {
  const { order, partner_key, received_via, payload, validate, changed_by, source_ref } = input;

  // ── Idempotency — a duplicate delivery for an already-ingested order is a no-op ──
  const { data: existingValid } = await sb
    .from('partner_health_results')
    .select('id, biomarker_result_ids')
    .eq('order_id', order.id)
    .eq('validation_status', 'valid')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingValid) {
    return {
      ok: true,
      quarantined: false,
      result_id: (existingValid as { id: string }).id,
      biomarker_result_ids: ((existingValid as { biomarker_result_ids: string[] }).biomarker_result_ids) || [],
      already_processed: true,
    };
  }

  // ── Consent — checked BEFORE any partner_health_results write ──
  const hasConsent = await checkDataSharingConsent(
    sb,
    { tenant_id: order.tenant_id, user_id: order.user_id },
    'partner_integration',
    partner_key,
    'result_ingestion'
  );
  if (!hasConsent) {
    const { data: inboxRow } = await sb
      .from('partner_health_result_inbox')
      .insert({
        partner_id: order.partner_id,
        raw_payload: payload.raw,
        candidate_user_ids: [order.user_id],
        reason: 'consent_missing',
      })
      .select('id')
      .single();

    await emitOasisEvent({
      vtid: 'VTID-03885',
      type: 'health_test.result_quarantined',
      source: 'partner-health/ingestion',
      status: 'warning',
      message: 'Partner health result quarantined — consent not granted for result_ingestion.',
      payload: { order_id: order.id, partner_key, reason: 'consent_missing' },
      actor_id: order.user_id,
    });

    return { ok: true, quarantined: true, reason: 'consent_missing', inbox_id: (inboxRow as { id: string } | null)?.id };
  }

  // ── Land the raw, partner-shaped result with provenance FIRST ──
  const { data: resultRow, error: resultErr } = await sb
    .from('partner_health_results')
    .insert({
      order_id: order.id,
      partner_id: order.partner_id,
      received_via,
      raw_payload: payload.raw,
      validation_status: 'pending',
    })
    .select('id')
    .single();
  if (resultErr || !resultRow) return { ok: false, error: resultErr?.message ?? 'partner_health_results insert failed' };
  const resultId = (resultRow as { id: string }).id;

  // ── Validate ──
  const validation = validate(payload);
  if (!validation.valid) {
    await sb
      .from('partner_health_results')
      .update({ validation_status: 'invalid', validation_errors: validation.errors, processed_at: new Date().toISOString() })
      .eq('id', resultId);

    await sb.from('partner_health_result_inbox').insert({
      partner_id: order.partner_id,
      raw_payload: payload.raw,
      candidate_user_ids: [order.user_id],
      reason: 'invalid_payload',
    });

    await emitOasisEvent({
      vtid: 'VTID-03885',
      type: 'health_test.result_quarantined',
      source: 'partner-health/ingestion',
      status: 'warning',
      message: 'Partner health result quarantined — payload failed validation.',
      payload: { order_id: order.id, partner_key, reason: 'invalid_payload', errors: validation.errors },
      actor_id: order.user_id,
    });

    return { ok: true, quarantined: true, reason: 'invalid_payload', result_id: resultId };
  }

  // ── Project into the tables ORB/tool_get_lab_results already read ──
  // Identical column shape to health-depth-tools.ts's tool_log_biomarker —
  // deliberately not touching biomarker_results' schema, just writing to it.
  const { data: labReport, error: labErr } = await sb
    .from('lab_reports')
    .insert({
      tenant_id: order.tenant_id,
      user_id: order.user_id,
      source: `partner:${partner_key}`,
      report_date: (payload.result_date ?? new Date().toISOString()).slice(0, 10),
      partner_result_id: resultId,
    })
    .select('id')
    .single();
  if (labErr || !labReport) return { ok: false, error: labErr?.message ?? 'lab_reports insert failed' };
  const labReportId = (labReport as { id: string }).id;

  const biomarkerRows = payload.biomarkers.map((b) => {
    let status: string | null = null;
    if (b.ref_range_low != null && b.ref_range_high != null) {
      status = b.value < b.ref_range_low ? 'low' : b.value > b.ref_range_high ? 'high' : 'normal';
    }
    return {
      tenant_id: order.tenant_id,
      user_id: order.user_id,
      lab_report_id: labReportId,
      biomarker_code: b.code ?? null,
      name: b.name,
      value: b.value,
      unit: b.unit,
      ref_range_low: b.ref_range_low ?? null,
      ref_range_high: b.ref_range_high ?? null,
      status,
      measured_at: payload.result_date ?? new Date().toISOString(),
    };
  });

  let biomarkerResultIds: string[] = [];
  if (biomarkerRows.length > 0) {
    const { data: inserted, error: bmErr } = await sb.from('biomarker_results').insert(biomarkerRows).select('id');
    if (bmErr) return { ok: false, error: bmErr.message };
    biomarkerResultIds = (inserted as Array<{ id: string }> | null)?.map((r) => r.id) ?? [];
  }

  await sb
    .from('partner_health_results')
    .update({
      validation_status: 'valid',
      biomarker_result_ids: biomarkerResultIds,
      processed_at: new Date().toISOString(),
    })
    .eq('id', resultId);

  // ── Flip canonical status: history row first, then the order itself ──
  await recordStatusChange(sb, {
    order,
    to_status: 'result_ready',
    changed_by,
    source_ref,
  });

  // ── Notify + proactive-ORB dedupe marker is left to the (Phase 5)
  //     continuation provider, which reads surfaced_at — never set here ──
  const locale = await getUserLocale(sb, order.user_id);
  notifyUserAsync(
    order.user_id,
    order.tenant_id,
    'health_test_result_ready',
    {
      title: tt('notif.partner_test_result_ready.title', locale),
      body: tt('notif.partner_test_result_ready.body', locale, { test_name: order.test_name, partner_name: order.partner_display_name }),
      data: { order_id: order.id, result_id: resultId, url: '/health' },
    },
    sb
  );

  await emitOasisEvent({
    vtid: 'VTID-03885',
    type: 'health_test.result_ready',
    source: 'partner-health/ingestion',
    status: 'success',
    message: `Partner health result ready for order ${order.id}.`,
    payload: { order_id: order.id, result_id: resultId, partner_key, biomarker_count: biomarkerResultIds.length },
    actor_id: order.user_id,
  });

  return { ok: true, quarantined: false, result_id: resultId, biomarker_result_ids: biomarkerResultIds };
}

/**
 * Intermediate lifecycle status changes (ordered -> sample_kit_shipped ->
 * sample_received -> processing, or cancelled/failed). Never called for
 * result_ready — ingestPartnerResult() drives that transition itself so
 * the status flip and the result write can't drift apart.
 */
export async function recordStatusChange(
  sb: SupabaseClient,
  input: {
    order: PartnerOrderRow;
    to_status: CanonicalHealthTestStatus;
    changed_by: IngestChangedBy;
    source_ref?: string;
    note?: string;
    notify?: boolean; // default: true for anything other than the terminal 'delivered'
  }
): Promise<{ ok: boolean; error?: string }> {
  const { order, to_status, changed_by, source_ref, note } = input;
  const notify = input.notify ?? true;

  const { error: historyErr } = await sb.from('partner_health_test_status_history').insert({
    order_id: order.id,
    from_status: order.status,
    to_status,
    changed_by,
    source_ref: source_ref ?? null,
    note: note ?? null,
  });
  if (historyErr) return { ok: false, error: historyErr.message };

  const { error: updateErr } = await sb
    .from('partner_health_test_orders')
    .update({ status: to_status, status_updated_at: new Date().toISOString() })
    .eq('id', order.id);
  if (updateErr) return { ok: false, error: updateErr.message };

  await emitOasisEvent({
    vtid: 'VTID-03885',
    type: 'health_test.status_changed',
    source: 'partner-health/ingestion',
    status: 'info',
    message: `Partner health test order ${order.id}: ${order.status} -> ${to_status}.`,
    payload: { order_id: order.id, from_status: order.status, to_status, changed_by },
    actor_id: order.user_id,
  });

  // result_ready/delivered get their own dedicated notification copy
  // (result_ready via ingestPartnerResult's own notifyUserAsync call above;
  // delivered is a terminal state nobody needs paged for).
  if (notify && to_status !== 'result_ready' && to_status !== 'delivered') {
    const locale = await getUserLocale(sb, order.user_id);
    notifyUserAsync(
      order.user_id,
      order.tenant_id,
      'partner_test_status_changed',
      {
        title: tt('notif.partner_test_status_changed.title', locale, { partner_name: order.partner_display_name }),
        body: tt('notif.partner_test_status_changed.body', locale, { test_name: order.test_name }),
        data: { order_id: order.id, status: to_status, url: '/health' },
      },
      sb
    );
  }

  return { ok: true };
}
