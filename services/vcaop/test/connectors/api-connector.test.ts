import { ApiConnector, MockApiClient, mockApiConnector, API_PROVIDER_STUBS } from '../../src/connectors/api-connector';
import { JobContext } from '../../src/connectors/connector';
import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { HumanTaskRequired, PolicyDenied } from '../../src/guardrails/errors';
import { HumanTask } from '../../src/guardrails/human-gate';

const apiPolicy: ProviderPolicy = {
  automation_allowed: 'api_only',
  registration_method: 'human_required',
  captcha_policy: 'human_only',
  kyb_required: true,
  multi_account_allowed: false,
  affiliate_cashback_allowed: null,
  notes: 't',
};

function ctxFor(providerId: string): { ctx: JobContext; tasks: HumanTask[] } {
  const tasks: HumanTask[] = [];
  return {
    tasks,
    ctx: { providerId, tenantId: 'platform', accountId: 'acc1', env: { VCAOP_ENV: 'dev' }, emitHumanTask: (t) => tasks.push(t) },
  };
}

describe('CONN-API-0002 — ApiConnector (mock round-trip)', () => {
  test('operate round-trips through the mock client when policy allows', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('amazon', apiPolicy);
    const c = mockApiConnector(pe, 'amazon');
    const { ctx } = ctxFor('amazon');
    const r = await c.operate({ kind: 'list_orders', payload: { limit: 5 } }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ provider: 'amazon', action: 'list_orders', echoed: { limit: 5 }, accountId: 'acc1' });
  });

  test('healthCheck returns healthy via the mock client', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('ebay', apiPolicy);
    const c = mockApiConnector(pe, 'ebay');
    const r = await c.healthCheck({ id: 'acc1', tenantId: 'platform', providerId: 'ebay', status: 'active' });
    expect(r.status).toBe('healthy');
    expect(r.details).toMatchObject({ provider: 'ebay' });
  });

  test('operate is blocked by policy default-deny for an unknown provider', async () => {
    const c = mockApiConnector(new PolicyEngine(), 'mystery');
    const { ctx } = ctxFor('mystery');
    await expect(c.operate({ kind: 'x' }, ctx)).rejects.toBeInstanceOf(PolicyDenied);
  });

  test('register is human-gated (emits human_task, halts)', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('amazon', apiPolicy);
    const c = mockApiConnector(pe, 'amazon');
    const { ctx, tasks } = ctxFor('amazon');
    await expect(c.register({ tenantId: 'platform', legalName: 'X', entityType: 'ltd' }, ctx)).rejects.toBeInstanceOf(HumanTaskRequired);
    expect(tasks.length).toBeGreaterThan(0);
  });

  test('verify defaults to verified via api when client has no verify hook', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('walmart', apiPolicy);
    const c = mockApiConnector(pe, 'walmart');
    const { ctx } = ctxFor('walmart');
    expect((await c.verify(ctx)).verified).toBe(true);
  });

  test('all API provider stubs construct and round-trip', async () => {
    const pe = new PolicyEngine();
    for (const p of API_PROVIDER_STUBS) pe.setPolicy(p, apiPolicy);
    for (const p of API_PROVIDER_STUBS) {
      const c = new ApiConnector(pe, new MockApiClient(p));
      const { ctx } = ctxFor(p);
      expect((await c.operate({ kind: 'ping' }, ctx)).ok).toBe(true);
    }
  });
});
