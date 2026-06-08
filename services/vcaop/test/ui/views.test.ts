import { buildWalletView, buildCartView } from '../../src/ui/community-views';
import { buildCatalogView, buildPolicyEditorModel, buildOpsView, stripSensitive } from '../../src/ui/admin-views';
import { InMemoryRepository } from '../../src/api/repository';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { Attribution } from '../../src/rewards/attribution';
import { CartService } from '../../src/commerce/cart';
import { ProviderPolicy } from '../../src/guardrails/policy-engine';

describe('UIC-WALLET-0001 — wallet view', () => {
  test('shows owning user balance + entries; excludes other users', async () => {
    const repo = new InMemoryRepository();
    const oasis = new InMemoryOasisSink();
    const attr = new Attribution(repo, oasis);
    const { commissionId } = await attr.ingestPending({ subId: 's', userId: 'u1', affiliateProgramId: 'p', merchant: 'm', orderRef: 'o', grossCommission: 10, userShare: 0.5 });
    await attr.confirm(commissionId, 'pb');
    await attr.ingestPending({ subId: 's2', userId: 'u2', affiliateProgramId: 'p', merchant: 'm', orderRef: 'o2', grossCommission: 4 });

    const view = await buildWalletView('u1', repo);
    expect(view.balance).toBe(5);
    expect(view.entries).toHaveLength(1); // only u1's
  });
});

describe('UIC-CART-0002 — cart view', () => {
  test('renders cart with NON-DISMISSIBLE disclosure; blocks cross-user', async () => {
    const repo = new InMemoryRepository();
    const oasis = new InMemoryOasisSink();
    const built = await new CartService(repo, oasis).buildAndRoute('u1', [{ merchant: 'shopx', items: [{ sku: 'a', qty: 1, price: 9 }], supports: ['violet'] }]);
    const view = (await buildCartView(built.cartOrderId, 'u1', repo))!;
    expect(view.disclosure!.dismissible).toBe(false);
    expect(view.lines).toHaveLength(1);
    expect(await buildCartView(built.cartOrderId, 'someone-else', repo)).toBeNull(); // ownership
  });
});

describe('UIA — admin views never render secrets/PII', () => {
  test('stripSensitive drops refs, secrets, and PII-named fields', () => {
    const out = stripSensitive({ id: 'x', credential_ref: 'sm://s', officer_name: 'Jane', legal_name: 'Co', status: 'active', name: 'Amazon' });
    expect(out).toEqual({ id: 'x', status: 'active', name: 'Amazon' });
  });

  test('catalog view returns providers/programs without sensitive fields', async () => {
    const repo = new InMemoryRepository();
    await repo.create('provider', { id: 'amazon', name: 'Amazon', category: 'm', policy: {}, credential_ref: 'sm://x' });
    const view = await buildCatalogView(repo);
    expect(JSON.stringify(view)).not.toMatch(/credential_ref|sm:\/\//);
  });

  test('policy editor model exposes enum choices', () => {
    const policy: ProviderPolicy = { automation_allowed: 'api_only', registration_method: 'human_required', captcha_policy: 'human_only', kyb_required: true, multi_account_allowed: false, affiliate_cashback_allowed: null, notes: '' };
    const m = buildPolicyEditorModel('amazon', policy);
    expect(m.choices.automation_allowed).toContain('denied');
    expect(m.policy.automation_allowed).toBe('api_only');
  });

  test('ops view surfaces open human-task inbox + approvals, no secrets', async () => {
    const repo = new InMemoryRepository();
    await repo.create('human_task', { id: 't1', tenant_id: 'platform', type: 'KYB', status: 'open' });
    await repo.create('human_task', { id: 't2', tenant_id: 'platform', type: 'CAPTCHA', status: 'completed' });
    await repo.create('provider_account', { id: 'a1', tenant_id: 'platform', provider_id: 'amazon', status: 'active', credential_ref: 'sm://leak' });
    const view = await buildOpsView(repo);
    expect(view.humanTaskInbox.map((t) => t.id)).toEqual(['t1']); // only open
    expect(view.approvalsPending.map((t) => t.id)).toEqual(['t1']); // KYB is an approval type
    expect(JSON.stringify(view.accounts)).not.toMatch(/credential_ref|leak/);
  });
});
