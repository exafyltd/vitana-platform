/**
 * VTID-02200: Shopify Storefront GraphQL sync.
 *
 * Reads configured partner shops from the marketplace_sources_config table
 * (or the SHOPIFY_SHOPS env var as a bootstrap), fetches public product
 * catalogs via the Storefront API, normalizes, upserts.
 *
 * Storefront API is read-only, uses a per-shop "public access token"
 * (shopify.dev/docs/api/storefront). No OAuth required for public catalogs.
 *
 * Config shape (JSON array in SHOPIFY_SHOPS env or marketplace_sources_config.config):
 *   {
 *     "domain": "acme.myshopify.com",
 *     "storefront_access_token": "...",
 *     "merchant_name": "ACME Wellness",
 *     "merchant_country": "DE",
 *     "ships_to_regions": ["EU","UK"],
 *     "commission_rate": 0.10,
 *     "affiliate_url_template": "https://acme.myshopify.com/products/{handle}?ref=vitana"
 *   }
 */

import { getSupabase } from '../../lib/supabase';
import {
  startSyncRun,
  finishSyncRun,
  upsertMerchant,
  upsertProducts,
  deriveRegionGroup,
  type ProductUpsert,
} from './shared';

interface ShopifyShopConfig {
  domain: string;
  storefront_access_token: string;
  merchant_name: string;
  merchant_country?: string;
  ships_to_countries?: string[];
  ships_to_regions?: string[];
  commission_rate?: number;
  quality_score?: number;
  affiliate_url_template?: string;   // optional; defaults to product URL with ?ref=vitana
  currency?: string;                  // override if needed; normally derived from product
  health_goals_by_collection?: Record<string, string[]>; // optional collection → health_goals map
  dietary_tags_by_collection?: Record<string, string[]>; // optional collection → dietary_tags map
}

const SHOPIFY_API_VERSION = '2024-10';

async function loadShopConfigs(): Promise<ShopifyShopConfig[]> {
  // 1. Check DB-managed configs
  const supabase = getSupabase();
  if (supabase) {
    const { data } = await supabase
      .from('marketplace_sources_config')
      .select('config')
      .eq('source_network', 'shopify')
      .eq('is_active', true);
    if (data && data.length > 0) {
      return data
        .map((r) => r.config as ShopifyShopConfig)
        .filter((c) => c && c.domain && c.storefront_access_token && c.merchant_name);
    }
  }
  // 2. Fall back to env var
  const envRaw = process.env.SHOPIFY_SHOPS;
  if (!envRaw) return [];
  try {
    const parsed = JSON.parse(envRaw);
    if (Array.isArray(parsed)) return parsed as ShopifyShopConfig[];
  } catch (err) {
    console.warn('[shopify-sync] SHOPIFY_SHOPS env var is not valid JSON:', err);
  }
  return [];
}

// ==================== GraphQL query ====================

const PRODUCTS_QUERY = `
query Products($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        handle
        title
        descriptionHtml
        vendor
        productType
        tags
        totalInventory
        availableForSale
        featuredImage { url altText }
        images(first: 4) { edges { node { url altText } } }
        priceRange {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        compareAtPriceRange {
          minVariantPrice { amount currencyCode }
        }
        onlineStoreUrl
        collections(first: 10) { edges { node { handle title } } }
      }
    }
  }
}
`;

interface ShopifyProductNode {
  id: string;
  handle: string;
  title: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  availableForSale?: boolean;
  totalInventory?: number;
  featuredImage?: { url: string; altText?: string | null } | null;
  images?: { edges: Array<{ node: { url: string; altText?: string | null } }> };
  priceRange: { minVariantPrice: { amount: string; currencyCode: string }; maxVariantPrice: { amount: string; currencyCode: string } };
  compareAtPriceRange?: { minVariantPrice: { amount: string; currencyCode: string } };
  onlineStoreUrl?: string | null;
  collections?: { edges: Array<{ node: { handle: string; title: string } }> };
}

