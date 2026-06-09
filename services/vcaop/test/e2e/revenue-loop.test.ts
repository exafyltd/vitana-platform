import { BatchOnboarder } from '../../src/onboarding/batch-onboard';
import { HumanTaskService } from '../../src/onboarding/human-task-service';
import { CommerceService } from '../../src/commerce/commerce-service';
import { Conductor } from '../../src/agents/conductor';
import { InMemoryRepository } from '../../src/api/repository';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { PolicyEngine } from '../../src/guardrails/policy-engine';
import { seedPolicyEngineFromCatalog, PROVIDER_CATALOG } from '../../src/policy/provider-catalog';

function setup() {
  const repo = new InMemoryRepository();
  const oasis = new InMemoryOasisSink();
  const pe = seedPolicyEngineFromCatalog(new PolicyEngine());
  return { repo, oasis, pe };
}

describe('Batch onboarding (run the catalog in one go)', () => {
  test('fans out the whole catalog into queued jobs + human tasks', async () => {
    const { repo, oasis, pe } = setup();
    const batch = new BatchOnboarder(repo, oasis, new Conductor(pe));
    const entries = PROVIDER_CATALOG.map((e) => ({ providerId: e.id }));
    const summary = await batch.kickoff('platform', entries, 'vault://officer/1');

    expect(summary.total).toBe(PROVIDER_CATALOG.length);
    expect(summary.queued).toBe(PROVIDER_CATALOG.length); // all catalog providers plannable
    expect(summary.denied).toBe(0);
    expect(summary.humanTasksCreated).toBeGreaterThan(0);
    // each queued provider has an account + job
    expect((await repo.list('provider_account')).length).toBe(summary.queued);
    expect((await repo.list('provisioning_job')).length).toBe(summary.queued);
    // human task payloads carry no PII
    const tasks = await repo.list('human_task');
    expect(JSON.stringify(tasks)).not.toMatch(/@|passport/i);
  });

  test('unknown/denied providers are skipped, not crashed', async () => {
    const { repo, oasis, pe } = setup();
    const batch = new BatchOnboarder(repo, oasis, new Conductor(pe));
    const summary = await batch.kickoff('platform', [{ providerId: 'ebay' }, { providerId: 'does_not_exist' }]);
    expect(summary.queued).toBe(1);
    expect(summary.denied).toBe(1);
  });
});

describe('Human-task fast-path (simplify the human loop)', () => {
  test('grouped inbox + bulk complete advances jobs', async () => {
    const { repo, oasis, pe } = setup();
    const batch = new BatchOnboarder(repo, oasis, new Conductor(pe));
    await batch.kickoff('platform', [{ providerId: 'ebay' }, { providerId: 'cj' }]);
    const svc = new HumanTaskService(repo, oasis);

    const inbox = await svc.inbox('platform');
    expect(inbox.openCount).toBeGreaterThan(0);
    expect(inbox.groups.length).toBeGreaterThan(0);

    // bulk complete the non-KYB tasks (registration submits)
    const submitTasks = (await repo.list('human_task', (t) => t.type === 'IRREVERSIBLE_SUBMIT')).map((t) => String(t.id));
    const res = await svc.bulkComplete(submitTasks);
    expect(res.completed.length).toBe(submitTasks.length);
    // KYB tasks cannot be completed via complete()
    const kyb = (await repo.list('human_task', (t) => t.type === 'KYB'))[0];
    await expect(svc.complete(String(kyb.id))).rejects.toThrow(/KYB/);
  });
});

describe('Revenue loop: shop -> earn -> confirm -> wallet -> reverse', () => {
  test('a user buys, earns a projected reward, gets credited on confirm, clawed back on reversal', async () => {
    const { repo, oasis } = setup();
    const commerce = new CommerceService(repo, oasis, 0.5);

    const result = await commerce.shop('user-1', [
      { merchant: 'ebay', items: [{ sku: 'p1', qty: 1, price: 100 }], supports: ['violet'], affiliateProgramId: 'ebay_partner', commissionRate: 0.06 },
    ]);
    expect(result.cart.routes).toHaveLength(1);
    expect(result.totalProjectedReward).toBeCloseTo(100 * 0.06 * 0.5, 4); // 3.00
    expect((await commerce.wallet('user-1')).balance).toBe(0); // pending, not spendable yet

    const commissionId = result.earnings[0].commissionId!;
    await commerce.confirmPurchase(commissionId, 'ebay-postback-123');
    expect((await commerce.wallet('user-1')).balance).toBe(3); // credited

    await commerce.reversePurchase(commissionId, 'refund');
    expect((await commerce.wallet('user-1')).balance).toBe(0); // clawed back
  });

  test('multi-merchant shop accrues rewards per merchant + non-dismissible disclosure', async () => {
    const { repo, oasis } = setup();
    const commerce = new CommerceService(repo, oasis);
    const r = await commerce.shop('user-2', [
      { merchant: 'ebay', items: [{ sku: 'a', qty: 2, price: 10 }], affiliateProgramId: 'ebay_partner' },
      { merchant: 'cj', items: [{ sku: 'b', qty: 1, price: 50 }], affiliateProgramId: 'cj' },
    ]);
    expect(r.earnings.filter((e) => e.commissionId).length).toBe(2);
    const disc = await repo.get('disclosure', r.cart.disclosureId);
    expect(disc!.dismissible).toBe(false);
  });
});
