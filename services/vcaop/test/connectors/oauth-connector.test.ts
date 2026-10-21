import {
  OAuthConnector,
  MockOAuthClient,
  InMemoryTokenStore,
  TokenSet,
} from '../../src/connectors/oauth-connector';
import { JobContext } from '../../src/connectors/connector';
import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { HumanTaskRequired } from '../../src/guardrails/errors';
import { HumanTask } from '../../src/guardrails/human-gate';

const oauthPolicy: ProviderPolicy = {
  automation_allowed: 'oauth_only',
  registration_method: 'human_required',
  captcha_policy: 'human_only',
  kyb_required: false,
  multi_account_allowed: false,
  affiliate_cashback_allowed: null,
  notes: 't',
};

function setup(tokenExpiresInMs = 3600_000) {
  const pe = new PolicyEngine();
  pe.setPolicy('shopify', oauthPolicy);
  const client = new MockOAuthClient('shopify');
  const store = new InMemoryTokenStore();
  const connector = new OAuthConnector(pe, client, store, { refreshSkewMs: 60_000, retryBackoffMs: 0 });
  const tasks: HumanTask[] = [];
  const degraded: { accountId: string; reason: string }[] = [];
  const ctx: JobContext = {
    providerId: 'shopify',
    tenantId: 'platform',
    accountId: 'acc1',
    env: { VCAOP_ENV: 'dev' },
    emitHumanTask: (t) => tasks.push(t),
    markDegraded: (accountId, reason) => degraded.push({ accountId, reason }),
  };
  const token: TokenSet = { accessToken: 'a0', refreshToken: 'r0', expiresAt: Date.now() + tokenExpiresInMs };
  return { connector, client, store, ctx, tasks, degraded, token };
}

describe('CONN-OAUTH-0003 — OAuthConnector token lifecycle', () => {
  test('operate uses a valid token directly (no refresh)', async () => {
    const { connector, client, store, ctx, token } = setup();
    await store.save('acc1', token);
    const r = await connector.operate({ kind: 'list_products' }, ctx);
    expect(r.ok).toBe(true);
    expect(client.refreshCount).toBe(0);
  });

  test('proactively refreshes a near-expiry token before operating', async () => {
    const { connector, client, store, ctx } = setup();
    await store.save('acc1', { accessToken: 'a0', refreshToken: 'r0', expiresAt: Date.now() + 1000 }); // within skew
    const r = await connector.operate({ kind: 'list' }, ctx);
    expect(r.ok).toBe(true);
    expect(client.refreshCount).toBe(1);
    expect((await store.get('acc1'))!.accessToken).toBe('acc_1'); // refreshed token persisted
  });

  test('refresh-on-401: refreshes then retries successfully', async () => {
    const { connector, client, store, ctx, token } = setup();
    await store.save('acc1', token);
    client.unauthorizeOnce = true; // first operate throws 401
    const r = await connector.operate({ kind: 'list' }, ctx);
    expect(r.ok).toBe(true);
    expect(client.refreshCount).toBe(1);
  });

  test('refresh-token revocation -> account degraded + REAUTH human task, halts', async () => {
    const { connector, client, store, ctx, tasks, degraded } = setup();
    await store.save('acc1', { accessToken: 'a0', refreshToken: 'r0', expiresAt: Date.now() + 1000 }); // forces refresh
    client.revoked = true;
    await expect(connector.operate({ kind: 'list' }, ctx)).rejects.toBeInstanceOf(HumanTaskRequired);
    expect(degraded).toEqual([{ accountId: 'acc1', reason: 'refresh token revoked' }]);
    expect(tasks.map((t) => t.type)).toContain('REAUTH');
  });

  test('healthCheck reports degraded when token missing or expired', async () => {
    const { connector, store } = setup();
    const acct = { id: 'acc1', tenantId: 'platform', providerId: 'shopify', status: 'active' };
    expect((await connector.healthCheck(acct)).status).toBe('degraded'); // no token
    await store.save('acc1', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1 });
    expect((await connector.healthCheck(acct)).status).toBe('degraded'); // expired
    await store.save('acc1', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    expect((await connector.healthCheck(acct)).status).toBe('healthy');
  });

  test('register is human-gated', async () => {
    const { connector, ctx } = setup();
    await expect(connector.register({ tenantId: 'platform', legalName: 'X', entityType: 'ltd' }, ctx)).rejects.toBeInstanceOf(HumanTaskRequired);
  });
});