interface ShopifyProductsResp {
  data?: {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: ShopifyProductNode }>;
    };
  };
  errors?: Array<{ message: string }>;
}

async function fetchShopifyProducts(
  shop: ShopifyShopConfig,
  cursor: string | null = null
): Promise<ShopifyProductsResp> {
  const resp = await fetch(`https://${shop.domain}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': shop.storefront_access_token,
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Shopify ${shop.domain} HTTP ${resp.status} ${text}`);
  }
  return (await resp.json()) as ShopifyProductsResp;
}

function dollarsToCents(amountStr: string): number {
  const n = parseFloat(amountStr);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined;
}

function normalizeShopifyProduct(
  node: ShopifyProductNode,
  shop: ShopifyShopConfig,
  merchantId: string
): ProductUpsert {
  const priceAmount = node.priceRange?.minVariantPrice?.amount ?? '0';
  const currency = (node.priceRange?.minVariantPrice?.currencyCode ?? shop.currency ?? 'USD').toUpperCase();
  const compareAt = node.compareAtPriceRange?.minVariantPrice?.amount;

  const images: string[] = [];
  if (node.featuredImage?.url) images.push(node.featuredImage.url);
  for (const e of node.images?.edges ?? []) {
    if (e.node.url && !images.includes(e.node.url)) images.push(e.node.url);
  }

  // Derive health_goals + dietary_tags from collections + tags
  const healthGoals = new Set<string>();
  const dietaryTags = new Set<string>();
  const collectionHandles = (node.collections?.edges ?? []).map((e) => e.node.handle.toLowerCase());
  for (const h of collectionHandles) {
    if (shop.health_goals_by_collection?.[h]) {
      for (const g of shop.health_goals_by_collection[h]) healthGoals.add(g);
    }
    if (shop.dietary_tags_by_collection?.[h]) {
      for (const d of shop.dietary_tags_by_collection[h]) dietaryTags.add(d);
    }
  }
  // Tag-based dietary inference (common Shopify conventions)
  const tagsLower = (node.tags ?? []).map((t) => t.toLowerCase());
  const DIETARY_TAGS = ['vegan', 'vegetarian', 'gluten-free', 'dairy-free', 'nut-free', 'soy-free', 'sugar-free', 'organic', 'non-gmo', 'halal', 'kosher', 'keto-friendly'];
  for (const d of DIETARY_TAGS) {
    if (tagsLower.includes(d) || tagsLower.includes(d.replace('-', ''))) dietaryTags.add(d);
  }

  const affiliateUrl = shop.affiliate_url_template
    ? shop.affiliate_url_template.replace('{handle}', node.handle)
    : node.onlineStoreUrl ?? `https://${shop.domain}/products/${node.handle}`;

  return {
    merchant_id: merchantId,
    source_network: 'shopify',
    source_product_id: node.id,
    sku: node.handle,
    title: node.title,
    description: stripHtml(node.descriptionHtml),
    brand: node.vendor,
    category: 'supplements', // Phase 2 MVP assumption — admin can override in review queue
    subcategory: node.productType,
    topic_keys: node.tags ?? [],
    price_cents: dollarsToCents(priceAmount),
    currency,
    compare_at_price_cents: compareAt ? dollarsToCents(compareAt) : undefined,
    images,
    affiliate_url: affiliateUrl,
    availability: node.availableForSale === false || node.totalInventory === 0 ? 'out_of_stock' : 'in_stock',
    origin_country: shop.merchant_country,
    ships_to_countries: shop.ships_to_countries,
    ships_to_regions: shop.ships_to_regions,
    health_goals: Array.from(healthGoals),
    dietary_tags: Array.from(dietaryTags),
    raw: node as unknown as Record<string, unknown>,
  };
}

// ==================== Per-shop sync ====================

