/**
 * Phase 7 — derived, verifiable health attestations (brief Sec. 11).
 * ⛔ DORMANT BY GOVERNANCE — see consent.ts header; not exposed anywhere
 * until BLK-009's independent privacy review passes.
 *
 * Rules in code:
 *  - attestations are DERIVED claims (threshold met / not met), never raw
 *    measurements — the attestation object structurally has no field for
 *    metric values, and `raw_data_disclosed` is hardwired false;
 *  - claims compute ONLY from a VerifiedMetricSource (device/health-store
 *    data with provenance). AI-inferred inputs are refused by type: the
 *    source declares its provenance and 'ai_inferred' is rejected — no
 *    insurance action on an unverifiable inference;
 *  - every issuance passes the consent authorize() gate and is receipted;
 *  - revocation deletes the derived attestations issued under the grant.
 */
import { ConsentRegistry } from './consent';

export interface VerifiedMetricWindow {
  /** e.g. 'weekly_activity_minutes' */
  metric: string;
  period: string; // e.g. '2026-Q2'
  /** Where the numbers came from — the verifiability anchor. */
  provenance: 'device_measured' | 'user_entered_verified' | 'ai_inferred';
  values: number[];
}

export interface VerifiedMetricSource {
  read(userId: string, metric: string, period: string): Promise<VerifiedMetricWindow | null>;
}

export interface HealthAttestation {
  id: string;
  claim: string;
  period: string;
  /** True/false outcome plus a confidence — never the underlying values. */
  met: boolean;
  confidence: number;
  issuer: 'Vitanaland';
  consent_grant_id: string;
  raw_data_disclosed: false;
  issuedAt: string;
}

/** Claim definitions: which metric, which period semantics, which threshold. */
export interface ClaimDefinition {
  claim: string;
  metric: string;
  /** Minimum per-window value counting as "met" for a sample. */
  threshold: number;
  /** Fraction of samples that must meet the threshold. */
  requiredRatio: number;
}

export const CLAIM_DEFINITIONS: ClaimDefinition[] = [
  { claim: 'weekly_activity_target_met', metric: 'weekly_activity_minutes', threshold: 150, requiredRatio: 0.8 },
  { claim: 'sleep_consistency_target_met', metric: 'nightly_sleep_minutes', threshold: 420, requiredRatio: 0.7 },
];

export class AttestationError extends Error {
  constructor(
    public readonly code: 'unknown_claim' | 'no_verified_data' | 'unverifiable_provenance',
    message: string,
  ) {
    super(message);
    this.name = 'AttestationError';
  }
}

export class AttestationService {
  private issued = new Map<string, HealthAttestation[]>(); // by grant id
  private seq = 0;

  constructor(
    private readonly consents: ConsentRegistry,
    private readonly metrics: VerifiedMetricSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Compute and issue a derived attestation under a consent grant.
   * The consent gate runs FIRST — an unauthorized request never touches
   * metric data at all.
   */
  async issue(grantId: string, claim: string, period: string): Promise<HealthAttestation> {
    const grant = this.consents.authorize(grantId, claim);

    const def = CLAIM_DEFINITIONS.find((d) => d.claim === claim);
    if (!def) throw new AttestationError('unknown_claim', `no claim definition for '${claim}'`);

    const window = await this.metrics.read(grant.userId, def.metric, period);
    if (!window || window.values.length === 0) {
      throw new AttestationError('no_verified_data', `no verified data for ${def.metric} in ${period}`);
    }
    if (window.provenance === 'ai_inferred') {
      // Brief Sec. 11: no insurance action based on an unverifiable AI inference.
      throw new AttestationError('unverifiable_provenance', 'AI-inferred metrics cannot back an attestation');
    }

    const meeting = window.values.filter((v) => v >= def.threshold).length;
    const ratio = meeting / window.values.length;
    const attestation: HealthAttestation = {
      id: `att-${++this.seq}`,
      claim,
      period,
      met: ratio >= def.requiredRatio,
      confidence: Math.round(ratio * 100) / 100,
      issuer: 'Vitanaland',
      consent_grant_id: grantId,
      raw_data_disclosed: false,
      issuedAt: this.now().toISOString(),
    };
    const list = this.issued.get(grantId) ?? [];
    list.push(attestation);
    this.issued.set(grantId, list);
    this.consents.recordAttestationIssued(grantId, claim);
    return attestation;
  }

  /** Revocation cascade: delete every derived attestation under the grant. */
  deleteForGrant(grantId: string): number {
    const count = this.issued.get(grantId)?.length ?? 0;
    this.issued.delete(grantId);
    return count;
  }

  listForGrant(grantId: string): HealthAttestation[] {
    return [...(this.issued.get(grantId) ?? [])];
  }
}
