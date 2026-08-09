/**
 * Phase 7 — consent grants, derived attestations, quote exchange.
 * Synthetic data only. Includes regression coverage for every finding of the
 * 2026-08-09 independent privacy review (F1–F14, verdict FAIL → remediated).
 */
import {
  ConsentError,
  ConsentRegistry,
  HealthLayerActivation,
} from '../../src/health/consent';
import {
  AttestationError,
  AttestationService,
  MAX_ISSUANCES_PER_GRANT,
  MIN_SAMPLES,
  VerifiedMetricSource,
  VerifiedMetricWindow,
  confidenceBand,
} from '../../src/health/attestation';
import { QuoteError, QuoteExchange } from '../../src/health/quotes';
import { SettlementLedger } from '../../src/settlement/ledger';

let clock = Date.parse('2026-08-08T12:00:00Z');
const now = () => new Date(clock);

const INSURER = 'Sandbox Insurer AG';

const activation: HealthLayerActivation = {
  blocker: 'BLK-009',
  review_reference: 'independent privacy review 2026-08-09 (remediated re-review)',
  activated_by: 'platform owner (d.stevanovic)',
  activated_at: '2026-08-09',
};

const grantInput = () => ({
  tenantId: 'tenant-a',
  userId: 'user-1',
  grantee: INSURER,
  purpose: 'life_tariff_underwriting_2026',
  permittedClaims: ['weekly_activity_target_met'],
  validFrom: '2026-08-01T00:00:00Z',
  validTo: '2026-12-31T23:59:59Z',
  jurisdiction: 'EU',
  rewardMinorUnits: 2_500,
});

class FixtureMetrics implements VerifiedMetricSource {
  onRead?: () => void;
  constructor(private readonly windows: VerifiedMetricWindow[]) {}
  async read(_userId: string, metric: string, period: string): Promise<VerifiedMetricWindow | null> {
    this.onRead?.();
    return this.windows.find((w) => w.metric === metric && w.period === period) ?? null;
  }
}

const activeMetrics = () =>
  new FixtureMetrics([
    { metric: 'weekly_activity_minutes', period: '2026-Q2', provenance: 'device_measured', values: [180, 200, 160, 150, 90, 170, 155, 190, 165, 175] },
  ]);

function rig(metrics: FixtureMetrics = activeMetrics()) {
  const consents = new ConsentRegistry(activation, now);
  const attestations = new AttestationService(consents, metrics, now);
  return { consents, attestations, metrics };
}

beforeEach(() => {
  clock = Date.parse('2026-08-08T12:00:00Z');
});

describe('activation gate (F10)', () => {
  test('refuses to construct without a complete BLK-009 activation record', () => {
    expect(() => new ConsentRegistry(undefined as never, now)).toThrow(/BLK-009/);
    expect(
      () => new ConsentRegistry({ ...activation, review_reference: '  ' }, now),
    ).toThrow(/BLK-009/);
    expect(
      () => new ConsentRegistry({ ...activation, blocker: 'BLK-999' as never }, now),
    ).toThrow(/BLK-009/);
  });
});

