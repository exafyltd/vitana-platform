/**
 * VTID-02000: Admin Marketplace routes — Maxina portal tenant admin surface.
 *
 * Mounted at /api/v1/admin/marketplace.
 *
 * Gated by requireTenantAdmin — tenant admins can moderate the shared global
 * catalog (per-tenant via tenant_catalog_overrides) + tune feed defaults,
 * geo policies, and review ingestion runs.
 *
 * 6 Phase-0 screens across 2 sidebar sections:
 *   Catalog:     Overview | Merchants | Products | (Taxonomy Phase 2) | (Feed Curation defaults subset)
 *   Operations:  Ingestion & Coverage | (Affiliate Networks Phase 2) | Geo Policies | (Attribution Phase 2) | (Moderation Phase 2)
 *
 * Data access for the tables this route owns (merchants, products,
 * catalog_sources, product_clicks, product_orders, default_feed_config,
 * geo_policy, marketplace_sources_config, admin_settings) goes through
 * ./admin-marketplace-repository.ts (VTID-03702, Aurora migration B1
 * data-access seam) instead of calling supabase.from(...) directly.
 */

import { Router, Request, Response } from 'express';
import { requireTenantAdmin } from '../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import * as repo from './admin-marketplace-repository';

const router = Router();
const VTID = 'VTID-02000';

function getTenantId(req: Request): string | null {
  const auth = req as AuthenticatedRequest;
  return auth.identity?.tenant_id ?? null;
}
function getUserId(req: Request): string | null {
  const auth = req as AuthenticatedRequest;
  return auth.identity?.user_id ?? null;
}

async function emitAdminActivity(
  tenantId: string | null,
  userId: string | null,
  action: string,
  target: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'assistant.turn', // reuse generic admin-activity channel
      source: 'gateway',
      status: 'info',
      message: `Admin marketplace action: ${action}`,
      payload: { action, tenant_id: tenantId, admin_user_id: userId, target },
    });
  } catch { /* non-fatal */ }
}

// ==================== Catalog: Overview ====================

router.get('/overview', requireTenantAdmin, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const [
    merchantsActive,
    productsActive,
    productsReviewQueue,
    runsRecent,
    clicks24h,
    conversions30d,
  ] = await repo.fetchAdminMarketplaceOverviewStats(supabase);

  const commission_30d_cents = (conversions30d.data ?? []).reduce((a, r) => a + ((r.commission_cents as number) ?? 0), 0);

  res.json({
    ok: true,
    stats: {
      merchants_active: merchantsActive.count ?? 0,
      products_active: productsActive.count ?? 0,
      products_pending_review: productsReviewQueue.count ?? 0,
      clicks_24h: clicks24h.count ?? 0,
      conversions_30d: conversions30d.count ?? 0,
      commission_30d_cents,
    },
    recent_runs: runsRecent.data ?? [],
  });
});

// ==================== Catalog: Merchants ====================

router.get('/merchants', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { source_network, is_active, limit, offset, search } = req.query;
  const { data, error, count } = await repo.listAdminMarketplaceMerchants(supabase, {
    sourceNetwork: source_network ? String(source_network) : undefined,
    isActive: is_active !== undefined ? String(is_active) : undefined,
    search: search ? String(search) : undefined,
    offset: Number(offset ?? 0),
    limit: Number(limit ?? 50),
  });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, items: data ?? [], total: count ?? 0 });
});

router.patch('/merchants/:id', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { id } = req.params;
  const allowed = ['name', 'is_active', 'quality_score', 'customs_risk', 'commission_rate', 'admin_notes', 'requires_admin_review', 'recommendation_commission_eligible', 'recommendation_commission_rate_override'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'No allowed fields to update' });
  const { data, error } = await repo.updateAdminMarketplaceMerchant(supabase, id, patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'merchant.updated', { merchant_id: id, patch });
  res.json({ ok: true, merchant: data });
});

// ==================== Catalog: Products review queue ====================

