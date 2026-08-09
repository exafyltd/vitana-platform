/**
 * Phase 7 — purpose-bound consent grants + immutable receipts (brief Sec. 11).
 *
 * ⛔ DORMANT BY GOVERNANCE: this module is a library layer only. It is
 * deliberately NOT exposed through the public MCP surface or any route, and
 * must not be until the independent privacy/consent review passes (BLK-009).
 * Building it dark lets the review examine real controls instead of a spec.
 *
 * Rules enforced in code:
 *  - a grant names ONE grantee, ONE purpose, explicit attestation claims,
 *    and a validity window — nothing open-ended;
 *  - consent is granted by the USER (approve() requires the grant owner);
 *  - receipts are immutable append-only records of grant/revoke/access;
 *  - revocation is immediate and cascades: derived attestations under the
 *    grant are deleted, further access refused;
 *  - every access is audited; no raw health values ever appear in receipts,
 *    audit entries, or errors.
 */

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

export interface ConsentReceipt {
  id: string;
  grantId: string;
  kind: 'granted' | 'revoked' | 'attestation_issued' | 'access_denied';
  at: string;
  /** Metadata only — claim names, grantee, purpose. NEVER metric values. */
  detail: Record<string, string | number | boolean>;
}

export class ConsentError extends Error {
  constructor(
    public readonly code:
      | 'not_owner'
      | 'not_active'
      | 'expired'
      | 'revoked'
      | 'claim_not_permitted'
      | 'invalid_grant',
    message: string,
  ) {
    super(message);
    this.name = 'ConsentError';
  }
}

export class ConsentRegistry {
  private grants = new Map<string, ConsentGrant>();
  private receipts: ConsentReceipt[] = [];
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private receipt(grantId: string, kind: ConsentReceipt['kind'], detail: ConsentReceipt['detail']): void {
    this.receipts.push({ id: `crcpt-${++this.seq}`, grantId, kind, at: this.now().toISOString(), detail });
  }

  /** An insurer PROPOSES a grant; nothing is shared at this stage. */
  propose(input: ConsentGrantInput): ConsentGrant {
    if (!input.grantee || !input.purpose || input.permittedClaims.length === 0) {
      throw new ConsentError('invalid_grant', 'grantee, purpose and at least one permitted claim are required');
    }
    if (Date.parse(input.validTo) <= Date.parse(input.validFrom)) {
      throw new ConsentError('invalid_grant', 'validity window is empty');
    }
    const grant: ConsentGrant = { ...input, id: `grant-${++this.seq}`, status: 'proposed' };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /** Only the grant's OWNER can consent. This is the user's decision alone. */
  approve(grantId: string, byUserId: string): ConsentGrant {
    const grant = this.mustGet(grantId);
    if (grant.userId !== byUserId) throw new ConsentError('not_owner', 'only the data subject can approve a grant');
    grant.status = 'active';
    this.receipt(grant.id, 'granted', {
      grantee: grant.grantee,
      purpose: grant.purpose,
      claims: grant.permittedClaims.join(','),
      valid_to: grant.validTo,
      reward_minor_units: grant.rewardMinorUnits,
    });
    return grant;
  }

  /** Immediate, owner-only, friction-free. */
  revoke(grantId: string, byUserId: string): ConsentGrant {
    const grant = this.mustGet(grantId);
    if (grant.userId !== byUserId) throw new ConsentError('not_owner', 'only the data subject can revoke a grant');
    grant.status = 'revoked';
    this.receipt(grant.id, 'revoked', { grantee: grant.grantee, purpose: grant.purpose });
    return grant;
  }

  /**
   * The single authorization check every attestation access must pass:
   * active, in-window, owned, and the claim explicitly permitted.
   * Denials are receipted too — an audit that only records successes is
   * not an audit.
   */
  authorize(grantId: string, claim: string): ConsentGrant {
    const grant = this.mustGet(grantId);
    const deny = (code: ConsentError['code'], msg: string): never => {
      this.receipt(grant.id, 'access_denied', { claim, reason: code });
      throw new ConsentError(code, msg);
    };
    if (grant.status === 'revoked') deny('revoked', 'grant revoked');
    if (grant.status !== 'active') deny('not_active', `grant is ${grant.status}`);
    const t = this.now().getTime();
    if (t < Date.parse(grant.validFrom) || t > Date.parse(grant.validTo)) {
      grant.status = 'expired';
      deny('expired', 'grant outside its validity window');
    }
    if (!grant.permittedClaims.includes(claim)) {
      deny('claim_not_permitted', `claim '${claim}' is not covered by this grant`);
    }
    return grant;
  }

  recordAttestationIssued(grantId: string, claim: string): void {
    this.receipt(grantId, 'attestation_issued', { claim, raw_data_disclosed: false });
  }

  get(grantId: string): ConsentGrant | null {
    return this.grants.get(grantId) ?? null;
  }

  /** Immutable copies — a caller cannot edit history through the return value. */
  listReceipts(grantId?: string): ConsentReceipt[] {
    const all = grantId ? this.receipts.filter((r) => r.grantId === grantId) : this.receipts;
    return all.map((r) => ({ ...r, detail: { ...r.detail } }));
  }

  private mustGet(grantId: string): ConsentGrant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new ConsentError('invalid_grant', `unknown grant ${grantId}`);
    return grant;
  }
}
