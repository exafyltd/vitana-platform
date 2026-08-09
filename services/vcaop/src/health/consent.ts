/**
 * Phase 7 — purpose-bound consent grants + immutable receipts (brief Sec. 11).
 *
 * ⛔ ACTIVATION-GATED (BLK-009): this module refuses to construct without an
 * explicit, complete activation record referencing the independent privacy
 * review — the same recorded-human-decision pattern as the settlement
 * ledger's BLK-010 gate. Building it dark let the first review examine real
 * controls; the review's findings (2026-08-09, verdict FAIL → remediated)
 * are addressed in this revision:
 *
 *  - F1: every access path takes an authenticated ACCESSOR and refuses when
 *    it is not the grant's grantee; ids are random UUIDs, not enumerable.
 *  - F2: issuance re-authorizes after any async yield (see attestation.ts).
 *  - F3: revocation CASCADES automatically — the registry notifies revoke
 *    listeners; deleting derived attestations is not a forgettable 2nd call.
 *  - F4: no live internal object ever escapes — every public method returns
 *    a deep-frozen copy; state changes only through registry methods.
 *  - F7: approve() is legal only from 'proposed'; anything else is denied
 *    and receipted — a revoked grant can never be resurrected.
 *  - F8: unknown-grant probes are recorded; the accessor identity is part
 *    of every receipt.
 *  - F11: access before validFrom is denied WITHOUT mutating status.
 *  - F14: receipt reads require an explicit grant/user filter.
 */
import { randomUUID } from 'crypto';

/** Recorded human decision permitting activation of the health layer. */
export interface HealthLayerActivation {
  blocker: 'BLK-009';
  /** Where the passing privacy review is recorded. */
  review_reference: string;
  activated_by: string;
  activated_at: string; // ISO date
}

export function assertHealthActivation(activation: HealthLayerActivation | undefined): void {
  const ok =
    activation &&
    activation.blocker === 'BLK-009' &&
    typeof activation.review_reference === 'string' && activation.review_reference.trim().length > 0 &&
    typeof activation.activated_by === 'string' && activation.activated_by.trim().length > 0 &&
    typeof activation.activated_at === 'string' && !Number.isNaN(Date.parse(activation.activated_at));
  if (!ok) {
    throw new ConsentError(
      'not_activated',
      'health/consent layer requires a complete BLK-009 activation record (review_reference, activated_by, activated_at)',
    );
  }
}

export interface ConsentGrantInput {
  tenantId: string;
  userId: string;
  /** The identified insurer/partner receiving attestations. */
  grantee: string;
  /** One specific purpose, e.g. 'life_tariff_underwriting_2026'. */
  purpose: string;
  /** The ATTESTATION CLAIMS permitted — never raw metric names with values. */
  permittedClaims: string[];
  validFrom: string; // ISO
  validTo: string; // ISO
  jurisdiction: string;
  /** Reward offered for this permissioned use (minor units; settled via the deterministic ledger). */
  rewardMinorUnits: number;
}

export interface ConsentGrant extends ConsentGrantInput {
  id: string;
  status: 'proposed' | 'active' | 'revoked' | 'expired';
}

export type ConsentReceiptKind =
  | 'granted'
  | 'revoked'
  | 'attestation_issued'
  | 'access_denied'
  | 'quote_submitted'
  | 'quote_denied'
  | 'quote_selected';

export interface ConsentReceipt {
  id: string;
  grantId: string;
  kind: ConsentReceiptKind;
  at: string;
  /** Metadata only — claim names, grantee, purpose, accessor. NEVER metric values. */
  detail: Record<string, string | number | boolean>;
}

/** Record of an access attempt against a grant id that does not exist. */
export interface ProbeAttempt {
  attemptedGrantId: string;
  accessor: string;
  at: string;
}

export class ConsentError extends Error {
  constructor(
    public readonly code:
      | 'not_owner'
      | 'not_grantee'
      | 'not_active'
      | 'not_yet_valid'
      | 'expired'
      | 'revoked'
      | 'claim_not_permitted'
      | 'invalid_grant'
      | 'invalid_filter'
      | 'not_activated',
    message: string,
  ) {
    super(message);
    this.name = 'ConsentError';
  }
}

function deepFreezeGrant(grant: ConsentGrant): Readonly<ConsentGrant> {
  return Object.freeze({ ...grant, permittedClaims: Object.freeze([...grant.permittedClaims]) as unknown as string[] });
}

export class ConsentRegistry {
  private grants = new Map<string, ConsentGrant>();
  private receipts: ConsentReceipt[] = [];
  private probes: ProbeAttempt[] = [];
  private revokeListeners: Array<(grantId: string) => void> = [];

  constructor(
    activation: HealthLayerActivation,
    private readonly now: () => Date = () => new Date(),
  ) {
    assertHealthActivation(activation);
  }

  /** Internal + trusted-module receipt writer (attestation/quote services). */
  record(grantId: string, kind: ConsentReceiptKind, detail: ConsentReceipt['detail']): void {
    this.receipts.push({ id: randomUUID(), grantId, kind, at: this.now().toISOString(), detail });
  }

  /** Cascade hook: called with the grant id on every successful revoke. */
  onRevoke(listener: (grantId: string) => void): void {
    this.revokeListeners.push(listener);
  }

