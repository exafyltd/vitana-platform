/**
 * VCAOP: unit tests for the Admitad product normalizer.
 *
 * Admitad's product schema is not pinned from public docs, so normalization is
 * deliberately defensive (multiple candidate field names per attribute). These
 * tests lock the candidate mapping so a future field rename / contract drift is
 * caught locally rather than silently shipping null-filled rows to /discover.
 */

import { normalizeAdmitadItem, type AdmitadSourceConfig } from '../../src/services/marketplace-sync/admitad-sync';

const MERCHANT = 'merchant-uuid-1';
const baseCfg: AdmitadSourceConfig = { merchant_country: 'DE' };

describe('normalizeAdmitadItem', () => {
  it('maps a canonical Admitad-style product item', () => {
    const p = normalizeAdmitadItem(
      {
        id: 'A123',
        name: 'Vitamin D3 2000 IU',
        description: 'High-strength vitamin D supplement',
        price: '19.99',
        oldprice: '24.99',
        currency: 'eur',
        picture: 'https://img.example/d3.jpg',
        deeplink: 'https://rzekl.com/g/abc/?ulp=https%3A%2F%2Fshop%2Fd3',
        available: true,
        category: 'Supplements',
        vendor: 'Acme Health',
        product_gtin: '4012345678901',
      },
      baseCfg,
      MERCHANT
    );
    expect(p).not.toBeNull();
    expect(p!.source_network).toBe('admitad');
    expect(p!.merchant_id).toBe(MERCHANT);
    expect(p!.source_product_id).toBe('A123');
    expect(p!.title).toBe('Vitamin D3 2000 IU');
    expect(p!.price_cents).toBe(1999);
    expect(p!.compare_at_price_cents).toBe(2499);
    expect(p!.currency).toBe('EUR');
    expect(p!.images).toEqual(['https://img.example/d3.jpg']);
    expect(p!.affiliate_url).toContain('rzekl.com');
    expect(p!.availability).toBe('in_stock');
    expect(p!.brand).toBe('Acme Health');
    expect(p!.gtin).toBe('4012345678901');
    expect(p!.origin_country).toBe('DE');
  });

  it('falls back across alternate field names (title/search_price/image_url/url)', () => {
    const p = normalizeAdmitadItem(
      {
        product_id: 'B9',
        title: 'Omega 3',
        search_price: '12.50',
        currency_code: 'USD',
        image_url: 'https://img/o3.png',
        url: 'https://shop/omega3',
        in_stock: 'yes',
      },
      { ...baseCfg, gotolink_base: 'https://go.example/g/xyz/' },
      MERCHANT
    );
    expect(p).not.toBeNull();
    expect(p!.source_product_id).toBe('B9');
    expect(p!.title).toBe('Omega 3');
    expect(p!.price_cents).toBe(1250);
    expect(p!.currency).toBe('USD');
    expect(p!.availability).toBe('in_stock');
    // No deeplink on item → wrapped via gotolink_base with the product url as ulp.
    expect(p!.affiliate_url).toBe('https://go.example/g/xyz/?ulp=' + encodeURIComponent('https://shop/omega3'));
  });

  it('drops items missing an id, title, or parseable price', () => {
    expect(normalizeAdmitadItem({ name: 'x', price: '1.00' }, baseCfg, MERCHANT)).toBeNull();
    expect(normalizeAdmitadItem({ id: '1', price: '1.00' }, baseCfg, MERCHANT)).toBeNull();
    expect(normalizeAdmitadItem({ id: '1', name: 'x' }, baseCfg, MERCHANT)).toBeNull();
  });

  it('reads availability from boolean, numeric, and string forms', () => {
    const mk = (available: unknown) =>
      normalizeAdmitadItem({ id: '1', name: 'x', price: '1.00', available }, baseCfg, MERCHANT)!.availability;
    expect(mk(false)).toBe('out_of_stock');
    expect(mk(0)).toBe('out_of_stock');
    expect(mk('out of stock')).toBe('out_of_stock');
    expect(mk('preorder')).toBe('preorder');
    expect(mk(true)).toBe('in_stock');
    expect(mk('')).toBe('unknown');
  });

  it('preserves the raw item for activation-time verification', () => {
    const item = { id: '1', name: 'x', price: '1.00', some_unknown_field: 'keepme' };
    const p = normalizeAdmitadItem(item, baseCfg, MERCHANT);
    expect(p!.raw).toEqual(item);
  });
});
