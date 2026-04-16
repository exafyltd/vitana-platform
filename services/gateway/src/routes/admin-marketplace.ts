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
 */

import { Router, Request, Response } from 'express';
import { requireTenantAdmin } from '../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';

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
  ] = await Promise.all([
    supabase.from('merchants').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('requires_admin_review', true).eq('is_active', true),
    supabase.from('catalog_sources').select('run_id, source_network, started_at, finished_at, products_inserted, products_updated, errors').order('started_at', { ascending: false }).limit(10),
    supabase.from('product_clicks').select('id', { count: 'exact', head: true }).gte('clicked_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    supabase.from('product_orders').select('id, commission_cents', { count: 'exact' }).gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()).eq('state', 'converted'),
  ]);

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
  let q = supabase.from('merchants').select('*', { count: 'exact' });
  if (source_network) q = q.eq('source_network', String(source_network));
  if (is_active !== undefined) q = q.eq('is_active', String(is_active) === 'true');
  if (search) q = q.ilike('name', `%${search}%`);
  q = q.order('created_at', { ascending: false }).range(Number(offset ?? 0), Number(offset ?? 0) + Number(limit ?? 50) - 1);
  const { data, error, count } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, items: data ?? [], total: count ?? 0 });
});

router.patch('/merchants/:id', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { id } = req.params;
  const allowed = ['name', 'is_active', 'quality_score', 'customs_risk', 'commission_rate', 'admin_notes', 'requires_admin_review'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'No allowed fields to update' });
  const { data, error } = await supabase.from('merchants').update(patch).eq('id', id).select().single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'merchant.updated', { merchant_id: id, patch });
  res.json({ ok: true, merchant: data });
});

// ==================== Catalog: Products review queue ====================

router.get('/products', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { requires_admin_review, is_active, source_network, category, origin_region, limit, offset, search } = req.query;
  let q = supabase.from('products').select('id, title, brand, category, subcategory, price_cents, currency, origin_country, origin_region, source_network, source_product_id, rating, availability, requires_admin_review, admin_review_reason, analyzer_confidence, is_active, ingested_at, last_seen_at, merchant_id', { count: 'exact' });
  if (requires_admin_review !== undefined) q = q.eq('requires_admin_review', String(requires_admin_review) === 'true');
  if (is_active !== undefined) q = q.eq('is_active', String(is_active) === 'true');
  if (source_network) q = q.eq('source_network', String(source_network));
  if (category) q = q.eq('category', String(category));
  if (origin_region) q = q.eq('origin_region', String(origin_region));
  if (search) q = q.ilike('title', `%${search}%`);
  q = q.order('ingested_at', { ascending: false }).range(Number(offset ?? 0), Number(offset ?? 0) + Number(limit ?? 50) - 1);
  const { data, error, count } = await q;
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
  const { data, error } = await supabase.from('products').update(patch).eq('id', id).select().single();
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

  const { data, error } = await supabase.from('products').update(patch).in('id', product_ids).select('id');
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
  const { data, error } = await supabase
    .from('default_feed_config')
    .select('*')
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    .eq('is_active', true)
    .order('region_group', { ascending: true })
    .order('lifecycle_stage', { ascending: true });
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
  const { data, error } = await supabase.from('default_feed_config').update(patch).eq('id', id).select().single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'feed_config.updated', { config_id: id, patch });
  res.json({ ok: true, config: data });
});

// ==================== Operations: Ingestion & Coverage ====================

router.get('/ingestion/runs', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { source_network, limit, offset } = req.query;
  let q = supabase.from('catalog_sources').select('*', { count: 'exact' });
  if (source_network) q = q.eq('source_network', String(source_network));
  q = q.order('started_at', { ascending: false }).range(Number(offset ?? 0), Number(offset ?? 0) + Number(limit ?? 50) - 1);
  const { data, error, count } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, runs: data ?? [], total: count ?? 0 });
});

router.get('/ingestion/coverage', requireTenantAdmin, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  // Compute origin_region × ships_to_region matrix
  const { data, error } = await supabase
    .from('products')
    .select('origin_region, ships_to_regions')
    .eq('is_active', true);
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
  const { data, error } = await supabase
    .from('geo_policy')
    .select('*')
    .order('user_region', { ascending: true })
    .order('rule_type', { ascending: true });
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
  const { data, error } = await supabase.from('geo_policy').update(patch).eq('id', id).select().single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'geo_policy.updated', { policy_id: id, patch });
  res.json({ ok: true, policy: data });
});

router.post('/geo-policy', requireTenantAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const allowed = ['user_region', 'rule_type', 'applies_to_origin', 'applies_to_tag', 'weight', 'user_opt_out_scope', 'description'];
  const payload: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) payload[k] = req.body[k];
  if (!payload.user_region || !payload.rule_type) return res.status(400).json({ ok: false, error: 'user_region + rule_type required' });
  const { data, error } = await supabase.from('geo_policy').insert(payload).select().single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  await emitAdminActivity(getTenantId(req), getUserId(req), 'geo_policy.created', { policy_id: data.id, payload });
  res.json({ ok: true, policy: data });
});

export default router;