router.get('/products', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { requires_admin_review, is_active, source_network, category, origin_region, limit, offset, search } = req.query;
  const { data, error, count } = await repo.listAdminMarketplaceProducts(supabase, {
    requiresAdminReview: requires_admin_review !== undefined ? String(requires_admin_review) : undefined,
    isActive: is_active !== undefined ? String(is_active) : undefined,
    sourceNetwork: source_network ? String(source_network) : undefined,
    category: category ? String(category) : undefined,
    originRegion: origin_region ? String(origin_region) : undefined,
    search: search ? String(search) : undefined,
    offset: Number(offset ?? 0),
    limit: Number(limit ?? 50),
  });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, items: data ?? [], total: count ?? 0 });
});

router.patch('/products/:id', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { id } = req.params;
  const allowed = ['title', 'description', 'is_active', 'requires_admin_review', 'admin_review_reason', 'admin_notes', 'excluded_from_regions', 'customs_risk'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'No allowed fields to update' });
  const { data, error } = await repo.updateAdminMarketplaceProduct(supabase, id, patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'product.updated', { product_id: id, patch });
  res.json({ ok: true, product: data });
});

router.post('/products/bulk-action', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { product_ids, action, reason } = req.body as { product_ids: string[]; action: string; reason?: string };
  if (!Array.isArray(product_ids) || product_ids.length === 0) return res.status(400).json({ ok: false, error: 'product_ids required' });
  if (product_ids.length > 100) return res.status(400).json({ ok: false, error: 'Max 100 products per bulk action' });

  let patch: Record<string, unknown>;
  switch (action) {
    case 'hide':
      patch = { is_active: false, admin_review_reason: reason ?? 'Admin hide via bulk action' };
      break;
    case 'clear_review':
      patch = { requires_admin_review: false, admin_review_reason: null };
      break;
    case 'flag_review':
      patch = { requires_admin_review: true, admin_review_reason: reason ?? 'Flagged by admin' };
      break;
    case 'deactivate':
      patch = { is_active: false };
      break;
    case 'reactivate':
      patch = { is_active: true, admin_review_reason: null };
      break;
    default:
      return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  }

  const { data, error } = await repo.bulkUpdateAdminMarketplaceProducts(supabase, product_ids, patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const updated = data?.length ?? 0;
  await emitAdminActivity(getTenantId(req), getUserId(req), `products.bulk_${action}`, { count: updated, product_ids: product_ids.slice(0, 10), reason: reason ?? null });
  res.json({ ok: true, updated });
});

// ==================== Catalog: Feed Curation (defaults subset) ====================

router.get('/feed-curation', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  // Return tenant-scoped configs + platform-wide defaults (as fallback view)
  const { data, error } = await repo.fetchAdminMarketplaceFeedCurationConfigs(supabase, tenantId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, configs: data ?? [] });
});

router.patch('/feed-curation/:id', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { id } = req.params;
  const allowed = ['featured_product_ids', 'category_mix', 'max_products_per_merchant', 'max_products_per_category', 'starter_conditions', 'personalization_weight_override', 'diversity_rules', 'notes'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'No allowed fields to update' });
  patch.updated_by = getUserId(req) ?? 'admin';
  const { data, error } = await repo.updateAdminMarketplaceFeedCurationConfig(supabase, id, patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'feed_config.updated', { config_id: id, patch });
  res.json({ ok: true, config: data });
});

// ==================== Operations: Ingestion & Coverage ====================

router.get('/ingestion/runs', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { source_network, limit, offset } = req.query;
  const { data, error, count } = await repo.listAdminMarketplaceIngestionRuns(supabase, {
    sourceNetwork: source_network ? String(source_network) : undefined,
    offset: Number(offset ?? 0),
    limit: Number(limit ?? 50),
  });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, runs: data ?? [], total: count ?? 0 });
});

router.get('/ingestion/coverage', requireTenantAdmin, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  // Compute origin_region × ships_to_region matrix
  const { data, error } = await repo.fetchAdminMarketplaceIngestionCoverage(supabase);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const matrix: Record<string, Record<string, number>> = {};
  const regions = ['EU', 'UK', 'US', 'CA', 'LATAM', 'MENA', 'APAC_JP_KR_TW', 'APAC_CN', 'APAC_SEA', 'APAC_IN', 'AFRICA', 'OCEANIA', 'OTHER'];
  for (const r of regions) matrix[r] = {};
  for (const row of data ?? []) {
    const origin = row.origin_region ?? 'OTHER';
    const ships = (row.ships_to_regions as string[] | null) ?? [];
    for (const s of ships) {
      if (!matrix[origin]) matrix[origin] = {};
      matrix[origin][s] = (matrix[origin][s] ?? 0) + 1;
    }
  }
  res.json({ ok: true, matrix, regions });
});

