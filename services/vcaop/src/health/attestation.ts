/**
 * Phase 7 — derived, verifiable health attestations (brief Sec. 11).
 * ⛔ ACTIVATION-GATED (BLK-009) — see consent.ts header.
 *
 * Rules in code (original + 2026-08-09 privacy-review remediations):
 *  - attestations are DERIVED claims (threshold met / not met), never raw
 *    measurements — the attestation object structurally has no field for
 *    metric values, and `raw_data_disclosed` is hardwired false;
 *  - claims compute ONLY from a VerifiedMetricSource; AI-inferred inputs
 *    are refused;
 *  - F1: issuance requires the authenticated GRANTEE as accessor;
 *  - F2: consent is re-checked AFTER the async metric read, immediately
 *    before anything is recorded — a revoke that lands while the read is
 *    in flight wins;
 *  - F3: the service subscribes to the registry's revoke cascade at
 *    construction — revocation alone deletes derived attestations;
 *  - F6 (aggregation defense): periods are whitelisted per claim (coarse
 *    quarters), a minimum sample count is enforced, confidence is a coarse
 *    BAND (never the exact ratio), issuance is idempotent per
 *    (grant, claim, period), and each grant has a hard issuance budget —
 *    an insurer cannot difference fine-grained queries back into the
 *    underlying time series;
 *  - F12: no-data, too-few-samples and unverifiable-provenance all surface
 *    as ONE indistinguishable 'cannot_attest' error, so absence-of-data
 *    metadata does not leak.
 */
import { randomUUID } from 'crypto';
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

export type ConfidenceBand = 'low' | 'medium' | 'high';

export interface HealthAttestation {
  id: string;
  claim: string;
  period: string;
  /** True/false outcome plus a coarse band — never the underlying values,
   * and never the exact met-ratio (F6: the ratio is a reconstruction oracle). */
  met: boolean;
  confidence_band: ConfidenceBand;
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
  /** F6: only coarse period shapes are attestable for this claim. */
  periodPattern: RegExp;
}

const QUARTER = /^\d{4}-Q[1-4]$/;

export const CLAIM_DEFINITIONS: ClaimDefinition[] = [
  { claim: 'weekly_activity_target_met', metric: 'weekly_activity_minutes', threshold: 150, requiredRatio: 0.8, periodPattern: QUARTER },
  { claim: 'sleep_consistency_target_met', metric: 'nightly_sleep_minutes', threshold: 420, requiredRatio: 0.7, periodPattern: QUARTER },
];

/** F6: a window with fewer samples than this is not attestable — a length-1
 * window would make `met` equal the raw comparison for a single sample. */
export const MIN_SAMPLES = 8;
/** F6: hard cap of distinct (claim, period) issuances per grant. */
export const MAX_ISSUANCES_PER_GRANT = 25;

export function confidenceBand(ratio: number): ConfidenceBand {
  if (ratio >= 0.85) return 'high';
  if (ratio >= 0.5) return 'medium';
  return 'low';
}

export class AttestationError extends Error {
  constructor(
    public readonly code: 'unknown_claim' | 'invalid_period' | 'cannot_attest' | 'issuance_budget_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'AttestationError';
  }
}

/** One uniform refusal for every data-shaped reason (F12): the caller cannot
 * distinguish "no device data" from "AI-inferred only" from "too few samples". */
const CANNOT_ATTEST = () => new AttestationError('cannot_attest', 'cannot attest this claim for this period');

export class AttestationService {
  private issued = new Map<string, HealthAttestation[]>(); // by grant id
  private byKey = new Map<string, HealthAttestation>(); // grant|claim|period → idempotent reissue
  // Single-flight per issuance key: two concurrent issue() calls for the same
  // (grant, claim, period) would both pass the byKey/budget checks before the
  // async metrics read and then both append — breaking idempotency, the hard
  // budget, and (DB-backed) the unique constraint. Joiners await the leader.
  private inFlight = new Map<string, Promise<HealthAttestation>>();

  constructor(
    private readonly consents: ConsentRegistry,
    private readonly metrics: VerifiedMetricSource,
    private readonly now: () => Date = () => new Date(),
  ) {
    // F3: revocation cascades automatically — no forgettable second call.
    consents.onRevoke((grantId) => {
      this.deleteForGrant(grantId);
    });
  }

