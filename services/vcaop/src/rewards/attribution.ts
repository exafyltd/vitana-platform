/**
 * Attribution & rewards ledger (RWD-ATTR-0002, runbook Sec. 4.6 / Sec. 7).
 *
 * Postback ingestion → commission_event → rewards_ledger, with the lifecycle
 * pending → confirmed → (reversed/clawback). A reward is only confirmed on a
 * verified postback (Validator). Wallet balance is a projection: sum of confirmed
 * accruals minus reversals. Each transition emits an OASIS event.
 */
import { Repository, newId } from '../api/repository';
import { OasisSink } from '../api/oasis-sink';
import { Validator } from '../agents/validator';

export interface PostbackInput {
  subId: string;
  userId: string;
  affiliateProgramId: string;
  merchant: string;
  orderRef: string;
  grossCommission: number;
  /** Fraction of commission shared to the user (default 0.5). */
  userShare?: number;
}

export class Attribution {
  constructor(
    private readonly repo: Repository,
    private readonly oasis: OasisSink,
    private readonly validator: Validator = new Validator(),
  ) {}

  /** A click/order postback arrives → record a PENDING commission + pending reward accrual. */
  async ingestPending(input: PostbackInput): Promise<{ commissionId: string; rewardId: string }> {
    const commission = await this.repo.create('commission_event', {
      id: newId('commission_event'),
      affiliate_program_id: input.affiliateProgramId,
      sub_id: input.subId,
      user_id: input.userId,
      merchant: input.merchant,
      order_ref: input.orderRef,
      gross_commission: input.grossCommission,
      status: 'pending',
      postback_ref: null,
    });
    const reward = await this.repo.create('rewards_ledger', {
      id: newId('rewards_ledger'),
      user_id: input.userId,
      commission_event_id: commission.id,
      amount: +(input.grossCommission * (input.userShare ?? 0.5)).toFixed(4),
      state: 'pending',
    });
    await this.oasis.emit({
      type: 'vcaop.reward.pending', source: 'attribution', status: 'info',
      message: `pending commission for ${input.merchant}`,
      payload: { commissionId: commission.id, rewardId: reward.id, userId: input.userId },
    });
    return { commissionId: commission.id, rewardId: reward.id };
  }

  /** A CONFIRM postback arrives → confirm commission + reward (only with a verified postback). */
  async confirm(commissionId: string, postbackRef: string): Promise<void> {
    const commission = await this.repo.get('commission_event', commissionId);
    if (!commission) throw new Error(`commission ${commissionId} not found`);
    // Only a still-pending commission may be confirmed. A late/duplicate confirm
    // after a reversal (or re-confirm) must NOT re-credit the wallet.
    if (commission.status !== 'pending') {
      throw new Error(`commission ${commissionId} is '${commission.status}', not 'pending' — refusing to (re)confirm`);
    }
    this.validator.assertConfirmable({ status: commission.status as 'pending', postbackRef }); // refuses without verified postback
    await this.repo.update('commission_event', commissionId, { status: 'confirmed', postback_ref: postbackRef });
    for (const r of await this.rewardsFor(commissionId)) {
      await this.repo.update('rewards_ledger', r.id, { state: 'confirmed' });
    }
    await this.oasis.emit({
      type: 'vcaop.reward.confirmed', source: 'attribution', status: 'success',
      message: `commission confirmed`, payload: { commissionId, postbackRef },
    });
  }

  /** A reversal/clawback → mark commission reversed and claw back the reward accrual. */
  async reverse(commissionId: string, reason = 'merchant reversal'): Promise<void> {
    const commission = await this.repo.get('commission_event', commissionId);
    if (!commission) throw new Error(`commission ${commissionId} not found`);
    await this.repo.update('commission_event', commissionId, { status: 'reversed' });
    for (const r of await this.rewardsFor(commissionId)) {
      await this.repo.update('rewards_ledger', r.id, { state: 'reversed' });
    }
    await this.oasis.emit({
      type: 'vcaop.reward.reversed', source: 'attribution', status: 'warning',
      message: `commission reversed: ${reason}`, payload: { commissionId, reason },
    });
  }

  private async rewardsFor(commissionId: string) {
    return this.repo.list('rewards_ledger', (r) => r.commission_event_id === commissionId);
  }

  /** Wallet balance projection for a user: confirmed accruals minus reversals. */
  async walletBalance(userId: string): Promise<number> {
    const rows = await this.repo.list('rewards_ledger', (r) => r.user_id === userId);
    let total = 0;
    for (const r of rows) {
      if (r.state === 'confirmed' || r.state === 'redeemable') total += Number(r.amount);
      // pending and reversed contribute 0 to spendable balance
    }
    return +total.toFixed(4);
  }
}
