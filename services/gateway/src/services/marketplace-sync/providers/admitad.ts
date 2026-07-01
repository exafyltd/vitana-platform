/**
 * VCAOP: Admitad provider registration.
 *
 * Admitad (Mitgo) — already live as a rewards/postback network (publisher
 * account verified, Alibaba WW joined). This registers its *catalog* side so
 * an admin can add an Admitad product source and have it sync into `products`.
 *
 * Credentials are optional in the form: if omitted, the sync falls back to the
 * Secret-Manager-bound VCAOP_ADMITAD_* env already used by the postback flow.
 *
 * Sync logic: ../admitad-sync.ts.
 */

import type { MarketplaceProvider, ProviderSyncResult } from '../provider';
import { runAdmitadSync } from '../admitad-sync';

export const admitadProvider: MarketplaceProvider = {
  key: 'admitad',
  displayName: 'Admitad',
  description:
    'Admitad product catalog via the Products API (OAuth client_credentials). Already wired for rewards/postbacks; this pulls product data for joined advertiser campaigns. Leave credentials blank to use the VCAOP_ADMITAD_* secrets bound to the gateway.',
  configSchema: [
    {
      key: 'client_id',
      label: 'Admitad client_id (optional — falls back to VCAOP_ADMITAD_CLIENT_ID)',
      type: 'password',
    },
    {
      key: 'client_secret',
      label: 'Admitad client_secret (optional — falls back to VCAOP_ADMITAD_CLIENT_SECRET)',
      type: 'password',
    },
    {
      key: 'campaign_ids',
      label: 'Advertiser campaign IDs (comma-separated; blank = all connected)',
      type: 'text',
      list: true,
      placeholder: '12345, 67890',
      help: 'Admitad advertiser campaign IDs you have joined. Leave blank to pull the whole connected catalog.',
    },
    {
      key: 'gotolink_base',
      label: 'Gotolink base (optional — wraps product URLs as affiliate links)',
      type: 'text',
      placeholder: 'https://rzekl.com/g/xxxxxxxx/',
      help: 'If the Products API does not return per-item deeplinks, product URLs are wrapped as {base}?ulp={url}. Per-user subid is added later by the affiliate-link layer.',
    },
    {
      key: 'scope',
      label: 'OAuth scope (default "products")',
      type: 'text',
      placeholder: 'products',
    },
    {
      key: 'max_products',
      label: 'Max products total (default 1000)',
      type: 'number',
      placeholder: '1000',
    },
    {
      key: 'page_size',
      label: 'Page size (default 200, max 500)',
      type: 'number',
      placeholder: '200',
    },
    {
      key: 'merchant_country',
      label: 'Fallback merchant country (ISO-2, optional)',
      type: 'text',
      placeholder: 'DE',
    },
  ],
  validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };

    // campaign_ids may arrive as an array (list:true parsed) or a string.
    let campaignIds = cfg.campaign_ids;
    if (typeof campaignIds === 'string') {
      campaignIds = campaignIds.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (campaignIds !== undefined && !Array.isArray(campaignIds)) {
      return { ok: false, error: 'campaign_ids must be a list' };
    }
    if (Array.isArray(campaignIds)) cfg.campaign_ids = campaignIds;

    if (cfg.max_products !== undefined) {
      const n = Number(cfg.max_products);
      if (!Number.isFinite(n) || n < 1 || n > 50000) {
        return { ok: false, error: 'max_products must be between 1 and 50000' };
      }
    }
    if (cfg.page_size !== undefined) {
      const n = Number(cfg.page_size);
      if (!Number.isFinite(n) || n < 1 || n > 500) {
        return { ok: false, error: 'page_size must be between 1 and 500' };
      }
    }
    return { ok: true };
  },
  async runSync(triggered_by: string): Promise<ProviderSyncResult> {
    const r = await runAdmitadSync(triggered_by);
    return {
      ok: r.ok,
      totals: {
        inserted: r.totals.inserted,
        updated: r.totals.updated,
        skipped: r.totals.skipped,
        errors: r.totals.errors,
      },
      duration_ms: r.duration_ms,
      details: { fetched: r.totals.fetched, campaigns_synced: r.campaigns_synced, per_campaign: r.per_campaign },
      error: r.error,
    };
  },
};
