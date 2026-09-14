/**
 * VTID-03885 — DoctorBox connector (Partner Health Test Integration, Partner #001).
 *
 * DoctorBox has no real webhook today (sandbox/mock only — see the
 * migration + plan header for the confirmed "no order-read API" finding).
 * This connector proves the framework end-to-end against a documented mock
 * payload shape + sandbox HMAC secret; nothing here points at a real
 * DoctorBox endpoint.
 *
 * Unlike terra.ts/vital.ts, this is `auth_type: 'webhook_only'` with no
 * OAuth/user_connections row backing it — DoctorBox purchases happen
 * entirely off-platform (Shopify Collabs affiliate links), so there is no
 * connect flow that would ever populate one. Identity is instead resolved
 * against `partner_health_test_orders.external_order_ref`, set by an admin
 * when they manually create the order via the (Phase 3) portal after
 * DoctorBox tells them about it out-of-band — this connector's whole job
 * is turning a later webhook into a status/result update against an
 * order that ALREADY EXISTS. An order this connector cannot find is
 * evidence of nothing more than "no admin has entered it yet" and is
 * quarantined (`reason: 'no_match'`), never guessed.
 *
 * Mock webhook payload shape (documented here since there is no real spec
 * to link to):
 *   {
 *     "event": "test.status_changed" | "test.result_ready",
 *     "external_order_ref": "DB-12345",
 *     "status": "shipped" | "received" | "in_lab" | "done",   // only for status_changed
 *     "result": { "result_date": "...", "biomarkers": [...] }  // only for result_ready
 *   }
 *
 * Env: DOCTORBOX_WEBHOOK_SECRET — HMAC-SHA256 over the raw body, header
 * `x-doctorbox-signature` (hex digest, no prefix — simpler than Terra's
 * timestamped `t=...,v1=...` scheme since there is no real spec to match).
 * Unset secret = dev mode (matches terra.ts's own documented behaviour).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { Connector, NormalizedEvent, WebhookRequest } from '../types';
import { getSupabase } from '../../lib/supabase';
import doctorBoxAdapter from '../../services/partner-health/doctorbox-adapter';
import {
  ingestPartnerResult,
  recordStatusChange,
  quarantineUnmatchedResult,
  type PartnerOrderRow,
} from '../../services/partner-health/ingestion';
import type { CanonicalHealthTestStatus } from '../../services/partner-health/types';

const PARTNER_KEY = 'doctorbox';

function verifyDoctorBoxSignature(raw_body: string, signature_header: string | undefined): boolean {
  const secret = process.env.DOCTORBOX_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[doctorbox] DOCTORBOX_WEBHOOK_SECRET not set — skipping signature verification (dev mode)');
    return true;
  }
  if (!signature_header) return false;
  const computed = createHmac('sha256', secret).update(raw_body).digest('hex');
  if (computed.length !== signature_header.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(signature_header));
}

/** DoctorBox's own raw status labels -> the canonical vocabulary. Unknown labels fail loudly rather than guessing. */
const STATUS_MAP: Record<string, CanonicalHealthTestStatus> = {
  shipped: 'sample_kit_shipped',
  received: 'sample_received',
  in_lab: 'processing',
  done: 'delivered',
  cancelled: 'cancelled',
  failed: 'failed',
};

interface DoctorBoxWebhookPayload {
  event?: string;
  external_order_ref?: string;
  status?: string;
  result?: Record<string, unknown>;
  [key: string]: unknown;
}

