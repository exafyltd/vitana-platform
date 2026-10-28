import { EbayApiClient, EbayOAuthClient, decorateEbayAffiliateLink, EBAY_PROVIDER_ID } from '../../src/connectors/providers/ebay';
import { ApiConnector } from '../../src/connectors/api-connector';
import { OAuthConnector, InMemoryTokenStore } from '../../src/connectors/oauth-connector';
import { JobContext } from '../../src/connectors/connector';
import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { mintSubId } from '../../src/agents/monetization';

const apiPolicy: ProviderPolicy = {
  automation_allowed: 'api_only', registration_method: 'human_required', captcha_policy: 'human_only',
  kyb_required: true, multi_account_allowed: false, affiliate_cashback_allowed: true, notes: 't',
};
const ctx = (): JobContext => ({ providerId: EBAY_PROVIDER_ID, tenantId: 'platform', accountId: 'acc1', env: { VCAOP_ENV: 'dev' }, emitHumanTask: () => {} });

describe('eBay connector scaffold (mock-to-interface; BLK-004)', () => {
  test('ApiConnector + EbayApiClient: mock Browse search round-trip', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy(EBAY_PROVIDER_ID, apiPolicy);
    const c = new ApiConnector(pe, new EbayApiClient({ sandbox: true }));
    const r = await c.operate({ kind: 'search_items', payload: { q: 'camera' } }, ctx());
    expect(r.ok).toBe(true);
    expect((r.data as any).items[0].title).toMatch(/camera/);
    expect((r.data as any).env).toBe('sandbox');
  });

  test('healthCheck reports mock until live', async () => {
    const c = new EbayApiClient({});
    const h = await c.healthCheck({ id: 'acc1', tenantId: 'platform', providerId: EBAY_PROVIDER_ID, status: 'active' });
    expect(h.status).toBe('healthy');
    expect((h.details as any).mock).toBe(true);
  });

  test('live mode refuses to operate without creds (no silent live calls)', async () => {
    const c = new EbayApiClient({ live: true }); // no clientIdRef/secretRef
    await expect(c.operate({ kind: 'search_items' }, ctx())).rejects.toThrow(/clientIdRef/);
  });

  test('OAuthConnector + EbayOAuthClient: mock token + operate', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy(EBAY_PROVIDER_ID, { ...apiPolicy, automation_allowed: 'oauth_only' });
    const store = new InMemoryTokenStore();
    await store.save('acc1', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    const c = new OAuthConnector(pe, new EbayOAuthClient({}), store);
    const r = await c.operate({ kind: 'get_orders' }, ctx());
    expect(r.ok).toBe(true);
    expect((r.data as any).mock).toBe(true);
  });

  test('EPN affiliate link carries the per-user SubID (customid)', () => {
    const subId = mintSubId('user-1', EBAY_PARTNER_PROGRAM());
    const url = decorateEbayAffiliateLink('https://www.ebay.com/itm/mock123', { campaignId: '5338888888', subId });
    expect(url).toContain('campid=5338888888');
    expect(url).toContain(`customid=${subId}`);
    expect(url).toContain('mkevt=1');
  });
});

function EBAY_PARTNER_PROGRAM() { return 'ebay_partner'; }
