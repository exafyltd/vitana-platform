/**
 * Admin voice tools — Marketplace Admin (Wave 3, plan section B6).
 *
 * Thin dispatch layer over routes/admin-marketplace.ts, mounted at
 * /api/v1/admin/marketplace, gated by requireTenantAdmin. No route-level
 * confirm tokens exist server-side — two-step confirm is applied here for
 * every ⚠ write, mirroring dev_approve_pr's pattern.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit } from './developer-tools';
import { adminGate, authHeaders, NO_ADMIN_SESSION } from './admin-users-rbac-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const BASE = '/api/v1/admin/marketplace';
const SYNC_NETWORKS = ['shopify', 'cj', 'amazon', 'rakuten', 'awin', 'admitad'];

// ---------------------------------------------------------------------------
// 1. admin_marketplace_overview — GET /overview
// ---------------------------------------------------------------------------

export const admin_marketplace_overview: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall(`${BASE}/overview`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_marketplace_overview failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: 'Marketplace overview retrieved.' };
};

// ---------------------------------------------------------------------------
// 2. admin_list_merchants — GET /merchants
// ---------------------------------------------------------------------------

export const admin_list_merchants: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams({ limit: String(clampLimit(args.limit, 20, 200)) });
  for (const k of ['source_network', 'search'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  if (typeof args.is_active === 'boolean') qs.set('is_active', String(args.is_active));
  const { ok, status, body } = await gatewayApiCall(`${BASE}/merchants?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_merchants failed (${status}): ${String(body.error ?? 'unknown')}` };
  const merchants = (Array.isArray((body as Record<string, unknown>).merchants) ? (body as Record<string, unknown>).merchants : []) as Array<{ name: string; is_active?: boolean }>;
  if (merchants.length === 0) return { ok: true, result: { merchants: [] }, text: 'No merchants matched.' };
  return { ok: true, result: { merchants }, text: `${merchants.length} merchants: ${merchants.slice(0, 8).map((m) => m.name).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 3. admin_update_merchant — PATCH /merchants/:id
// ---------------------------------------------------------------------------

export const admin_update_merchant: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const merchantId = String(args.merchant_id ?? '').trim();
  if (!merchantId) return { ok: false, error: 'admin_update_merchant requires merchant_id.' };
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'is_active', 'quality_score', 'customs_risk', 'commission_rate', 'admin_notes', 'requires_admin_review'] as const) {
    if (args[k] !== undefined) patch[k] = args[k];
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'admin_update_merchant requires at least one field to change.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, merchant_id: merchantId, patch },
      text: `About to update merchant ${merchantId}: ${JSON.stringify(patch)}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`${BASE}/merchants/${encodeURIComponent(merchantId)}`, {
    method: 'PATCH',
    headers: authHeaders(id),
    body: patch,
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update merchant ${merchantId}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Merchant ${merchantId} updated.` };
};

// ---------------------------------------------------------------------------
// 4. admin_list_products — GET /products
// ---------------------------------------------------------------------------

export const admin_list_products: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams({ limit: String(clampLimit(args.limit, 20, 200)) });
  for (const k of ['source_network', 'category', 'origin_region', 'search'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  if (typeof args.requires_admin_review === 'boolean') qs.set('requires_admin_review', String(args.requires_admin_review));
  if (typeof args.is_active === 'boolean') qs.set('is_active', String(args.is_active));
  const { ok, status, body } = await gatewayApiCall(`${BASE}/products?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_products failed (${status}): ${String(body.error ?? 'unknown')}` };
  const products = (Array.isArray((body as Record<string, unknown>).products) ? (body as Record<string, unknown>).products : []) as Array<{ title: string }>;
  if (products.length === 0) return { ok: true, result: { products: [] }, text: 'No products matched.' };
  return { ok: true, result: { products }, text: `${products.length} products: ${products.slice(0, 8).map((p) => p.title).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 5. admin_update_product — PATCH /products/:id
// ---------------------------------------------------------------------------

export const admin_update_product: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const productId = String(args.product_id ?? '').trim();
  if (!productId) return { ok: false, error: 'admin_update_product requires product_id.' };
  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'is_active', 'requires_admin_review', 'admin_review_reason', 'admin_notes', 'excluded_from_regions', 'customs_risk'] as const) {
    if (args[k] !== undefined) patch[k] = args[k];
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'admin_update_product requires at least one field to change.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, product_id: productId, patch },
      text: `About to update product ${productId}: ${JSON.stringify(patch)}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`${BASE}/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    headers: authHeaders(id),
    body: patch,
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update product ${productId}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Product ${productId} updated.` };
};

// ---------------------------------------------------------------------------
// 6. admin_bulk_product_action — POST /products/bulk-action
// ---------------------------------------------------------------------------

const BULK_ACTIONS = ['hide', 'clear_review', 'flag_review', 'deactivate', 'reactivate'];

export const admin_bulk_product_action: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const productIds = Array.isArray(args.product_ids) ? (args.product_ids as string[]) : [];
  const action = String(args.action ?? '').trim();
  if (productIds.length === 0 || !BULK_ACTIONS.includes(action)) {
    return { ok: false, error: `admin_bulk_product_action requires product_ids and action (one of ${BULK_ACTIONS.join(', ')}).` };
  }
  if (productIds.length > 100) return { ok: false, error: 'admin_bulk_product_action supports at most 100 product_ids per call.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, count: productIds.length, action },
      text: `About to ${action} ${productIds.length} products. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`${BASE}/products/bulk-action`, {
    method: 'POST',
    headers: authHeaders(id),
    body: { product_ids: productIds, action, reason: typeof args.reason === 'string' ? args.reason : undefined },
  });
  if (!ok) return { ok: true, result: { done: false, status, detail: body }, text: `Bulk action failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { done: true, detail: body }, text: `${action} applied to ${productIds.length} products.` };
};

// ---------------------------------------------------------------------------
// 7. admin_get_feed_curation — GET /feed-curation
// ---------------------------------------------------------------------------

export const admin_get_feed_curation: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall(`${BASE}/feed-curation`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_get_feed_curation failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: 'Feed curation config retrieved.' };
};

// ---------------------------------------------------------------------------
// 8. admin_update_feed_curation — PATCH /feed-curation/:id
// ---------------------------------------------------------------------------

export const admin_update_feed_curation: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const configId = String(args.config_id ?? '').trim();
  if (!configId) return { ok: false, error: 'admin_update_feed_curation requires config_id.' };
  const patch: Record<string, unknown> = {};
  for (const k of ['featured_product_ids', 'category_mix', 'max_products_per_merchant', 'max_products_per_category', 'starter_conditions', 'personalization_weight_override', 'diversity_rules', 'notes'] as const) {
    if (args[k] !== undefined) patch[k] = args[k];
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'admin_update_feed_curation requires at least one field to change.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, config_id: configId, patch },
      text: `About to update feed curation config ${configId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`${BASE}/feed-curation/${encodeURIComponent(configId)}`, {
    method: 'PATCH',
    headers: authHeaders(id),
    body: patch,
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update feed curation: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Feed curation config ${configId} updated.` };
};

// ---------------------------------------------------------------------------
// 9. admin_list_geo_policies — GET /geo-policy
// ---------------------------------------------------------------------------

export const admin_list_geo_policies: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall(`${BASE}/geo-policy`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_geo_policies failed (${status}): ${String(body.error ?? 'unknown')}` };
  const policies = (Array.isArray((body as Record<string, unknown>).policies) ? (body as Record<string, unknown>).policies : Array.isArray(body) ? body : []) as Array<{ user_region: string; rule_type: string }>;
  if (policies.length === 0) return { ok: true, result: { policies: [] }, text: 'No geo policies configured.' };
  return { ok: true, result: { policies }, text: `${policies.length} geo policies: ${policies.slice(0, 8).map((p) => `${p.user_region}/${p.rule_type}`).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 10. admin_update_geo_policy — PATCH /geo-policy/:id
// ---------------------------------------------------------------------------

export const admin_update_geo_policy: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const policyId = String(args.policy_id ?? '').trim();
  if (!policyId) return { ok: false, error: 'admin_update_geo_policy requires policy_id.' };
  const patch: Record<string, unknown> = {};
  for (const k of ['is_active', 'weight', 'user_opt_out_scope', 'description'] as const) {
    if (args[k] !== undefined) patch[k] = args[k];
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'admin_update_geo_policy requires at least one field to change.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, policy_id: policyId, patch },
      text: `About to update geo policy ${policyId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`${BASE}/geo-policy/${encodeURIComponent(policyId)}`, {
    method: 'PATCH',
    headers: authHeaders(id),
    body: patch,
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update geo policy: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Geo policy ${policyId} updated.` };
};

// ---------------------------------------------------------------------------
// 11. admin_trigger_source_sync — POST /sync/:network
// ---------------------------------------------------------------------------

export const admin_trigger_source_sync: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const network = String(args.network ?? '').trim();
  if (!SYNC_NETWORKS.includes(network)) return { ok: false, error: `admin_trigger_source_sync requires network to be one of ${SYNC_NETWORKS.join(', ')}.` };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, network },
      text: `About to trigger a live product sync from ${network}. This runs synchronously and may take a while. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`${BASE}/sync/${encodeURIComponent(network)}`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { synced: false, status, detail: body }, text: `Sync of ${network} failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { synced: true, detail: body }, text: `Sync of ${network} completed.` };
};

// ---------------------------------------------------------------------------
// 12. admin_get_ingestion_coverage — GET /ingestion/runs + /ingestion/coverage
// ---------------------------------------------------------------------------

export const admin_get_ingestion_coverage: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const view = args.view === 'runs' ? 'runs' : args.view === 'coverage' ? 'coverage' : 'both';
  const calls: Array<Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>> = [];
  if (view === 'runs' || view === 'both') calls.push(gatewayApiCall(`${BASE}/ingestion/runs`, { headers: authHeaders(id) }));
  if (view === 'coverage' || view === 'both') calls.push(gatewayApiCall(`${BASE}/ingestion/coverage`, { headers: authHeaders(id) }));
  const results = await Promise.all(calls);
  const failed = results.find((r) => !r.ok);
  if (failed) return { ok: false, error: `admin_get_ingestion_coverage failed (${failed.status}): ${String(failed.body.error ?? 'unknown')}` };
  const [runs, coverage] = view === 'both' ? results : view === 'runs' ? [results[0], undefined] : [undefined, results[0]];
  return {
    ok: true,
    result: { runs: runs?.body, coverage: coverage?.body },
    text: 'Ingestion runs/coverage retrieved.',
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_MARKETPLACE_TOOL_HANDLERS: Record<string, Handler> = {
  admin_marketplace_overview,
  admin_list_merchants,
  admin_update_merchant,
  admin_list_products,
  admin_update_product,
  admin_bulk_product_action,
  admin_get_feed_curation,
  admin_update_feed_curation,
  admin_list_geo_policies,
  admin_update_geo_policy,
  admin_trigger_source_sync,
  admin_get_ingestion_coverage,
};

export const ADMIN_MARKETPLACE_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'admin_marketplace_overview', description: 'ADMIN ONLY. Marketplace KPIs overview.', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_list_merchants',
    description: 'ADMIN ONLY. List merchants, filterable by source_network/is_active/search.',
    parameters: { type: 'object', properties: { source_network: { type: 'string' }, is_active: { type: 'boolean' }, search: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'admin_update_merchant',
    description: 'ADMIN ONLY. Edit a merchant\'s status/quality/commission/notes. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string', description: 'Required.' },
        name: { type: 'string' }, is_active: { type: 'boolean' }, quality_score: { type: 'number' },
        customs_risk: { type: 'string' }, commission_rate: { type: 'number' }, admin_notes: { type: 'string' },
        requires_admin_review: { type: 'boolean' }, confirm: { type: 'boolean' },
      },
      required: ['merchant_id'],
    },
  },
  {
    name: 'admin_list_products',
    description: 'ADMIN ONLY. List products (admin view), filterable by network/category/region/review-flag/search.',
    parameters: {
      type: 'object',
      properties: {
        source_network: { type: 'string' }, category: { type: 'string' }, origin_region: { type: 'string' },
        search: { type: 'string' }, requires_admin_review: { type: 'boolean' }, is_active: { type: 'boolean' }, limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'admin_update_product',
    description: 'ADMIN ONLY. Edit/approve a product. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Required.' },
        title: { type: 'string' }, description: { type: 'string' }, is_active: { type: 'boolean' },
        requires_admin_review: { type: 'boolean' }, admin_review_reason: { type: 'string' }, admin_notes: { type: 'string' },
        excluded_from_regions: { type: 'array', items: { type: 'string' } }, customs_risk: { type: 'string' }, confirm: { type: 'boolean' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'admin_bulk_product_action',
    description: 'ADMIN ONLY. Bulk enable/disable/flag products (max 100 per call). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        product_ids: { type: 'array', items: { type: 'string' }, description: 'Required, max 100.' },
        action: { type: 'string', description: 'hide, clear_review, flag_review, deactivate, or reactivate. Required.' },
        reason: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['product_ids', 'action'],
    },
  },
  { name: 'admin_get_feed_curation', description: 'ADMIN ONLY. Read the feed curation config.', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_update_feed_curation',
    description: 'ADMIN ONLY. Change feed curation rules. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        config_id: { type: 'string', description: 'Required.' },
        featured_product_ids: { type: 'array', items: { type: 'string' } },
        category_mix: { type: 'object' }, max_products_per_merchant: { type: 'integer' }, max_products_per_category: { type: 'integer' },
        starter_conditions: { type: 'object' }, personalization_weight_override: { type: 'number' }, diversity_rules: { type: 'object' },
        notes: { type: 'string' }, confirm: { type: 'boolean' },
      },
      required: ['config_id'],
    },
  },
  { name: 'admin_list_geo_policies', description: 'ADMIN ONLY. List geo policies.', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_update_geo_policy',
    description: 'ADMIN ONLY. Edit a geo policy. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        policy_id: { type: 'string', description: 'Required.' },
        is_active: { type: 'boolean' }, weight: { type: 'number' }, user_opt_out_scope: { type: 'string' }, description: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['policy_id'],
    },
  },
  {
    name: 'admin_trigger_source_sync',
    description: 'ADMIN ONLY. Trigger a live product sync from a network (runs synchronously). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: { network: { type: 'string', description: 'shopify, cj, amazon, rakuten, awin, or admitad. Required.' }, confirm: { type: 'boolean' } },
      required: ['network'],
    },
  },
  {
    name: 'admin_get_ingestion_coverage',
    description: 'ADMIN ONLY. Ingestion run history and origin/ships-to coverage matrix.',
    parameters: { type: 'object', properties: { view: { type: 'string', description: '"runs", "coverage", or omit for both.' } } },
  },
];