// ==================== Operations: Geo Policies ====================

router.get('/geo-policy', requireTenantAdmin, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data, error } = await repo.listAdminMarketplaceGeoPolicies(supabase);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, policies: data ?? [] });
});

router.patch('/geo-policy/:id', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { id } = req.params;
  const allowed = ['is_active', 'weight', 'user_opt_out_scope', 'description'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'No allowed fields to update' });
  const { data, error } = await repo.updateAdminMarketplaceGeoPolicy(supabase, id, patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'geo_policy.updated', { policy_id: id, patch });
  res.json({ ok: true, policy: data });
});

// ==================== VTID-01930: Provider registry ====================

// Drives the Command Hub "Add shop" dropdown + form. Adding a new provider
// requires zero frontend changes — the form is generated from config_schema.
router.get('/providers', requireTenantAdmin, async (_req: Request, res: Response) => {
  const { listProviders } = await import('../services/marketplace-sync/providers');
  const providers = listProviders().map((p) => ({
    key: p.key,
    display_name: p.displayName,
    description: p.description,
    config_schema: p.configSchema,
  }));
  res.json({ ok: true, providers });
});

// ==================== Awin feed discovery ====================

// Removes the manual "look up each feed_id in the Awin dashboard" step. Lists
// every product datafeed the publisher's API key can download and returns a
// ready-to-save source config (paste into POST /sources, or save in the
// Command Hub "Add Awin source" form). The moment a health advertiser approval
// lands, it shows up here and is one save away from flowing onto /discover.
//
// Key resolution: ?api_key= query > an existing saved awin source > env
// (AWIN_DATAFEED_API_KEY, then AWIN_API_TOKEN as a last resort).
router.get('/awin/feeds', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  let apiKey = typeof req.query.api_key === 'string' ? req.query.api_key : '';
  let publisherId =
    typeof req.query.publisher_id === 'string' && req.query.publisher_id
      ? req.query.publisher_id
      : process.env.AWIN_PUBLISHER_ID || '';

  if (!apiKey && supabase) {
    const { data } = await repo.fetchAdminMarketplaceAwinSourceConfig(supabase);
    const cfg = data?.[0]?.config as { api_key?: string; publisher_id?: string } | undefined;
    if (cfg?.api_key) apiKey = cfg.api_key;
    if (!publisherId && cfg?.publisher_id) publisherId = cfg.publisher_id;
  }
  if (!apiKey) apiKey = process.env.AWIN_DATAFEED_API_KEY || process.env.AWIN_API_TOKEN || '';
  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error: 'No Awin datafeed API key. Pass ?api_key=, save an Awin source first, or set AWIN_DATAFEED_API_KEY.',
    });
  }

  const joinedOnly = req.query.joined_only === 'true' || req.query.joined_only === '1';
  try {
    const { listAwinFeeds } = await import('../services/marketplace-sync/awin-sync');
    const feeds = await listAwinFeeds(apiKey, { joinedOnly });
    const suggested_config = {
      api_key: apiKey,
      publisher_id: publisherId || null,
      feeds: feeds.map((f) => ({
        feed_id: f.feed_id,
        advertiser_id: f.advertiser_id,
        advertiser_name: f.advertiser_name,
      })),
      max_products_per_feed: 500,
    };
    res.json({ ok: true, count: feeds.length, feeds, suggested_config });
  } catch (e: unknown) {
    res.status(502).json({ ok: false, error: String((e instanceof Error ? e.message : e)) });
  }
});

// ==================== VTID-02200: Sources (Shopify + CJ + etc) ====================

router.get('/sources', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { source_network } = req.query;
  const { data, error } = await repo.listAdminMarketplaceSources(supabase, source_network ? String(source_network) : undefined);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, sources: data ?? [] });
});

