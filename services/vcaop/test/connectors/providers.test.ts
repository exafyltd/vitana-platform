import { ShopifyApiClient, ShopifyOAuthClient, SHOPIFY_PROVIDER_ID } from '../../src/connectors/providers/shopify';
import { AmazonSpApiClient, decorateAmazonAffiliateLink, AMAZON_PROVIDER_ID } from '../../src/connectors/providers/amazon';
import { CjApiClient, decorateCjLink, CJ_PROVIDER_ID } from '../../src/connectors/providers/cj';
import { RakutenApiClient, decorateRakutenLink, RAKUTEN_PROVIDER_ID } from '../../src/connectors/providers/rakuten';
import { ApiConnector } from '../../src/connectors/api-connector';
import { OAuthConnector, InMemoryTokenStore } from '../../src/connectors/oauth-connector';
import { JobContext } from '../../src/connectors/connector';
import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { mintSubId } from '../../src/agents/monetization';

const pol = (mode: ProviderPolicy['automation_allowed']): ProviderPolicy => ({
  automation_allowed: mode, registration_method: 'human_required', captcha_policy: 'human_only',
  kyb_required: true, multi_account_allowed: false, affiliate_cashback_allowed: true, notes: 't',
});
const ctx = (p: string): JobContext => ({ providerId: p, tenantId: 'platform', accountId: 'acc1', env: { VCAOP_ENV: 'dev' }, emitHumanTask: () => {} });

describe('Provider scaffolds: Shopify / Amazon / CJ / Rakuten (mock-to-interface)', () => {
  test('Shopify OAuth connector mock operate + apiclient health', async () => {
    const pe = new PolicyEngine(); pe.setPolicy(SHOPIFY_PROVIDER_ID, pol('oauth_only'));
    const store = new InMemoryTokenStore();
    await store.save('acc1', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    const c = new OAuthConnector(pe, new ShopifyOAuthClient({ shop: 'demo.myshopify.com' }), store);
    expect((await c.operate({ kind: 'list_products' }, ctx(SHOPIFY_PROVIDER_ID))).ok).toBe(true);
    expect((await new ShopifyApiClient().healthCheck({ id: 'acc1', tenantId: 'platform', providerId: SHOPIFY_PROVIDER_ID, status: 'active' })).status).toBe('healthy');
  });

  test('Shopify live refuses without creds', async () => {
    await expect(new ShopifyApiClient({ live: true }).operate({ kind: 'x' }, ctx(SHOPIFY_PROVIDER_ID))).rejects.toThrow(/BLK-006/);
  });

  test('Amazon SP-API mock search + Associates link carries tag + SubID', async () => {
    const pe = new PolicyEngine(); pe.setPolicy(AMAZON_PROVIDER_ID, pol('api_only'));
    const c = new ApiConnector(pe, new AmazonSpApiClient({ region: 'eu' }));
    const r = await c.operate({ kind: 'search_catalog' }, ctx(AMAZON_PROVIDER_ID));
    expect((r.data as any).items[0].asin).toBe('B0MOCK123');
    const link = decorateAmazonAffiliateLink('https://www.amazon.com/dp/B0MOCK123', { tag: 'vitana-21', subId: mintSubId('u1', 'amazon_associates') });
    expect(link).toContain('tag=vitana-21');
    expect(link).toContain('ascsubtag=');
  });

  test('Amazon SP-API live refuses without LWA creds', async () => {
    await expect(new AmazonSpApiClient({ live: true }).operate({ kind: 'x' }, ctx(AMAZON_PROVIDER_ID))).rejects.toThrow(/lwaClientIdRef/);
  });

  test('CJ mock search + deep link carries publisher id + SubID', async () => {
    const pe = new PolicyEngine(); pe.setPolicy(CJ_PROVIDER_ID, pol('api_only'));
    const c = new ApiConnector(pe, new CjApiClient({}));
    expect((await c.operate({ kind: 'search_products' }, ctx(CJ_PROVIDER_ID))).ok).toBe(true);
    const link = decorateCjLink('https://www.advertiser.com/p/1', { websiteId: 'PID123', subId: mintSubId('u1', 'cj') });
    expect(link).toContain('cjpid=PID123');
    expect(link).toContain('sid=');
  });

  test('Rakuten mock search + link carries mid + u1 SubID; live refuses', async () => {
    const pe = new PolicyEngine(); pe.setPolicy(RAKUTEN_PROVIDER_ID, pol('api_only'));
    const c = new ApiConnector(pe, new RakutenApiClient({}));
    expect((await c.operate({ kind: 'search_products' }, ctx(RAKUTEN_PROVIDER_ID))).ok).toBe(true);
    const link = decorateRakutenLink('https://click.linksynergy.com/deeplink', { mid: '12345', subId: mintSubId('u1', 'rakuten_advertising') });
    expect(link).toContain('mid=12345');
    expect(link).toContain('u1=');
    await expect(new RakutenApiClient({ live: true }).operate({ kind: 'x' }, ctx(RAKUTEN_PROVIDER_ID))).rejects.toThrow(/clientIdRef/);
  });
});
