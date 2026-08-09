/** Phase 6 — deterministic VTNA settlement ledger. */
import { SettlementConfig, SettlementError, SettlementLedger } from '../../src/settlement/ledger';

const config: SettlementConfig = {
  config_version: 'sandbox-v1',
  environment: 'sandbox',
  network_fee_bps: 250, // 2.5%
  fee_account: 'platform:fees',
};

const ledger = () => {
  const l = new SettlementLedger(config, () => new Date('2026-08-08T12:00:00Z'));
  l.fund('tenant-a:treasury', 100_000);
  return l;
};

describe('settlement ledger', () => {
  test('BLK-010 gate: refuses a non-sandbox config with no authorization record', () => {
    expect(
      () => new SettlementLedger({ ...config, environment: 'production' }),
    ).toThrow(/live_authorization/);
  });

  test('BLK-010 gate: refuses an incomplete authorization record', () => {
    expect(
      () =>
        new SettlementLedger({
          ...config,
          environment: 'production',
          live_authorization: {
            blocker: 'BLK-010',
            authorized_by: '   ',
            authorized_at: '2026-08-09',
            reference: 'VTID-03548',
          },
        }),
    ).toThrow(/live_authorization/);
    expect(
      () =>
        new SettlementLedger({
          ...config,
          environment: 'production',
          live_authorization: {
            blocker: 'BLK-010',
            authorized_by: 'platform owner',
            authorized_at: 'not-a-date',
            reference: 'VTID-03548',
          },
        }),
    ).toThrow(/live_authorization/);
    expect(
      () =>
        new SettlementLedger({
          ...config,
          environment: 'production',
          live_authorization: {
            blocker: 'BLK-000' as never,
            authorized_by: 'platform owner',
            authorized_at: '2026-08-09',
            reference: 'VTID-03548',
          },
        }),
    ).toThrow(/live_authorization/);
  });

  test('BLK-010 gate: accepts production with a complete recorded authorization (VTID-03548)', () => {
    const l = new SettlementLedger({
      ...config,
      config_version: 'prod-v1',
      environment: 'production',
      live_authorization: {
        blocker: 'BLK-010',
        authorized_by: 'platform owner (d.stevanovic)',
        authorized_at: '2026-08-09',
        reference: 'VTID-03548 — BLK-010 resolution conversation',
      },
    });
    l.fund('tenant-a:treasury', 1_000);
    const receipt = l.settle({
      id: 'prod-ins-1',
      type: 'loyalty_reward',
      tenantId: 'tenant-a',
      from: 'tenant-a:treasury',
      to: 'user:bob',
      amount: 100,
    });
    expect(receipt.configVersion).toBe('prod-v1');
    expect(l.reconcile().ok).toBe(true);
  });

  test('sandbox config still needs no authorization record', () => {
    expect(() => new SettlementLedger(config)).not.toThrow();
  });

  test('fee-bearing transfer computes the fee HERE from versioned config', () => {
    const l = ledger();
    const receipt = l.settle({
      id: 'ins-1',
      type: 'affiliate_reward',
      tenantId: 'tenant-a',
      from: 'tenant-a:treasury',
      to: 'user:alice',
      amount: 10_000,
    });
    expect(receipt.feeApplied).toBe(250);
    expect(receipt.configVersion).toBe('sandbox-v1');
    expect(l.balance('user:alice')).toBe(9_750);
    expect(l.balance('platform:fees')).toBe(250);
    expect(l.balance('tenant-a:treasury')).toBe(90_000);
  });

  test('idempotent: resubmitting an instruction id returns the ORIGINAL receipt, no double movement', () => {
    const l = ledger();
    const ins = { id: 'ins-dup', type: 'loyalty_reward' as const, tenantId: 'tenant-a', from: 'tenant-a:treasury', to: 'user:bob', amount: 1_000 };
    const first = l.settle(ins);
    const second = l.settle(ins);
    expect(second.receiptId).toBe(first.receiptId);
    expect(l.balance('user:bob')).toBe(975); // once, not twice
  });

  test('balance validation: insufficient funds refuse the movement', () => {
    const l = ledger();
    expect(() =>
      l.settle({ id: 'ins-broke', type: 'partner_incentive', tenantId: 'tenant-a', from: 'user:empty', to: 'user:alice', amount: 5 }),
    ).toThrow(SettlementError);
  });

  test('escrow: lock removes funds, release pays out once, mismatched amount refused', () => {
    const l = ledger();
    const lock = l.settle({ id: 'esc-1', type: 'escrow_lock', tenantId: 'tenant-a', from: 'tenant-a:treasury', to: 'user:carol', amount: 2_000 });
    expect(l.balance('tenant-a:treasury')).toBe(98_000);
    expect(l.balance('user:carol')).toBe(0);

    expect(() =>
      l.settle({ id: 'esc-bad', type: 'escrow_release', tenantId: 'tenant-a', from: 'x', to: 'y', amount: 1_500, ref: lock.receiptId }),
    ).toThrow(/mismatch/);

    l.settle({ id: 'esc-rel', type: 'escrow_release', tenantId: 'tenant-a', from: 'x', to: 'y', amount: 2_000, ref: lock.receiptId });
    expect(l.balance('user:carol')).toBe(2_000);

    expect(() =>
      l.settle({ id: 'esc-rel-2', type: 'escrow_release', tenantId: 'tenant-a', from: 'x', to: 'y', amount: 2_000, ref: lock.receiptId }),
    ).toThrow(/already/);
  });

  test('reversal is a compensating entry: history immutable, no double reversal, reversals unreversible', () => {
    const l = ledger();
    const original = l.settle({ id: 'ins-2', type: 'data_use_reward', tenantId: 'tenant-a', from: 'tenant-a:treasury', to: 'user:dora', amount: 4_000 });
    expect(l.balance('user:dora')).toBe(3_900);

    const reversal = l.settle({ id: 'ins-2-rev', type: 'reversal', tenantId: 'tenant-a', from: 'x', to: 'y', amount: 1, ref: original.receiptId });
    expect(l.balance('user:dora')).toBe(0);
    expect(l.balance('platform:fees')).toBe(0); // fee clawed back too
    expect(l.balance('tenant-a:treasury')).toBe(100_000);
    expect(l.listReceipts()).toHaveLength(2); // append-only — nothing edited

    expect(() =>
      l.settle({ id: 'ins-2-rev-2', type: 'reversal', tenantId: 'tenant-a', from: 'x', to: 'y', amount: 1, ref: original.receiptId }),
    ).toThrow(/already reversed/);
    expect(() =>
      l.settle({ id: 'ins-2-rev-3', type: 'reversal', tenantId: 'tenant-a', from: 'x', to: 'y', amount: 1, ref: reversal.receiptId }),
    ).toThrow(/cannot reverse a reversal/);
  });

  test('reconcile re-derives balances from receipts + funding and reports clean', () => {
    const l = ledger();
    l.settle({ id: 'r-1', type: 'affiliate_reward', tenantId: 'tenant-a', from: 'tenant-a:treasury', to: 'user:alice', amount: 10_000 });
    const lock = l.settle({ id: 'r-2', type: 'escrow_lock', tenantId: 'tenant-a', from: 'tenant-a:treasury', to: 'user:bob', amount: 500 });
    l.settle({ id: 'r-3', type: 'escrow_release', tenantId: 'tenant-a', from: 'x', to: 'y', amount: 500, ref: lock.receiptId });
    const result = l.reconcile();
    expect(result.divergences).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('non-integer or non-positive amounts are refused (a ledger has no floats)', () => {
    const l = ledger();
    for (const amount of [0, -5, 19.9]) {
      expect(() =>
        l.settle({ id: `bad-${amount}`, type: 'loyalty_reward', tenantId: 'tenant-a', from: 'tenant-a:treasury', to: 'u', amount }),
      ).toThrow(/positive integer/);
    }
  });
});