const doctorBoxConnector: Connector = {
  id: 'doctorbox',
  category: 'health_lab',
  display_name: 'DoctorBox',
  auth_type: 'webhook_only',
  capabilities: ['lab_test.status.read', 'lab_test.result.read'],

  async initialize(): Promise<void> {
    console.log('[doctorbox] connector present (sandbox/mock — no live DoctorBox API exists yet)');
  },

  async handleWebhook(req: WebhookRequest): Promise<{ valid: boolean; events: NormalizedEvent[]; error?: string }> {
    const raw_body = typeof req.body === 'string'
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : JSON.stringify(req.body);

    const sig_header = req.headers['x-doctorbox-signature'];
    const sigStr = Array.isArray(sig_header) ? sig_header[0] : sig_header;
    if (!verifyDoctorBoxSignature(raw_body, sigStr)) {
      return { valid: false, events: [], error: 'signature_invalid' };
    }

    let payload: DoctorBoxWebhookPayload;
    try {
      payload = typeof req.body === 'string' || Buffer.isBuffer(req.body)
        ? (JSON.parse(raw_body) as DoctorBoxWebhookPayload)
        : (req.body as DoctorBoxWebhookPayload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, events: [], error: `invalid_json: ${message}` };
    }

    const sb = getSupabase();
    if (!sb) return { valid: false, events: [], error: 'supabase_unavailable' };

    const externalOrderRef = String(payload.external_order_ref ?? '').trim();
    if (!externalOrderRef) {
      return { valid: false, events: [], error: 'missing_external_order_ref' };
    }

    const { data: partner } = await sb
      .from('partner_registry')
      .select('id')
      .eq('partner_key', PARTNER_KEY)
      .maybeSingle();
    const partnerId = (partner as { id: string } | null)?.id;
    if (!partnerId) {
      return { valid: false, events: [], error: 'partner_not_registered' };
    }

    const { data: orderRow } = await sb
      .from('partner_health_test_orders')
      .select('id, tenant_id, user_id, partner_id, status, test_name')
      .eq('partner_id', partnerId)
      .eq('external_order_ref', externalOrderRef)
      .maybeSingle();

    if (!orderRow) {
      // No admin has entered this order yet — quarantine, never guess a user.
      await quarantineUnmatchedResult(sb, partnerId, payload as Record<string, unknown>, [], 'no_match');
      return {
        valid: true,
        events: [{ topic: 'connector.health_lab.doctorbox.unmatched', provider: PARTNER_KEY, payload: { external_order_ref: externalOrderRef }, raw: payload }],
      };
    }

    const order: PartnerOrderRow = {
      id: (orderRow as { id: string }).id,
      tenant_id: (orderRow as { tenant_id: string }).tenant_id,
      user_id: (orderRow as { user_id: string }).user_id,
      partner_id: partnerId,
      partner_display_name: 'DoctorBox',
      status: (orderRow as { status: CanonicalHealthTestStatus }).status,
      test_name: (orderRow as { test_name: string }).test_name,
    };

    const event = String(payload.event ?? '').trim();

    if (event === 'test.status_changed') {
      const rawStatus = String(payload.status ?? '').trim().toLowerCase();
      const canonical = STATUS_MAP[rawStatus];
      if (!canonical) {
        return { valid: false, events: [], error: `unmapped_status: ${rawStatus}` };
      }
      const outcome = await recordStatusChange(sb, {
        order,
        to_status: canonical,
        changed_by: 'partner_webhook',
        source_ref: rawStatus,
      });
      if (!outcome.ok) return { valid: false, events: [], error: outcome.error };
      return {
        valid: true,
        events: [{ topic: 'connector.health_lab.doctorbox.status_changed', provider: PARTNER_KEY, payload: { order_id: order.id, to_status: canonical }, raw: payload }],
      };
    }

    if (event === 'test.result_ready') {
      const resultPayload = await doctorBoxAdapter.receiveResult(payload.result ?? {});
      const outcome = await ingestPartnerResult(sb, {
        order,
        partner_key: PARTNER_KEY,
        received_via: 'webhook',
        payload: resultPayload,
        validate: doctorBoxAdapter.validateResult,
        changed_by: 'partner_webhook',
        source_ref: externalOrderRef,
      });
      if (!outcome.ok) return { valid: false, events: [], error: outcome.error };
      return {
        valid: true,
        events: [{
          topic: outcome.quarantined ? 'connector.health_lab.doctorbox.result_quarantined' : 'connector.health_lab.doctorbox.result_ready',
          provider: PARTNER_KEY,
          payload: { order_id: order.id },
          raw: payload,
        }],
      };
    }

    return { valid: false, events: [], error: `unknown_event: ${event}` };
  },
};

export default doctorBoxConnector;