describe('consent grants', () => {
  test('purpose-bound: only the data subject approves; a claim outside the grant is refused and receipted', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    expect(() => consents.approve(grant.id, 'insurer-operator')).toThrow(ConsentError);
    consents.approve(grant.id, 'user-1');

    await expect(attestations.issue(grant.id, 'sleep_consistency_target_met', '2026-Q2', INSURER)).rejects.toThrow(/not covered/);
    const denied = consents.listReceipts({ grantId: grant.id }).filter((r) => r.kind === 'access_denied');
    expect(denied).toHaveLength(1); // denials are audited too
    expect(denied[0].detail.accessor).toBe(INSURER); // F8: accessor recorded
  });

  test('F1: only the grantee can request attestations — another insurer is denied and receipted', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    await expect(attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', 'Other Insurer')).rejects.toThrow(
      /not the grantee/,
    );
    const denied = consents.listReceipts({ grantId: grant.id }).filter((r) => r.kind === 'access_denied');
    expect(denied[0].detail.reason).toBe('not_grantee');
  });

  test('F1: grant ids are not enumerable sequences', () => {
    const { consents } = rig();
    const a = consents.propose(grantInput());
    const b = consents.propose(grantInput());
    expect(a.id).not.toMatch(/^grant-\d+$/);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });

  test('F8: probing an unknown grant id leaves a trace', () => {
    const { consents } = rig();
    expect(() => consents.approve('00000000-0000-0000-0000-000000000000', 'user-1')).toThrow(/unknown grant/);
    const probes = consents.listProbeAttempts();
    expect(probes).toHaveLength(1);
    expect(probes[0].attemptedGrantId).toBe('00000000-0000-0000-0000-000000000000');
    expect(probes[0].accessor).toBe('user-1');
  });

  test('F7: approve is legal only from proposed — a revoked grant cannot be resurrected', () => {
    const { consents } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    consents.revoke(grant.id, 'user-1');
    expect(() => consents.approve(grant.id, 'user-1')).toThrow(/only a proposed grant/);
    expect(consents.get(grant.id)!.status).toBe('revoked');
    const denied = consents.listReceipts({ grantId: grant.id }).filter((r) => r.kind === 'access_denied');
    expect(denied.some((r) => r.detail.reason === 'illegal_approve')).toBe(true);
  });

  test('F4: returned grants are frozen copies — consent terms cannot be rewritten from outside', () => {
    const { consents } = rig();
    const grant = consents.propose(grantInput());
    expect(() => {
      (grant as { validTo: string }).validTo = '2099-01-01T00:00:00Z';
    }).toThrow();
    expect(() => grant.permittedClaims.push('sleep_consistency_target_met')).toThrow();
    const stored = consents.get(grant.id)!;
    expect(stored.validTo).toBe('2026-12-31T23:59:59Z');
    expect(stored.permittedClaims).toEqual(['weekly_activity_target_met']);
  });

  test('F11: access before validFrom denies without bricking the grant', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose({ ...grantInput(), validFrom: '2026-09-01T00:00:00Z' });
    consents.approve(grant.id, 'user-1');
    await expect(attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER)).rejects.toThrow(
      /not started/,
    );
    expect(consents.get(grant.id)!.status).toBe('active'); // NOT flipped to expired
  });

  test('expiry: access outside the validity window is refused', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    clock = Date.parse('2027-02-01T00:00:00Z');
    await expect(attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER)).rejects.toThrow(/validity/);
  });

  test('receipts are immutable copies — editing a returned receipt changes nothing', () => {
    const { consents } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    const receipts = consents.listReceipts({ grantId: grant.id });
    receipts[0].detail.grantee = 'TAMPERED';
    expect(consents.listReceipts({ grantId: grant.id })[0].detail.grantee).toBe(INSURER);
  });

  test('F14: receipt reads require an explicit scope', () => {
    const { consents } = rig();
    expect(() => consents.listReceipts({} as { grantId?: string })).toThrow(/filter/);
  });
});

describe('derived attestations', () => {
  test('attestation carries the derived claim only — no raw values, coarse confidence band, raw_data_disclosed hardwired false', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    const att = await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER);
    expect(att.met).toBe(true); // 9/10 ≥ 150min against 0.8 required
    expect(att.confidence_band).toBe('high'); // F6: band, never the exact ratio
    expect((att as unknown as Record<string, unknown>).confidence).toBeUndefined();
    expect(att.raw_data_disclosed).toBe(false);
    // No raw measurement can appear in the attestation or receipts.
    const everything = JSON.stringify({ att, receipts: consents.listReceipts({ grantId: grant.id }) });
    for (const raw of ['180', '200', '160', '90', '0.9']) expect(everything).not.toContain(raw);
  });

  test('F12: AI-inferred, missing, and too-small windows are ONE indistinguishable refusal', async () => {
    const cases: FixtureMetrics[] = [
      new FixtureMetrics([
        { metric: 'weekly_activity_minutes', period: '2026-Q2', provenance: 'ai_inferred', values: [999, 999, 999, 999, 999, 999, 999, 999] },
      ]),
      new FixtureMetrics([]),
      new FixtureMetrics([
        { metric: 'weekly_activity_minutes', period: '2026-Q2', provenance: 'device_measured', values: [180] },
      ]),
    ];
    const messages = new Set<string>();
    for (const metrics of cases) {
      const { consents, attestations } = rig(metrics);
      const grant = consents.propose(grantInput());
      consents.approve(grant.id, 'user-1');
      const err = await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER).catch((e) => e);
      expect(err).toBeInstanceOf(AttestationError);
      expect((err as AttestationError).code).toBe('cannot_attest');
      messages.add((err as Error).message);
    }
    expect(messages.size).toBe(1); // identical message for all three reasons
  });

  test('F2: a revoke landing during the metric read wins — no attestation, no issue receipt', async () => {
    const metrics = activeMetrics();
    const { consents, attestations } = rig(metrics);
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    metrics.onRead = () => consents.revoke(grant.id, 'user-1'); // concurrent revoke mid-flight
    await expect(attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER)).rejects.toThrow(/revoked/);
    expect(attestations.listForGrant(grant.id)).toHaveLength(0);
    const issuedReceipts = consents.listReceipts({ grantId: grant.id }).filter((r) => r.kind === 'attestation_issued');
    expect(issuedReceipts).toHaveLength(0);
  });

  test('F3: revocation alone cascades — deleteForGrant needs no separate call', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER);
    expect(attestations.listForGrant(grant.id)).toHaveLength(1);

    consents.revoke(grant.id, 'user-1'); // no manual deleteForGrant
    expect(attestations.listForGrant(grant.id)).toHaveLength(0);
    await expect(attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER)).rejects.toThrow(/revoked/);
  });

  test('F6: only coarse quarter periods are attestable', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    for (const period of ['2026-06', '2026-W23', '2026-06-01', 'day-1']) {
      await expect(attestations.issue(grant.id, 'weekly_activity_target_met', period, INSURER)).rejects.toThrow(
        /quarter/,
      );
    }
  });

  test('F6: issuance is idempotent per (grant, claim, period) — repetition yields no new information', async () => {
    const { consents, attestations } = rig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    const first = await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER);
    const second = await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER);
    expect(second.id).toBe(first.id);
    expect(attestations.listForGrant(grant.id)).toHaveLength(1);
  });

  test('F6: issuance budget per grant is enforced', async () => {
    const windows: VerifiedMetricWindow[] = [];
    for (let y = 0; y < 13; y++) {
      for (const q of [1, 2, 3, 4]) {
        windows.push({
          metric: 'weekly_activity_minutes',
          period: `${2000 + y}-Q${q}`,
          provenance: 'device_measured',
          values: [180, 200, 160, 150, 90, 170, 155, 190],
        });
      }
    }
    const { consents, attestations } = rig(new FixtureMetrics(windows));
    const grant = consents.propose({ ...grantInput(), validFrom: '2000-01-01T00:00:00Z' });
    consents.approve(grant.id, 'user-1');
    let issued = 0;
    let budgetError: unknown = null;
    for (const w of windows) {
      try {
        await attestations.issue(grant.id, 'weekly_activity_target_met', w.period, INSURER);
        issued++;
      } catch (e) {
        budgetError = e;
        break;
      }
    }
    expect(issued).toBe(MAX_ISSUANCES_PER_GRANT);
    expect((budgetError as AttestationError).code).toBe('issuance_budget_exceeded');
  });

  test('confidence bands are coarse and MIN_SAMPLES is a real floor', () => {
    expect(confidenceBand(0.49)).toBe('low');
    expect(confidenceBand(0.5)).toBe('medium');
    expect(confidenceBand(0.84)).toBe('medium');
    expect(confidenceBand(0.85)).toBe('high');
    expect(MIN_SAMPLES).toBeGreaterThanOrEqual(8);
  });
});