router.post('/sources', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const allowed = ['source_network', 'display_name', 'config', 'tenant_id', 'is_active', 'notes'];
  const payload: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) payload[k] = req.body[k];
  if (!payload.source_network || !payload.display_name || !payload.config) {
    return res.status(400).json({ ok: false, error: 'source_network, display_name, config required' });
  }
  // VTID-01930: reject unknown providers + run provider-level validateConfig
  const { getProvider } = await import('../services/marketplace-sync/providers');
  const provider = getProvider(String(payload.source_network));
  if (!provider) {
    return res.status(400).json({ ok: false, error: `Unknown source_network: ${payload.source_network}` });
  }
  if (provider.validateConfig) {
    const validation = provider.validateConfig(payload.config as Record<string, unknown>);
    if (!validation.ok) {
      return res.status(400).json({ ok: false, error: `Invalid ${provider.key} config: ${validation.error}` });
    }
  }
  payload.created_by = getUserId(req) ?? null;
  const { data, error } = await repo.insertAdminMarketplaceSource(supabase, payload);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'marketplace_source.created', { source_id: data.id, source_network: data.source_network });
  res.json({ ok: true, source: data });
});

router.patch('/sources/:id', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const allowed = ['display_name', 'config', 'is_active', 'notes'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'No allowed fields to update' });
  const { data, error } = await repo.updateAdminMarketplaceSource(supabase, req.params.id, patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'marketplace_source.updated', { source_id: req.params.id, patch });
  res.json({ ok: true, source: data });
});

// Manual sync trigger — runs in-process, returns the result once done.
// Supported networks come from the provider registry.
router.post('/sync/:network', requireTenantAdmin, async (req: Request, res: Response) => {
  const network = req.params.network;
  const { providerKeys } = await import('../services/marketplace-sync/providers');
  const supported = providerKeys();
  if (!supported.includes(network)) {
    return res.status(400).json({
      ok: false,
      error: `Unsupported network: ${network}. Use one of: ${supported.join(', ')}.`,
    });
  }
  try {
    const { runMarketplaceSyncSource } = await import('../services/marketplace-sync');
    const result = await runMarketplaceSyncSource(network, `admin:${getUserId(req) ?? 'unknown'}`);
    await emitAdminActivity(getTenantId(req), getUserId(req), 'marketplace_sync.triggered', { network, totals: result.totals });
    res.json({ ok: true, network, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// Manual Awin order-conversion sync trigger (VTID-02950) — distinct from
// /sync/:network above (which pulls the product catalog); this pulls real
// purchase conversions and credits recommendation commissions.
router.post('/sync-orders/awin', requireTenantAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emitAdminActivity() below wraps emitOasisEvent —
  // the static impact-scan can't see through the indirection.
  try {
    const { runAwinOrderSync } = await import('../services/marketplace-sync/awin-order-sync');
    const lookbackDays = Number(req.body?.lookback_days) || 30;
    const result = await runAwinOrderSync(lookbackDays);
    await emitAdminActivity(getTenantId(req), getUserId(req), 'awin_order_sync.triggered', { result });
    res.json({ ok: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

router.post('/geo-policy', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const allowed = ['user_region', 'rule_type', 'applies_to_origin', 'applies_to_tag', 'weight', 'user_opt_out_scope', 'description'];
  const payload: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) payload[k] = req.body[k];
  if (!payload.user_region || !payload.rule_type) return res.status(400).json({ ok: false, error: 'user_region + rule_type required' });
  const { data, error } = await repo.insertAdminMarketplaceGeoPolicy(supabase, payload);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'geo_policy.created', { policy_id: data.id, payload });
  res.json({ ok: true, policy: data });
});

// ==================== Operations: Recommendation commission settings (VTID-02950) ====================

router.get('/commission-settings', requireTenantAdmin, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data, error } = await repo.fetchAdminMarketplaceCommissionSetting(supabase);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const rate = (data?.value as { rate?: number } | undefined)?.rate ?? 0.2;
  res.json({ ok: true, default_rate: rate, updated_at: data?.updated_at ?? null });
});

router.patch('/commission-settings', requireTenantAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emitAdminActivity() below wraps emitOasisEvent —
  // the static impact-scan can't see through the indirection.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const rate = Number(req.body?.default_rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
    return res.status(400).json({ ok: false, error: 'default_rate must be a number between 0 and 1' });
  }
  const { error } = await repo.upsertAdminMarketplaceCommissionSetting(supabase, { rate }, getUserId(req));
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'commission_settings.updated', { default_rate: rate });
  res.json({ ok: true, default_rate: rate });
});

export default router;