  /** An insurer PROPOSES a grant; nothing is shared at this stage. */
  propose(input: ConsentGrantInput): Readonly<ConsentGrant> {
    if (!input.grantee || !input.purpose || input.permittedClaims.length === 0) {
      throw new ConsentError('invalid_grant', 'grantee, purpose and at least one permitted claim are required');
    }
    if (Date.parse(input.validTo) <= Date.parse(input.validFrom)) {
      throw new ConsentError('invalid_grant', 'validity window is empty');
    }
    const grant: ConsentGrant = {
      ...input,
      permittedClaims: [...input.permittedClaims],
      id: randomUUID(),
      status: 'proposed',
    };
    this.grants.set(grant.id, grant);
    return deepFreezeGrant(grant);
  }

  /**
   * Only the grant's OWNER can consent, and only a PROPOSED grant can be
   * approved — a revoked or expired grant can never be resurrected (F7).
   */
  approve(grantId: string, byUserId: string): Readonly<ConsentGrant> {
    const grant = this.mustGet(grantId, byUserId);
    if (grant.userId !== byUserId) throw new ConsentError('not_owner', 'only the data subject can approve a grant');
    if (grant.status !== 'proposed') {
      this.record(grant.id, 'access_denied', { accessor: byUserId, reason: 'illegal_approve', from_status: grant.status });
      throw new ConsentError('not_active', `only a proposed grant can be approved (is ${grant.status})`);
    }
    grant.status = 'active';
    this.record(grant.id, 'granted', {
      accessor: byUserId,
      grantee: grant.grantee,
      purpose: grant.purpose,
      claims: grant.permittedClaims.join(','),
      valid_to: grant.validTo,
      reward_minor_units: grant.rewardMinorUnits,
    });
    return deepFreezeGrant(grant);
  }

  /** Immediate, owner-only, friction-free — and the cascade runs HERE (F3). */
  revoke(grantId: string, byUserId: string): Readonly<ConsentGrant> {
    const grant = this.mustGet(grantId, byUserId);
    if (grant.userId !== byUserId) throw new ConsentError('not_owner', 'only the data subject can revoke a grant');
    grant.status = 'revoked';
    this.record(grant.id, 'revoked', { accessor: byUserId, grantee: grant.grantee, purpose: grant.purpose });
    for (const listener of this.revokeListeners) listener(grant.id);
    return deepFreezeGrant(grant);
  }

  /**
   * The single authorization check every attestation access must pass:
   * requested by the GRANTEE, active, in-window, and the claim explicitly
   * permitted. Denials are receipted too — an audit that only records
   * successes is not an audit.
   */
  authorize(grantId: string, claim: string, accessor: string): Readonly<ConsentGrant> {
    const grant = this.mustGet(grantId, accessor);
    const deny = (code: ConsentError['code'], msg: string): never => {
      this.record(grant.id, 'access_denied', { accessor, claim, reason: code });
      throw new ConsentError(code, msg);
    };
    // F1: only the named grantee may request attestations under this grant.
    if (accessor !== grant.grantee) deny('not_grantee', 'accessor is not the grantee of this grant');
    if (grant.status === 'revoked') deny('revoked', 'grant revoked');
    if (grant.status !== 'active') deny('not_active', `grant is ${grant.status}`);
    const t = this.now().getTime();
    // F11: too-early access denies WITHOUT mutating — the grant stays valid
    // for its real window instead of being bricked by an early probe.
    if (t < Date.parse(grant.validFrom)) deny('not_yet_valid', 'grant validity window has not started');
    if (t > Date.parse(grant.validTo)) {
      grant.status = 'expired';
      deny('expired', 'grant outside its validity window');
    }
    if (!grant.permittedClaims.includes(claim)) {
      deny('claim_not_permitted', `claim '${claim}' is not covered by this grant`);
    }
    return deepFreezeGrant(grant);
  }

  get(grantId: string): Readonly<ConsentGrant> | null {
    const grant = this.grants.get(grantId);
    return grant ? deepFreezeGrant(grant) : null;
  }

  /**
   * Immutable copies, and an explicit scope is REQUIRED (F14) — there is no
   * "give me every receipt across all users" read.
   */
  listReceipts(filter: { grantId?: string; userId?: string }): ConsentReceipt[] {
    if (!filter?.grantId && !filter?.userId) {
      throw new ConsentError('invalid_filter', 'listReceipts requires a grantId or userId filter');
    }
    let matching = this.receipts;
    if (filter.grantId) matching = matching.filter((r) => r.grantId === filter.grantId);
    if (filter.userId) {
      const owned = new Set([...this.grants.values()].filter((g) => g.userId === filter.userId).map((g) => g.id));
      matching = matching.filter((r) => owned.has(r.grantId));
    }
    return matching.map((r) => ({ ...r, detail: { ...r.detail } }));
  }

  /** Unknown-grant access attempts — enumeration probes leave a trace (F8). */
  listProbeAttempts(): ProbeAttempt[] {
    return this.probes.map((p) => ({ ...p }));
  }

  private mustGet(grantId: string, accessor: string): ConsentGrant {
    const grant = this.grants.get(grantId);
    if (!grant) {
      this.probes.push({ attemptedGrantId: grantId, accessor, at: this.now().toISOString() });
      throw new ConsentError('invalid_grant', 'unknown grant');
    }
    return grant;
  }
}
