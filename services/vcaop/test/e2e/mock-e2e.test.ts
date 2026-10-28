/**
 * Mock END-TO-END flows (runbook Sec. 0.9 Definition of Done / Sec. 7).
 *
 * 1) "onboard mock supplier -> operate"
 * 2) "shop mock merchant -> SubID attribute -> wallet credit -> confirm postback -> reversal"
 *
 * Strings the real modules together over shared in-memory infra, then verifies KPIs
 * read the resulting OASIS projections.
 */
import { InMemoryRepository } from '../../src/api/repository';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { PolicyEngine } from '../../src/guardrails/policy-engine';
import { seedPolicyEngine } from '../../src/policy/provider-policy-seeds';
import { Conductor } from '../../src/agents/conductor';
import { Worker } from '../../src/agents/worker';
import { Validator } from '../../src/agents/validator';
import { mockApiConnector } from '../../src/connectors/api-connector';
import { KybFlow } from '../../src/onboarding/kyb-flow';
import { CartService } from '../../src/commerce/cart';
import { Attribution } from '../../src/rewards/attribution';
import { AffiliateAggregator, MockAggregatorClient } from '../../src/rewards/aggregator';
import { computeKpis } from '../../src/observability/kpi';
import { JobContext } from '../../src/connectors/connector';

describe('Mock E2E — Definition of Done flows', () => {
  test('onboard mock supplier -> operate', async () => {
    const repo = new InMemoryRepository();
    const oasis = new InMemoryOasisSink();
    const pe = seedPolicyEngine(new PolicyEngine()); // amazon is api_only, human_required, kyb_required

    // Plan + execute onboarding (human-gated steps block, as designed).
    const plan = new Conductor(pe).planJob('amazon', 'onboard');
    const connector = mockApiConnector(pe, 'amazon');
    const ctx: JobContext = { providerId: 'amazon', tenantId: 'platform', accountId: 'acc1', env: { VCAOP_ENV: 'dev' }, emitHumanTask: () => {} };
    const onboard = await new Worker().executePlan(plan, connector, ctx, { identity: { tenantId: 'platform', legalName: 'Exafy', entityType: 'ltd' } });
    expect(onboard.status).toBe('blocked'); // KYB/register need a human

    // Human completes KYB (staff + admin), supplier becomes active.
    const kyb = new KybFlow(repo, oasis);
    const started = await kyb.startOnboarding('platform', 'amazon', { tenantId: 'platform', documentRefs: ['vault://doc/1'] });
    await kyb.approve(started.kybTaskId!, 'staff');
    const approved = await kyb.approve(started.kybTaskId!, 'admin');
    expect(approved.accountStatus).toBe('active');

    // Now OPERATE via the API connector (post-activation).
    const opPlan = new Conductor(pe).planJob('amazon', 'operate');
    const op = await new Worker().executePlan(opPlan, connector, ctx, { operateAction: { kind: 'list_orders' } });
    expect(op.status).toBe('completed');
    expect((op.data.operate as any).ok).toBe(true);
  });

  test('shop mock merchant -> SubID attribute -> wallet credit -> confirm -> reversal', async () => {
    const repo = new InMemoryRepository();
    const oasis = new InMemoryOasisSink();

    // Shop: build + route a cart for a merchant with an affiliate program.
    const cart = new CartService(repo, oasis);
    const built = await cart.buildAndRoute('user-42', [
      { merchant: 'shopx', items: [{ sku: 'p1', qty: 2, price: 20 }], supports: ['violet'], affiliateProgramId: 'progX' },
    ]);
    const subId = built.routes[0].subId!;
    expect(subId).toBeTruthy();

    // Aggregator decorates the same SubID for attribution parity.
    const agg = new AffiliateAggregator(new MockAggregatorClient());
    const decorated = agg.decorate('https://shopx.example/p1', 'shopx', 'user-42', 'progX');
    expect(decorated.subId).toBe(subId);

    // Attribute: pending -> confirm -> wallet credit.
    const attr = new Attribution(repo, oasis);
    const { commissionId } = await attr.ingestPending({
      subId, userId: 'user-42', affiliateProgramId: 'progX', merchant: 'shopx', orderRef: 'ord1', grossCommission: 8, userShare: 0.5,
    });
    expect(await attr.walletBalance('user-42')).toBe(0);
    await attr.confirm(commissionId, 'postback-xyz');
    expect(await attr.walletBalance('user-42')).toBe(4);

    // Reversal claws back.
    await attr.reverse(commissionId);
    expect(await attr.walletBalance('user-42')).toBe(0);

    // KPIs read the OASIS projection of the whole flow.
    const k = computeKpis({ events: oasis.events });
    expect(k.commerce.cartsRouted).toBe(1);
    expect(k.commissions.confirmed).toBe(1);
    expect(k.commissions.reversed).toBe(1);
  });
});
