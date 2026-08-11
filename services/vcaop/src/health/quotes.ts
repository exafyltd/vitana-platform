/**
 * Phase 7 — insurer quote exchange over attestations (brief Sec. 11 flow).
 * ⛔ ACTIVATION-GATED (BLK-009) — see consent.ts header.
 *
 * The insurer sees ATTESTATIONS, never metrics. Policy creation is a VCAOP
 * transaction (deterministic, human-gated where irreversible); the user
 * reward + platform fee settle through the deterministic ledger — an LLM
 * never computes either.
 *
 * 2026-08-09 privacy-review remediations:
 *  - F5: quotes cite attestations BY ID, resolved from the issuing
 *    AttestationService — a caller-constructed attestation object is
 *    unrepresentable, and every cited claim is re-checked against the
 *    grant's permittedClaims;
 *  - F8: quote submission, denial, and selection are all receipted with the
 *    accessor identity.
 */
import { randomUUID } from 'crypto';
import { AttestationService } from './attestation';
import { ConsentRegistry } from './consent';
import { SettlementInstruction, SettlementLedger, SettlementReceipt } from '../settlement/ledger';

export interface InsuranceQuote {
  id: string;
  grantId: string;
  insurer: string;
  product: string;
  /** Monthly premium in minor units, as tariffed by the INSURER. */
  premiumMinorUnits: number;
  discountBps: number;
  basedOnClaims: string[];
  expiresAt: string;
}

export class QuoteError extends Error {
  constructor(
    public readonly code:
      | 'grant_not_active'
      | 'not_grantee'
      | 'unknown_attestation'
      | 'claim_not_permitted'
      | 'unknown_quote'
      | 'quote_expired'
      | 'not_owner',
    message: string,
  ) {
    super(message);
    this.name = 'QuoteError';
  }
}

export class QuoteExchange {
  private quotes = new Map<string, InsuranceQuote>();

  constructor(
    private readonly consents: ConsentRegistry,
    private readonly attestations: AttestationService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Record an insurer's quote. Attestations are cited BY ID and resolved
   * from the issuing service (F5) — the exchange never trusts an
   * insurer-supplied attestation object, and re-checks every cited claim
   * against the grant.
   */
  submitQuote(input: {
    grantId: string;
    insurer: string;
    product: string;
    premiumMinorUnits: number;
    discountBps: number;
    attestationIds: string[];
    validDays?: number;
  }): InsuranceQuote {
    const grant = this.consents.get(input.grantId);
    const deny = (code: QuoteError['code'], msg: string): never => {
      this.consents.record(input.grantId, 'quote_denied', { accessor: input.insurer, reason: code });
      throw new QuoteError(code, msg);
    };
    if (!grant) {
      // N2: an unknown grant id on the quote surface is an enumeration probe
      // — trace it exactly like the consent surface does.
      this.consents.noteProbe(input.grantId, input.insurer);
      throw new QuoteError('grant_not_active', 'quote requires an active consent grant');
    }
    if (grant.status !== 'active') deny('grant_not_active', 'quote requires an active consent grant');
    if (grant.grantee !== input.insurer) deny('not_grantee', 'quote insurer does not match the grant grantee');

    const issued = new Map(this.attestations.listForGrant(input.grantId).map((a) => [a.id, a]));
    const cited = input.attestationIds.map((id) => {
      const att = issued.get(id);
      if (!att) deny('unknown_attestation', 'quote cites an attestation not issued under this grant');
      if (!grant.permittedClaims.includes(att!.claim)) {
        deny('claim_not_permitted', 'quote cites a claim outside the grant');
      }
      return att!;
    });

    const quote: InsuranceQuote = {
      id: randomUUID(),
      grantId: input.grantId,
      insurer: input.insurer,
      product: input.product,
      premiumMinorUnits: input.premiumMinorUnits,
      discountBps: input.discountBps,
      basedOnClaims: cited.map((a) => a.claim),
      expiresAt: new Date(this.now().getTime() + (input.validDays ?? 30) * 86_400_000).toISOString(),
    };
    this.quotes.set(quote.id, quote);
    this.consents.record(input.grantId, 'quote_submitted', {
      accessor: input.insurer,
      product: input.product,
      claims: quote.basedOnClaims.join(','),
      quote_id: quote.id,
    });
    return { ...quote, basedOnClaims: [...quote.basedOnClaims] };
  }

  /** Compare = pure sort; nothing here decides for the user. */
  compare(quoteIds: string[]): InsuranceQuote[] {
    return quoteIds
      .map((id) => this.quotes.get(id))
      .filter((q): q is InsuranceQuote => !!q)
      .sort((a, b) => a.premiumMinorUnits - b.premiumMinorUnits)
      .map((q) => ({ ...q, basedOnClaims: [...q.basedOnClaims] }));
  }

  /**
   * User selects a quote → the data-use reward and platform fee settle via
   * the deterministic ledger. Policy creation itself is a VCAOP transaction
   * outside this module.
   */
  selectQuote(
    quoteId: string,
    byUserId: string,
    ledger: SettlementLedger,
    treasuryAccount: string,
  ): { quote: InsuranceQuote; rewardReceipt: SettlementReceipt } {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new QuoteError('unknown_quote', 'unknown quote');
    // N2: selection denials are receipted too, wherever a grant is resolvable.
    const deny = (code: QuoteError['code'], msg: string): never => {
      this.consents.record(quote.grantId, 'quote_denied', { accessor: byUserId, reason: code, quote_id: quote.id });
      throw new QuoteError(code, msg);
    };
    const maybeGrant = this.consents.get(quote.grantId);
    if (!maybeGrant || maybeGrant.status !== 'active') deny('grant_not_active', 'grant no longer active');
    const grant = maybeGrant!;
    if (grant.userId !== byUserId) deny('not_owner', 'only the data subject can select a quote');
    if (this.now().getTime() > Date.parse(quote.expiresAt)) {
      deny('quote_expired', 'quote has expired');
    }

    const instruction: SettlementInstruction = {
      id: `reward-${quote.id}`,
      type: 'data_use_reward',
      tenantId: grant.tenantId,
      from: treasuryAccount,
      to: `user:${grant.userId}`,
      amount: grant.rewardMinorUnits, // from the grant the user approved — never an LLM's number
      memo: `data-use reward for ${quote.grantId}`,
    };
    const rewardReceipt = ledger.settle(instruction);
    this.consents.record(quote.grantId, 'quote_selected', {
      accessor: byUserId,
      quote_id: quote.id,
      reward_minor_units: grant.rewardMinorUnits,
    });
    return { quote: { ...quote, basedOnClaims: [...quote.basedOnClaims] }, rewardReceipt };
  }
}