describe('quote exchange + reward settlement', () => {
  function fullRig() {
    const parts = rig();
    const exchange = new QuoteExchange(parts.consents, parts.attestations, now);
    return { ...parts, exchange };
  }

  test('full flow: attestation → insurer quote → user selects → deterministic reward from the GRANT amount', async () => {
    const { consents, attestations, exchange } = fullRig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    const att = await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER);

    const quote = exchange.submitQuote({
      grantId: grant.id,
      insurer: INSURER,
      product: 'vitality-life',
      premiumMinorUnits: 4_900,
      discountBps: 800,
      attestationIds: [att.id],
    });
    // A different insurer cannot piggyback on the grant.
    expect(() =>
      exchange.submitQuote({
        grantId: grant.id,
        insurer: 'Other Insurer',
        product: 'x',
        premiumMinorUnits: 1,
        discountBps: 0,
        attestationIds: [att.id],
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

    // F8: quote lifecycle is receipted.
    const kinds = consents.listReceipts({ grantId: grant.id }).map((r) => r.kind);
    expect(kinds).toContain('quote_submitted');
    expect(kinds).toContain('quote_selected');
  });

  test('F5: a fabricated attestation id is refused — quotes only cite what the service issued', async () => {
    const { consents, exchange } = fullRig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    expect(() =>
      exchange.submitQuote({
        grantId: grant.id,
        insurer: INSURER,
        product: 'vitality-life',
        premiumMinorUnits: 4_900,
        discountBps: 800,
        attestationIds: ['forged-attestation-id'],
      }),
    ).toThrow(QuoteError);
    const denied = consents.listReceipts({ grantId: grant.id }).filter((r) => r.kind === 'quote_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].detail.reason).toBe('unknown_attestation');
  });

  test('an expired quote cannot be selected', async () => {
    const { consents, attestations, exchange } = fullRig();
    const grant = consents.propose(grantInput());
    consents.approve(grant.id, 'user-1');
    const att = await attestations.issue(grant.id, 'weekly_activity_target_met', '2026-Q2', INSURER);
    const quote = exchange.submitQuote({
      grantId: grant.id,
      insurer: INSURER,
      product: 'vitality-life',
      premiumMinorUnits: 4_900,
      discountBps: 800,
      attestationIds: [att.id],
      validDays: 1,
    });
    clock += 2 * 86_400_000;
    const ledger = new SettlementLedger(
      { config_version: 'sandbox-v1', environment: 'sandbox', network_fee_bps: 250, fee_account: 'platform:fees' },
      now,
    );
    ledger.fund('tenant-a:treasury', 10_000);
    expect(() => exchange.selectQuote(quote.id, 'user-1', ledger, 'tenant-a:treasury')).toThrow(/expired/);
  });
});
