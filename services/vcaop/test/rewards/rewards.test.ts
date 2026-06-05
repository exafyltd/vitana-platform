import { AffiliateAggregator, MockAggregatorClient } from '../../src/rewards/aggregator';
import { Attribution } from '../../src/rewards/attribution';
import { DirectRegistration, TOP_DIRECT_PROGRAMS } from '../../src/rewards/direct-registration';
import { LoyaltyService } from '../../src/rewards/loyalty';
import { InMemoryRepository } from '../../src/api/repository';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { mintSubId } from '../../src/agents/monetization';
import { LoyaltyGuardViolation, AccountMarketViolation } from '../../src/guardrails/errors';

describe('RWD-AGG-0001 — affiliate aggregator', () => {
  test('decorates a link with a deterministic per-user SubID', () => {
    const agg = new AffiliateAggregator(new MockAggregatorClient());
    const d = agg.decorate('https://shop.example/p/1', 'shop.example', 'u1', 'prog1');
    expect(d.subId).toBe(mintSubId('u1', 'prog1'));
    expect(d.url).toContain(`subid=${d.subId}`);
    expect(d.url).toContain(encodeURIComponent('https://shop.example/p/1'));
  });
});

describe('RWD-ATTR-0002 — attribution + rewards ledger', () => {
  function setup() {
    const repo = new InMemoryRepository();
    const oasis = new InMemoryOasisSink();
    return { repo, oasis, attr: new Attribution(repo, oasis) };
  }
  const postback = { subId: 'sub_x', userId: 'u1', affiliateProgramId: 'prog1', merchant: 'shopx', orderRef: 'o1', grossCommission: 10, userShare: 0.5 };

  test('simulated postback credits the correct user (pending, then confirmed)', async () => {
    const { attr } = setup();
    const { commissionId } = await attr.ingestPending(postback);
    expect(await attr.walletBalance('u1')).toBe(0); // pending not spendable
    await attr.confirm(commissionId, 'pb_123');
    expect(await attr.walletBalance('u1')).toBe(5); // 10 * 0.5
    expect(await attr.walletBalance('u2')).toBe(0); // not the other user
  });

  test('confirm refuses without a verified postback', async () => {
    const { attr } = setup();
    const { commissionId } = await attr.ingestPending(postback);
    await expect(attr.confirm(commissionId, '')).rejects.toThrow(/postback/);
  });

  test('reversal claws back the reward', async () => {
    const { attr } = setup();
    const { commissionId } = await attr.ingestPending(postback);
    await attr.confirm(commissionId, 'pb_123');
    expect(await attr.walletBalance('u1')).toBe(5);
    await attr.reverse(commissionId);
    expect(await attr.walletBalance('u1')).toBe(0); // clawed back
  });
});

describe('RWD-DIRECT-0003 — direct publisher registration', () => {
  test('generates application + tax + bank human tasks; no auto-submit of identity', async () => {
    const repo = new InMemoryRepository();
    const oasis = new InMemoryOasisSink();
    const dr = new DirectRegistration(repo, oasis);
    const app = await dr.apply({ tenantId: 'platform', programId: 'awin', siteOrApp: 'vitanaland.app' });
    expect(app.taskIds).toHaveLength(3);
    const tasks = await repo.list('human_task');
    const types = tasks.map((t) => t.type).sort();
    expect(types).toEqual(['IRREVERSIBLE_SUBMIT', 'KYB', 'PAYOUT_BANK_LINK']);
    // no raw identity in any task payload
    expect(JSON.stringify(tasks)).not.toMatch(/@|passport/i);
  });

  test('top direct programs list is populated', () => {
    expect(TOP_DIRECT_PROGRAMS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('RWD-LOYAL-0004 — consented read-only loyalty links', () => {
  function setup() {
    const repo = new InMemoryRepository();
    const oasis = new InMemoryOasisSink();
    return { repo, svc: new LoyaltyService(repo, oasis) };
  }

  test('creates a read-only, credential-free link', async () => {
    const { svc, repo } = setup();
    const { id } = await svc.link({ userId: 'u1', program: 'united_mileageplus', memberId: 'MP123', consentRef: 'consent://1' });
    const link = await repo.get('user_reward_link', id);
    expect(link!.read_only).toBe(true);
    expect(JSON.stringify(link)).not.toMatch(/password|secret|credential/i);
  });

  test('rejects pool/transfer/resale loyalty endpoints', () => {
    const { svc } = setup();
    expect(() => svc.assertEndpointAllowed('/loyalty/link')).not.toThrow();
    expect(() => svc.assertEndpointAllowed('/loyalty/withdraw')).toThrow(LoyaltyGuardViolation);
    expect(() => svc.assertEndpointAllowed('/miles/pool')).toThrow(AccountMarketViolation);
  });
});
