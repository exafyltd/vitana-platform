/**
 * Deterministic VTNA settlement ledger (Phase 6, brief Sec. 12).
 *
 * Hard rules enforced here:
 *  - No LLM ever calculates or executes a transfer: callers submit
 *    INSTRUCTIONS naming a configured instruction TYPE; amounts for fee-
 *    bearing types are computed HERE from the versioned config, and any
 *    client-supplied amount that disagrees is rejected, never "corrected".
 *  - Idempotent by instruction id — resubmitting returns the original
 *    receipt, no double movement.
 *  - Balance validation before movement; escrow locks funds until release;
 *    reversal is a compensating entry, never an edit of history.
 *  - Every movement appends an immutable receipt; reconcile() re-derives
 *    balances from receipts and reports any divergence loudly.
 *  - Non-sandbox environments require an explicit, recorded human
 *    authorization in the config (BLK-010 — resolved by the platform owner
 *    on 2026-08-09, VTID-03548). The authorization is data the ledger
 *    validates, not a code path an operator can stumble into: a config that
 *    merely says environment:'production' without the full authorization
 *    record still refuses to construct.
 *  - VTNA is a utility/settlement mechanism — nothing here models price,
 *    appreciation, or investment semantics.
 */

/**
 * Recorded human decision that permits a non-sandbox ledger. Every field is
 * required and validated — this is an audit record, not a boolean flag.
 */
export interface LiveSettlementAuthorization {
  /** Must be the literal blocker id this gate was built for. */
  blocker: 'BLK-010';
  /** Who made the call (person, not a service identity). */
  authorized_by: string;
  /** ISO date of the decision. */
  authorized_at: string;
  /** Where the decision is recorded (VTID / document / conversation ref). */
  reference: string;
}

export interface SettlementConfig {
  /** Version of the token-economic parameters — transparent + auditable. */
  config_version: string;
  /** 'production' additionally requires `live_authorization` (BLK-010). */
  environment: 'sandbox' | 'production';
  /** Platform fee in basis points, applied to fee-bearing instruction types. */
  network_fee_bps: number;
  /** Account receiving network fees. */
  fee_account: string;
  /** Required (and validated) whenever environment !== 'sandbox'. */
  live_authorization?: LiveSettlementAuthorization;
}

export type InstructionType =
  | 'data_use_reward'
  | 'loyalty_reward'
  | 'partner_incentive'
  | 'affiliate_reward'
  | 'connector_usage_credit'
  | 'ai_automation_credit'
  | 'escrow_lock'
  | 'escrow_release'
  | 'dispute_adjustment'
  | 'reversal';

export interface SettlementInstruction {
  /** Caller-supplied unique id — the idempotency anchor. */
  id: string;
  type: InstructionType;
  tenantId: string;
  from: string;
  to: string;
  /** Integer minor units (no floats in a ledger). */
  amount: number;
  /** For 'reversal': the receipt id being reversed. For escrow_release: the lock id. */
  ref?: string;
  memo?: string;
}

export interface SettlementReceipt {
  receiptId: string;
  instructionId: string;
  type: InstructionType;
  tenantId: string;
  entries: Array<{ account: string; delta: number }>;
  feeApplied: number;
  configVersion: string;
  createdAt: string;
  reversed: boolean;
}

const FEE_BEARING: InstructionType[] = [
  'affiliate_reward',
  'partner_incentive',
  'data_use_reward',
  'loyalty_reward',
];

export class SettlementError extends Error {
  constructor(
    public readonly code:
      | 'insufficient_funds'
      | 'duplicate_instruction'
      | 'amount_mismatch'
      | 'unknown_ref'
      | 'already_reversed'
      | 'invalid_instruction'
      | 'not_sandbox',
    message: string,
  ) {
    super(message);
    this.name = 'SettlementError';
  }
}

export class SettlementLedger {
  private balances = new Map<string, number>();
  private locked = new Map<string, { from: string; to: string; amount: number; released: boolean }>();
  private receipts: SettlementReceipt[] = [];
  private byInstruction = new Map<string, SettlementReceipt>();
  private seq = 0;

  constructor(
    private readonly config: SettlementConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (config.environment !== 'sandbox') {
      // BLK-010: live instruments require a recorded human authorization.
      const auth = config.live_authorization;
      const complete =
        auth &&
        auth.blocker === 'BLK-010' &&
        typeof auth.authorized_by === 'string' && auth.authorized_by.trim().length > 0 &&
        typeof auth.authorized_at === 'string' && !Number.isNaN(Date.parse(auth.authorized_at)) &&
        typeof auth.reference === 'string' && auth.reference.trim().length > 0;
      if (!complete) {
        throw new SettlementError(
          'not_sandbox',
          'Non-sandbox settlement requires a complete live_authorization record (BLK-010): blocker, authorized_by, authorized_at, reference',
        );
      }
    }
    if (config.network_fee_bps < 0 || config.network_fee_bps > 2000) {
      throw new SettlementError('invalid_instruction', 'network_fee_bps outside sane bounds');
    }
  }

  private funding = new Map<string, number>();

  /** Credit an account from outside the ledger (sandbox funding). Tracked so reconcile() accounts for it. */
  fund(account: string, amount: number): void {
    this.balances.set(account, (this.balances.get(account) ?? 0) + amount);
    this.funding.set(account, (this.funding.get(account) ?? 0) + amount);
  }

