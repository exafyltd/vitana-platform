/**
 * VTID-01930: Shopify provider registration.
 *
 * The underlying sync logic lives in ../shopify-sync.ts. This file is the
 * provider-registry adapter: config schema, display name, and the runSync
 * binding.
 */

import type { MarketplaceProvider, ProviderSyncResult } from '../provider';
import { runShopifySync } from '../shopify-sync';

export const shopifyProvider: MarketplaceProvider = {
  key: 'shopify',
  displayName: 'Shopify',
  description:
    'Per-merchant Shopify stores. Read-only Storefront API — install the Vitana partner app on the shop, paste the Storefront access token.',
  configSchema: [
    {
      key: 'domain',
      label: 'Shopify domain',
      type: 'text',
      placeholder: 'acme-supplements.myshopify.com',
      required: true,
    },
    {
      key: 'storefront_access_token',
      label: 'Storefront access token',
      type: 'password',
      placeholder: 'shpat_…',
      required: true,
    },
    {
      key: 'affiliate_url_template',
      label: 'Affiliate URL template (optional)',
      type: 'text',
      placeholder: 'https://{domain}/products/{handle}?ref=vitana',
    },
    {
      key: 'merchant_country',
      label: 'Merchant country (ISO-2, optional)',
      type: 'text',
      placeholder: 'DE',
    },
  ],
  validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
    if (!cfg.domain || typeof cfg.domain !== 'string') return { ok: false, error: 'domain is required' };
    if (!cfg.storefront_access_token || typeof cfg.storefront_access_token !== 'string') {
      return { ok: false, error: 'storefront_access_token is required' };
    }
    return { ok: true };
  },
  async runSync(triggered_by: string): Promise<ProviderSyncResult> {
    const r = await runShopifySync(triggered_by);
    return {
      ok: r.ok,
      totals: r.totals,
      duration_ms: r.duration_ms,
      details: { shops_synced: r.shops_synced, per_shop: r.per_shop },
    };
  },
};
