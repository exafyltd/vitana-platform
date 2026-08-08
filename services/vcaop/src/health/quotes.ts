/**
 * Phase 7 — insurer quote exchange over attestations (brief Sec. 11 flow).
 * ⛔ DORMANT BY GOVERNANCE — see consent.ts header (BLK-009).
 *
 * The insurer sees ATTESTATIONS, never metrics. Policy creation is a VCAOP
 * transaction (deterministic, human-gated where irreversible); the user
 * reward + platform fee settle through the deterministic ledger — an LLM
 * never computes either.
 */
import { HealthAttestation } from './attestation';
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

export class QuoteExchange {
  private quotes = new Map<string, InsuranceQuote>();
  private seq = 0;

  constructor(
    private readonly consents: ConsentRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Record an insurer's quote. The exchange validates the quote only cites
   * attestations actually issued under an active grant of that insurer.
   */
  submitQuote(input: {
    grantId: string;
    insurer: string;
    product: string;
    premiumMinorUnits: number;
    discountBps: number;
    attestations: HealthAttestation[];
    validDays?: number;
  }): InsuranceQuote {
    const grant = this.consents.get(input.grantId);
    if (!grant || grant.status !== 'active') throw new Error('quote requires an active consent grant');
    if (grant.grantee !== input.insurer) throw new Error('quote insurer does not match the grant grantee');
    for (const att of input.attestations) {
      if (att.consent_grant_id !== input.grantId) {
        throw new Error(`attestation ${att.id} was not issued under grant ${input.grantId}`);
      }
    }
    const quote: InsuranceQuote = {
      id: `quote-${++this.seq}`,
      grantId: input.grantId,
      insurer: input.insurer,
      product: input.product,
      premiumMinorUnits: input.premiumMinorUnits,
      discountBps: input.discountBps,
      basedOnClaims: input.attestations.map((a) => a.claim),
      expiresAt: new Date(this.now().getTime() + (input.validDays ?? 30) * 86_400_000).toISOString(),
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  /** Compare = pure sort; nothing here decides for the user. */
  compare(quoteIds: string[]): InsuranceQuote[] {
    return quoteIds
      .map((id) => this.quotes.get(id))
      .filter((q): q is InsuranceQuote => !!q)
      .sort((a, b) => a.premiumMinorUnits - b.premiumMinorUnits);
  }

  /**
   * User selects a quote → the data-use reward and platform fee settle via
   * the deterministic ledger (sandbox instruments only, BLK-010). Policy
   * creation itself is a VCAOP transaction outside this module.
   */
  selectQuote(
    quoteId: string,
    byUserId: string,
    ledger: SettlementLedger,
    treasuryAccount: string,
  ): { quote: InsuranceQuote; rewardReceipt: SettlementReceipt } {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new Error(`unknown quote ${quoteId}`);
    const grant = this.consents.get(quote.grantId);
    if (!grant || grant.status !== 'active') throw new Error('grant no longer active');
    if (grant.userId !== byUserId) throw new Error('only the data subject can select a quote');

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
    return { quote, rewardReceipt };
  }
}
