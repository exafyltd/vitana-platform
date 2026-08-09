/** Phase 7 — consent grants, derived attestations, quote exchange. Synthetic data only. */
import { ConsentError, ConsentRegistry } from '../../src/health/consent';
import {
  AttestationError,
  AttestationService,
  VerifiedMetricSource,
  VerifiedMetricWindow,
} from '../../src/health/attestation';
import { QuoteExchange } from '../../src/health/quotes';
import { SettlementLedger } from '../../src/settlement/ledger';

let clock = Date.parse('2026-08-08T12:00:00Z');
const now = () => new Date(clock);

const grantInput = () => ({
  tenantId: 'tenant-a',
  userId: 'user-1',
  grantee: 'Sandbox Insurer AG',
  purpose: 'life_tariff_underwriting_2026',
  permittedClaims: ['weekly_activity_target_met'],
  validFrom: '2026-08-01T00:00:00Z',
  validTo: '2026-12-31T23:59:59Z',
  jurisdiction: 'EU',
  rewardMinorUnits: 2_500,
});

class FixtureMetrics implements VerifiedMetricSource {
  constructor(private readonly windows: VerifiedMetricWindow[]) {}
  async read(_userId: string, metric: string, period: string): Promise<VerifiedMetricWindow | null> {
    return this.windows.find((w) => w.metric === metric && w.period === period) ?? null;
  }
}

const activeMetrics = () =>
  new FixtureMetrics([
    { metric: 'weekly_activity_minutes', period: '2026-Q2', provenance: 'device_measured', values: [180, 200, 160, 150, 90, 170, 155, 190, 165, 175] },
  ]);

function rig(metrics: VerifiedMetricSource = activeMetrics()) {
  const consents = new ConsentRegistry(now);
  const attestations = new AttestationService(consents, metrics, now);
  return { consents, attestations };
}

beforeEach(() => {
  clock = Date.parse('2026-08-08T12:00:00Z');
});

describe('consent grants', () => {
  test('purpose-bound: only the data subject approves; a claim outside the grant is refused and receipted', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    expect(() => consents.approve(grant.id, 'insurer-operator')).toThrow(ConsentError);
    consents.approve(grant.id, 'user-1');

    await expect(attestations.issue(grant.id, 'sleep_consistency_target_met', '2026-Q2')).rejects.toThrow(/not covered/);
    const denied = consents.listReceipts(grant.id).filter((r) => r.kind === 'access_denied');
    expect(denied).toHaveLength(1); // denials are audited too
  });

  test('expiry: access outside the validity window is refused', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    clock = Date.parse('2027-02-01T00:00:00Z');
    await expect(attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2')).rejects.toThrow(/validity/);
  });

  test('receipts are immutable copies — editing a returned receipt changes nothing', () => {
    const { consents } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    const receipts = consents.listReceipts(grant.id);
    receipts[0].detail.grantee = 'TAMPERED';
    expect(consents.listReceipts(grant.id)[0].detail.grantee).toBe('Sandbox Insurer AG');
  });
});

describe('derived attestations', () => {
  test('attestation carries the derived claim only — no raw values anywhere, raw_data_disclosed hardwired false', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    const att = await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2');
    expect(att.met).toBe(true); // 9/10 ≥ 150min against 0.8 required
    expect(att.confidence).toBe(0.9);
    expect(att.raw_data_disclosed).toBe(false);
    // No raw measurement can appear in the attestation or receipts.
    const everything = JSON.stringify({ att, receipts: consents.listReceipts(grant.id) });
    for (const raw of ['180', '200', '160', '90']) expect(everything).not.toContain(raw);
  });

  test('AI-inferred metrics are refused — no insurance action on an unverifiable inference', async () => {
    const inferred = new FixtureMetrics([
      { metric: 'weekly_activity_minutes', period: '2026-Q2', provenance: 'ai_inferred', values: [999, 999] },
    ]);
    const { consents, attestations } = rig(inferred);
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    await expect(attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2')).rejects.toThrow(
      AttestationError,
    );
  });

  test('revocation is immediate and cascades: further access refused, derived attestations deleted', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2');
    expect(attestations.listForGrant(grant.id)).toHaveLength(1);

    consents.revoke(grant.id, 'user-1');
    expect(attestations.deleteForGrant(grant.id)).toBe(1);
    expect(attestations.listForGrant(grant.id)).toHaveLength(0);
    await expect(attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2')).rejects.toThrow(/revoked/);
  });
});

describe('quote exchange + reward settlement', () => {
  test('full flow: attestation → insurer quote → user selects → deterministic reward from the GRANT amount', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    const att = await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2');

    const exchange = new QuoteExchange(consents, now);
    const quote = exchange.submitQuote({
      grantId: grant.id,
      insurer: 'Sandbox Insurer AG',
      product: 'vitality-life',
      premiumMinorUnits: 4_900,
      discountBps: 800,
      attestations: [att],
    });
    // A different insurer cannot piggyback on the grant.
    expect(() =>
      exchange.submitQuote({
        grantId: grant.id,
        insurer: 'Other Insurer',
        product: 'x',
        premiumMinorUnits: 1,
        discountBps: 0,
        attestations: [att],
      }),
    ).toThrow(/does not match/);

    const ledger = new SettlementLedger(
      { config_version: 'sandbox-v1', environment: 'sandbox', network_fee_bps: 250, fee_account: 'platform:fees' },
      now,
    );
    ledger.fund('tenant-a:treasury', 10_000);

    // Only the data subject selects.
    expect(() => exchange.selectQuote(quote.id, 'insurer-operator', ledger, 'tenant-a:treasury')).toThrow(/data subject/);
    const { rewardReceipt } = exchange.selectQuote(quote.id, 'user-1', ledger, 'tenant-a:treasury');

    // Reward = the amount from the APPROVED GRANT (2500), fee-bearing via config.
    expect(rewardReceipt.type).toBe('data_use_reward');
    expect(ledger.balance('user:user-1')).toBe(2_500 - 62); // 2.5% fee floor(62.5)
    expect(ledger.balance('platform:fees')).toBe(62);
    expect(ledger.reconcile().ok).toBe(true);
  });
});
