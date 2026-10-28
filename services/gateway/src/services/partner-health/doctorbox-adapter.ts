/**
 * VTID-03885 — Partner Health Test Integration: DoctorBox adapter (Partner #001).
 *
 * DoctorBox has NO programmatic order/result API today (confirmed: their
 * storefront blocks automated fetching, no Shopify Admin API grant — see
 * the migration/plan header for the full finding). This adapter is
 * deliberately a mock/sandbox implementation that proves the
 * PartnerHealthTestAdapter interface is real and reusable for a future
 * partner that DOES have a live API from day one — createOrder/
 * getOrderStatus/getTestStatus correctly refuse (never silently no-op)
 * until DoctorBox capabilities in partner_registry actually flip to true.
 *
 * receiveResult()/validateResult() ARE real today — they're the shape a
 * webhook delivery or a portal manual-upload both need, regardless of
 * whether the order/status side of the API ever arrives.
 */

import {
  PartnerCapabilityUnavailableError,
  type PartnerHealthTestAdapter,
  type PartnerOrderRef,
  type PartnerOrderStatus,
  type PartnerResultPayload,
  type PartnerResultValidationResult,
} from './types';

const PARTNER_KEY = 'doctorbox';

/** Raw shape DoctorBox would send in a webhook/export — see doctorbox.ts connector for the documented mock payload. */
export interface DoctorBoxRawResult {
  external_order_ref: string;
  external_sample_ref?: string;
  result_date?: string;
  biomarkers?: Array<{ code?: string; name?: string; value?: number | string; unit?: string; ref_low?: number; ref_high?: number }>;
  [key: string]: unknown;
}

export const doctorBoxAdapter: PartnerHealthTestAdapter = {
  partnerKey: PARTNER_KEY,

  async createOrder(_input: { user_id: string; tenant_id: string; test_sku: string }): Promise<PartnerOrderRef> {
    throw new PartnerCapabilityUnavailableError(PARTNER_KEY, 'has_order_api');
  },

  async getOrderStatus(_ref: PartnerOrderRef): Promise<PartnerOrderStatus> {
    throw new PartnerCapabilityUnavailableError(PARTNER_KEY, 'has_result_api');
  },

  async getTestStatus(_ref: PartnerOrderRef): Promise<PartnerOrderStatus> {
    throw new PartnerCapabilityUnavailableError(PARTNER_KEY, 'has_result_api');
  },

  async receiveResult(rawPayload: Record<string, unknown>): Promise<PartnerResultPayload> {
    const raw = rawPayload as DoctorBoxRawResult;
    const biomarkers = Array.isArray(raw.biomarkers)
      ? raw.biomarkers.map((b) => ({
          code: b.code ?? null,
          name: String(b.name ?? '').trim(),
          value: typeof b.value === 'number' ? b.value : Number(b.value),
          unit: String(b.unit ?? '').trim(),
          ref_range_low: typeof b.ref_low === 'number' ? b.ref_low : null,
          ref_range_high: typeof b.ref_high === 'number' ? b.ref_high : null,
        }))
      : [];

    return {
      external_order_ref: String(raw.external_order_ref ?? ''),
      external_sample_ref: raw.external_sample_ref ?? null,
      result_date: raw.result_date ?? null,
      biomarkers,
      raw: rawPayload,
    };
  },

  validateResult(payload: PartnerResultPayload): PartnerResultValidationResult {
    const errors: string[] = [];
    if (!payload.external_order_ref) errors.push('missing external_order_ref');
    if (!Array.isArray(payload.biomarkers) || payload.biomarkers.length === 0) {
      errors.push('no biomarkers in result payload');
    } else {
      payload.biomarkers.forEach((b, i) => {
        if (!b.name) errors.push(`biomarker[${i}] missing name`);
        if (typeof b.value !== 'number' || !Number.isFinite(b.value)) errors.push(`biomarker[${i}] (${b.name ?? '?'}) has a non-numeric value`);
        if (!b.unit) errors.push(`biomarker[${i}] (${b.name ?? '?'}) missing unit`);
      });
    }
    return { valid: errors.length === 0, errors };
  },
};

export default doctorBoxAdapter;