  balance(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  /** Compute the fee this ledger WOULD apply — exposed so UIs never re-derive it. */
  feeFor(type: InstructionType, amount: number): number {
    return FEE_BEARING.includes(type) ? Math.floor((amount * this.config.network_fee_bps) / 10_000) : 0;
  }

  /** Submit an instruction. Idempotent: a seen id returns the ORIGINAL receipt. */
  settle(instruction: SettlementInstruction): SettlementReceipt {
    const existing = this.byInstruction.get(instruction.id);
    if (existing) return existing;

    if (!Number.isInteger(instruction.amount) || instruction.amount <= 0) {
      throw new SettlementError('invalid_instruction', 'amount must be a positive integer of minor units');
    }

    switch (instruction.type) {
      case 'escrow_lock':
        return this.escrowLock(instruction);
      case 'escrow_release':
        return this.escrowRelease(instruction);
      case 'reversal':
        return this.reverse(instruction);
      default:
        return this.transfer(instruction);
    }
  }

  private record(
    instruction: SettlementInstruction,
    entries: Array<{ account: string; delta: number }>,
    feeApplied: number,
  ): SettlementReceipt {
    for (const e of entries) {
      this.balances.set(e.account, (this.balances.get(e.account) ?? 0) + e.delta);
    }
    const receipt: SettlementReceipt = {
      receiptId: `rcpt-${++this.seq}`,
      instructionId: instruction.id,
      type: instruction.type,
      tenantId: instruction.tenantId,
      entries,
      feeApplied,
      configVersion: this.config.config_version,
      createdAt: this.now().toISOString(),
      reversed: false,
    };
    this.receipts.push(receipt);
    this.byInstruction.set(instruction.id, receipt);
    return receipt;
  }

  private assertFunds(account: string, amount: number): void {
    if (this.balance(account) < amount) {
      throw new SettlementError('insufficient_funds', `account ${account} holds ${this.balance(account)}, needs ${amount}`);
    }
  }

  private transfer(instruction: SettlementInstruction): SettlementReceipt {
    const fee = this.feeFor(instruction.type, instruction.amount);
    this.assertFunds(instruction.from, instruction.amount);
    const entries = [
      { account: instruction.from, delta: -instruction.amount },
      { account: instruction.to, delta: instruction.amount - fee },
      ...(fee > 0 ? [{ account: this.config.fee_account, delta: fee }] : []),
    ];
    return this.record(instruction, entries, fee);
  }

  private escrowLock(instruction: SettlementInstruction): SettlementReceipt {
    this.assertFunds(instruction.from, instruction.amount);
    const receipt = this.record(
      instruction,
      [{ account: instruction.from, delta: -instruction.amount }],
      0,
    );
    this.locked.set(receipt.receiptId, {
      from: instruction.from,
      to: instruction.to,
      amount: instruction.amount,
      released: false,
    });
    return receipt;
  }

  private escrowRelease(instruction: SettlementInstruction): SettlementReceipt {
    const lock = instruction.ref ? this.locked.get(instruction.ref) : undefined;
    if (!lock) throw new SettlementError('unknown_ref', `no escrow lock ${instruction.ref}`);
    if (lock.released) throw new SettlementError('already_reversed', `escrow ${instruction.ref} already released`);
    if (instruction.amount !== lock.amount) {
      throw new SettlementError('amount_mismatch', `amount mismatch: release ${instruction.amount} ≠ locked ${lock.amount}`);
    }
    lock.released = true;
    return this.record(instruction, [{ account: lock.to, delta: lock.amount }], 0);
  }

  /** Reversal = compensating entries against an existing receipt. History is never edited. */
  private reverse(instruction: SettlementInstruction): SettlementReceipt {
    const target = this.receipts.find((r) => r.receiptId === instruction.ref);
    if (!target) throw new SettlementError('unknown_ref', `no receipt ${instruction.ref}`);
    if (target.reversed) throw new SettlementError('already_reversed', `receipt ${instruction.ref} already reversed`);
    if (target.type === 'reversal') throw new SettlementError('invalid_instruction', 'cannot reverse a reversal');
    target.reversed = true;
    const entries = target.entries.map((e) => ({ account: e.account, delta: -e.delta }));
    return this.record(instruction, entries, 0);
  }

  /** Rebuild balances from receipts and compare — divergence is a loud failure. */
  reconcile(): { ok: boolean; divergences: Array<{ account: string; ledger: number; derived: number }> } {
    const derived = new Map<string, number>();
    for (const r of this.receipts) {
      for (const e of r.entries) derived.set(e.account, (derived.get(e.account) ?? 0) + e.delta);
    }
    // Funding is outside receipts; reconcile only accounts whose activity is receipt-borne.
    const divergences: Array<{ account: string; ledger: number; derived: number }> = [];
    for (const [account, sum] of derived) {
      const funded = this.funding.get(account) ?? 0;
      const ledger = this.balance(account);
      if (ledger !== sum + funded) divergences.push({ account, ledger, derived: sum + funded });
    }
    return { ok: divergences.length === 0, divergences };
  }

  listReceipts(): SettlementReceipt[] {
    return [...this.receipts];
  }
}