  /**
   * Compute and issue a derived attestation under a consent grant.
   * The consent gate runs FIRST (an unauthorized request never touches
   * metric data), and runs AGAIN after the async read (F2) so a concurrent
   * revoke wins over an in-flight issuance.
   */
  async issue(grantId: string, claim: string, period: string, accessor: string): Promise<HealthAttestation> {
    const grant = this.consents.authorize(grantId, claim, accessor);

    const def = CLAIM_DEFINITIONS.find((d) => d.claim === claim);
    if (!def) throw new AttestationError('unknown_claim', `no claim definition for '${claim}'`);
    if (!def.periodPattern.test(period)) {
      throw new AttestationError('invalid_period', `claim '${claim}' is attestable per quarter (YYYY-Qn) only`);
    }

    // F6: idempotent per (grant, claim, period) — repeating the same question
    // returns the same answer, so repetition yields no new information.
    const key = `${grantId}|${claim}|${period}`;
    const existing = this.byKey.get(key);
    if (existing) {
      this.consents.record(grantId, 'attestation_issued', { accessor, claim, raw_data_disclosed: false, reissued: true });
      return { ...existing };
    }

    // Join an in-flight issuance for the same key instead of racing it. The
    // joiner has already passed authorize() above; it receives the leader's
    // result (or the leader's refusal) and records a reissue receipt.
    const pending = this.inFlight.get(key);
    if (pending) {
      const att = await pending;
      this.consents.record(grantId, 'attestation_issued', { accessor, claim, raw_data_disclosed: false, reissued: true });
      return { ...att };
    }

    const leader = this.issueUncontended(grant.userId, grantId, claim, period, accessor, key, def);
    this.inFlight.set(key, leader);
    try {
      return { ...(await leader) };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async issueUncontended(
    userId: string,
    grantId: string,
    claim: string,
    period: string,
    accessor: string,
    key: string,
    def: (typeof CLAIM_DEFINITIONS)[number],
  ): Promise<HealthAttestation> {
    // F6: hard issuance budget per grant.
    if ((this.issued.get(grantId)?.length ?? 0) >= MAX_ISSUANCES_PER_GRANT) {
      this.consents.record(grantId, 'access_denied', { accessor, claim, reason: 'issuance_budget_exceeded' });
      throw new AttestationError('issuance_budget_exceeded', 'issuance budget for this grant is exhausted');
    }

    const window = await this.metrics.read(userId, def.metric, period);

    // F2: the read yielded the event loop — re-check consent before recording
    // anything. A revoke that landed during the read must win.
    this.consents.authorize(grantId, claim, accessor);

    if (!window || window.values.length < MIN_SAMPLES || window.provenance === 'ai_inferred') {
      // F12: one indistinguishable refusal for every data-shaped reason.
      // (Brief Sec. 11: no insurance action based on an unverifiable AI
      // inference — that case lands here too, deliberately unlabeled.)
      throw CANNOT_ATTEST();
    }

    const meeting = window.values.filter((v) => v >= def.threshold).length;
    const ratio = meeting / window.values.length;
    const attestation: HealthAttestation = {
      id: randomUUID(),
      claim,
      period,
      met: ratio >= def.requiredRatio,
      confidence_band: confidenceBand(ratio),
      issuer: 'Vitanaland',
      consent_grant_id: grantId,
      raw_data_disclosed: false,
      issuedAt: this.now().toISOString(),
    };
    const list = this.issued.get(grantId) ?? [];
    list.push(attestation);
    this.issued.set(grantId, list);
    this.byKey.set(key, attestation);
    this.consents.record(grantId, 'attestation_issued', { accessor, claim, raw_data_disclosed: false });
    return { ...attestation };
  }

  /** Revocation cascade target: delete every derived attestation under the grant. */
  deleteForGrant(grantId: string): number {
    const count = this.issued.get(grantId)?.length ?? 0;
    for (const key of this.byKey.keys()) {
      if (key.startsWith(`${grantId}|`)) this.byKey.delete(key);
    }
    this.issued.delete(grantId);
    return count;
  }

  listForGrant(grantId: string): HealthAttestation[] {
    return (this.issued.get(grantId) ?? []).map((a) => ({ ...a }));
  }
}
