/**
 * VTID-01937: Amazon PA-API v5 provider registration.
 *
 * Catalog scope: Amazon's entire storefront in the selected marketplace
 * (.com / .co.uk / .de / .co.jp / .ca / .com.au / .in / .fr / .it / .es).
 *
 * Access gate: PA-API requires an approved Associate account with ≥3
 * qualifying sales in the last 180 days. Until that threshold is met, any
 * request returns HTTP 403. Code ships now so it's ready when the threshold
 * is met — no further deploys needed.
 *
 * Underlying sync logic lives in ../amazon-sync.ts.
 */

import type { MarketplaceProvider, ProviderSyncResult } from '../provider';
import { runAmazonSync } from '../amazon-sync';

const SUPPORTED_MARKETPLACES = [
  'www.amazon.com',
  'www.amazon.co.uk',
  'www.amazon.de',
  'www.amazon.fr',
  'www.amazon.it',
  'www.amazon.es',
  'www.amazon.co.jp',
  'www.amazon.ca',
  'www.amazon.com.au',
  'www.amazon.in',
];

export const amazonProvider: MarketplaceProvider = {
  key: 'amazon',
  displayName: 'Amazon Associates (PA-API v5)',
  description:
    'Amazon Product Advertising API v5. One source per marketplace (US / UK / DE / …). ' +
    'Requires an approved Associate account with ≥3 qualifying sales in the last 180 days; ' +
    'requests return 403 until the threshold is met.',
  configSchema: [
    {
      key: 'marketplace',
      label: 'Marketplace (e.g. www.amazon.com, www.amazon.de)',
      type: 'text',
      placeholder: 'www.amazon.com',
      required: true,
      help: 'Supported: ' + SUPPORTED_MARKETPLACES.join(', '),
    },
    {
      key: 'access_key',
      label: 'AWS access key (PA-API)',
      type: 'password',
      placeholder: 'AKIA…',
      required: true,
    },
    {
      key: 'secret_key',
      label: 'AWS secret key (PA-API)',
      type: 'password',
      required: true,
    },
    {
      key: 'associate_tag',
      label: 'Associate tag',
      type: 'text',
      placeholder: 'vitana-20',
      required: true,
      help: 'Country-specific: vitana-20 for US, vitana-21 for UK, etc.',
    },
    {
      key: 'keywords',
      label: 'Search keywords (comma-separated)',
      type: 'text',
      placeholder: 'vitamin,supplement,probiotic',
      help: 'One SearchItems call per keyword. Leave blank to default to "supplement,vitamin".',
    },
    {
      key: 'max_pages',
      label: 'Max pages per keyword (1-10)',
      type: 'number',
      placeholder: '10',
      help: 'PA-API caps at 10 pages × 10 items = 100 products per keyword.',
    },
    {
      key: 'merchant_country',
      label: 'Merchant country override (ISO-2, optional)',
      type: 'text',
      placeholder: 'US',
    },
  ],
  validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
    for (const k of ['access_key', 'secret_key', 'associate_tag', 'marketplace']) {
      if (!cfg[k] || typeof cfg[k] !== 'string') return { ok: false, error: `${k} is required` };
    }
    if (!SUPPORTED_MARKETPLACES.includes(String(cfg.marketplace))) {
      return {
        ok: false,
        error: `Unsupported marketplace: ${cfg.marketplace}. Use one of: ${SUPPORTED_MARKETPLACES.join(', ')}`,
      };
    }
    if (cfg.max_pages !== undefined) {
      const n = Number(cfg.max_pages);
      if (!Number.isFinite(n) || n < 1 || n > 10) {
        return { ok: false, error: 'max_pages must be between 1 and 10' };
      }
    }
    return { ok: true };
  },
  async runSync(triggered_by: string): Promise<ProviderSyncResult> {
    const r = await runAmazonSync(triggered_by);
    return {
      ok: r.ok,
      totals: r.totals,
      duration_ms: r.duration_ms,
      details: { marketplaces_synced: r.marketplaces_synced, per_marketplace: r.per_marketplace },
    };
  },
};
