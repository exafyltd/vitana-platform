/**
 * VTID-03885 — Partner Health Test Integration: shared types.
 *
 * Canonical status vocabulary. Every partner speaks its own terminology;
 * the adapter's job is translating that into ONE of these values before
 * anything else in Vitana (ORB, notifications, the portal UI) ever sees a
 * status. AI/ORB must never reason from a raw partner status string.
 */
export type CanonicalHealthTestStatus =
  | 'ordered'
  | 'sample_kit_shipped'
  | 'sample_received'
  | 'processing'
  | 'result_ready'
  | 'delivered'
  | 'cancelled'
  | 'failed'
  | 'quarantined';

export interface PartnerOrderRef {
  partner_key: string;
  external_order_ref: string;
}

export interface PartnerOrderStatus {
  external_order_ref: string;
  external_sample_ref?: string | null;
  status: CanonicalHealthTestStatus;
  status_source_label?: string; // the partner's own raw label, for provenance/debugging only — never surfaced to the AI as-is
  updated_at: string;
}

export interface PartnerResultPayload {
  external_order_ref: string;
  external_sample_ref?: string | null;
  result_date?: string | null;
  biomarkers: Array<{
    code?: string | null;
    name: string;
    value: number;
    unit: string;
    ref_range_low?: number | null;
    ref_range_high?: number | null;
  }>;
  raw_file_ref?: string | null;
  raw: Record<string, unknown>;
}

export interface PartnerResultValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * PartnerHealthTestAdapter — one implementation per partner. DoctorBox is
 * Partner #001; the interface itself carries no DoctorBox-specific logic.
 * A real implementation may throw `PartnerCapabilityUnavailableError` for
 * any operation the partner doesn't actually support yet (see
 * partner_registry.capabilities) — callers must handle that explicitly,
 * never silently swallow it.
 */
export interface PartnerHealthTestAdapter {
  readonly partnerKey: string;

  createOrder(input: { user_id: string; tenant_id: string; test_sku: string }): Promise<PartnerOrderRef>;
  getOrderStatus(ref: PartnerOrderRef): Promise<PartnerOrderStatus>;
  getTestStatus(ref: PartnerOrderRef): Promise<PartnerOrderStatus>;
  receiveResult(rawPayload: Record<string, unknown>): Promise<PartnerResultPayload>;
  validateResult(payload: PartnerResultPayload): PartnerResultValidationResult;
}

export class PartnerCapabilityUnavailableError extends Error {
  constructor(partnerKey: string, capability: string) {
    super(`${partnerKey} does not support ${capability} yet — see partner_registry.capabilities.`);
    this.name = 'PartnerCapabilityUnavailableError';
  }
}
