/**
 * Unit tests for the Shopify catalog sync mapping + currency conversion
 * (the logic behind POST /api/v1/vcaop/shopify/sync and the background worker).
 */
import {
  toEurCents,
  deterministicUuid,
  mapShopifyProduct,
  resolveShopifyConfig,
  type ShopifySyncConfig,
  type ShopifyProduct,
} from '../../src/services/shopify-sync';

const cfg: ShopifySyncConfig = {
  domain: '54n0fa-ir.myshopify.com',
  sourceCurrency: 'BAM',
  merchantId: 'a7e3c1d0-0000-4000-8000-000000000001',
  merchantName: 'Vitanaland (Shopify)',
};

describe('toEurCents — fixed-peg conversion', () => {
  test('BAM converts at the 1.95583 euro peg', () => {
    // 17.90 KM / 1.95583 = 9.1521... -> 915 cents
    expect(toEurCents(17.9, 'BAM')).toBe(915);
  });
  test('EUR passes through unchanged', () => {
    expect(toEurCents(9.15, 'EUR')).toBe(915);
  });
  test('unknown currency is treated 1:1', () => {
    expect(toEurCents(10, 'XYZ')).toBe(1000);
  });
  test('non-numeric price returns null', () => {
    expect(toEurCents(Number('not-a-price'), 'BAM')).toBeNull();
  });
});

describe('deterministicUuid — idempotent ids', () => {
  test('is stable for the same key and uuid-shaped', () => {
    const a = deterministicUuid('shopify:store:123');
    const b = deterministicUuid('shopify:store:123');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test('differs for different keys', () => {
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'));
  });
});

describe('mapShopifyProduct', () => {
  const product: ShopifyProduct = {
    id: 15861745090929,
    title: 'Vitamin D3 4000 IU — Daily Vegan Drops',
    handle: 'vitamin-d3-4000-iu-daily-vegan-drops',
    vendor: 'Vitanaland',
    product_type: 'supplements',
    body_html: '<p>Daily <b>vegan</b> D3.</p>',
    variants: [{ price: '17.90', available: true }],
    images: [{ src: 'https://cdn.example/img.png' }],
  };

  test('maps core fields + converts price to EUR cents', () => {
    const row = mapShopifyProduct(product, cfg)!;
    expect(row.source_network).toBe('shopify');
    expect(row.source_product_id).toBe('15861745090929');
    expect(row.price_cents).toBe(915);
    expect(row.currency).toBe('EUR');
    expect(row.availability).toBe('in_stock');
    expect(row.affiliate_url).toBe('https://54n0fa-ir.myshopify.com/products/vitamin-d3-4000-iu-daily-vegan-drops');
    expect(row.images).toEqual(['https://cdn.example/img.png']);
    expect(row.description).toBe('Daily vegan D3.'); // html stripped
    expect(row.merchant_id).toBe(cfg.merchantId);
  });

  test('out-of-stock when no variant is available', () => {
    const row = mapShopifyProduct({ ...product, variants: [{ price: '5', available: false }] }, cfg)!;
    expect(row.availability).toBe('out_of_stock');
  });

  test('returns null for an invalid product (no id/title)', () => {
    expect(mapShopifyProduct({ id: 0, title: '', handle: 'x' } as ShopifyProduct, cfg)).toBeNull();
  });
});

describe('resolveShopifyConfig', () => {
  const ORIG = process.env.SHOPIFY_STORE_DOMAIN;
  afterAll(() => {
    if (ORIG === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
    else process.env.SHOPIFY_STORE_DOMAIN = ORIG;
  });
  test('null when no domain configured', () => {
    delete process.env.SHOPIFY_STORE_DOMAIN;
    expect(resolveShopifyConfig()).toBeNull();
  });
  test('builds config from env', () => {
    process.env.SHOPIFY_STORE_DOMAIN = 'shop.myshopify.com';
    const c = resolveShopifyConfig()!;
    expect(c.domain).toBe('shop.myshopify.com');
    expect(c.sourceCurrency).toBe('BAM'); // default
  });
});