async function syncOneShop(shop: ShopifyShopConfig): Promise<{ inserted: number; updated: number; skipped: number; errors: number; error_sample: unknown[] }> {
  const merchantId = await upsertMerchant({
    source_network: 'shopify',
    source_merchant_id: shop.domain,
    name: shop.merchant_name,
    slug: shop.domain.replace('.myshopify.com', ''),
    storefront_url: `https://${shop.domain}`,
    merchant_country: shop.merchant_country,
    ships_to_countries: shop.ships_to_countries,
    ships_to_regions: shop.ships_to_regions,
    affiliate_network: 'shopify',
    commission_rate: shop.commission_rate,
    quality_score: shop.quality_score ?? 70,
    customs_risk: shop.merchant_country ? 'low' : 'unknown',
  });

  if (!merchantId) {
    return { inserted: 0, updated: 0, skipped: 0, errors: 1, error_sample: [{ shop: shop.domain, error: 'merchant upsert failed' }] };
  }

  // Derive ships_to_regions from ships_to_countries if missing
  if (!shop.ships_to_regions && shop.ships_to_countries?.length) {
    const regions = new Set(shop.ships_to_countries.map((c) => deriveRegionGroup(c)));
    shop.ships_to_regions = Array.from(regions);
  }

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  const errors: unknown[] = [];
  let cursor: string | null = null;
  let pageCount = 0;

  while (pageCount < 50) { // hard cap: 50 pages × 50 = 2500 products per shop per run
    let resp: ShopifyProductsResp;
    try {
      resp = await fetchShopifyProducts(shop, cursor);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ shop: shop.domain, cursor, error: message });
      break;
    }
    if (resp.errors?.length) {
      errors.push({ shop: shop.domain, cursor, errors: resp.errors });
      break;
    }
    const edges = resp.data?.products.edges ?? [];
    if (edges.length === 0) break;

    const products = edges.map((e) => normalizeShopifyProduct(e.node, shop, merchantId));
    const result = await upsertProducts(products, 'shopify');

    totalInserted += result.inserted;
    totalUpdated += result.updated;
    totalSkipped += result.skipped_unchanged;
    if (result.errors.length) errors.push(...result.errors);

    const pageInfo = resp.data?.products.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
    pageCount++;
  }

  return { inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped, errors: errors.length, error_sample: errors.slice(0, 10) };
}

// ==================== Entry point ====================

export interface ShopifySyncResult {
  ok: boolean;
  shops_synced: number;
  totals: { inserted: number; updated: number; skipped: number; errors: number };
  per_shop: Array<{ domain: string; inserted: number; updated: number; skipped: number; errors: number }>;
  duration_ms: number;
}

export async function runShopifySync(triggered_by = 'scheduler'): Promise<ShopifySyncResult> {
  const startTime = Date.now();
  const shops = await loadShopConfigs();
  if (shops.length === 0) {
    console.log('[shopify-sync] no shops configured — skipping');
    return {
      ok: true,
      shops_synced: 0,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 0 },
      per_shop: [],
      duration_ms: Date.now() - startTime,
    };
  }

  const run = await startSyncRun('shopify', triggered_by);
  const per_shop: ShopifySyncResult['per_shop'] = [];
  const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

  for (const shop of shops) {
    const stats = await syncOneShop(shop);
    per_shop.push({
      domain: shop.domain,
      inserted: stats.inserted,
      updated: stats.updated,
      skipped: stats.skipped,
      errors: stats.errors,
    });
    totals.inserted += stats.inserted;
    totals.updated += stats.updated;
    totals.skipped += stats.skipped;
    totals.errors += stats.errors;
  }

  if (run) await finishSyncRun(run, totals);

  const duration_ms = Date.now() - startTime;
  console.log(`[shopify-sync] done in ${duration_ms}ms — ${totals.inserted} inserted, ${totals.updated} updated, ${totals.skipped} skipped, ${totals.errors} errors across ${shops.length} shops`);

  return { ok: totals.errors === 0, shops_synced: shops.length, totals, per_shop, duration_ms };
}
