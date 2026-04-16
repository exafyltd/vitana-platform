/**
 * VTID-02000: Catalog Ingestion Types
 *
 * Authoritative Zod schemas + TypeScript types for the catalog ingestion API.
 * This is the contract that Claude Code (and any other scraper / automated
 * catalog populator) codes against.
 *
 * Design rules:
 *   - Every product MUST carry origin_country, ships_to_countries (or region),
 *     and currency. The server REJECTS rows missing these — no silent nulls.
 *   - Idempotent upsert by (source_network, source_product_id).
 *   - Server derives origin_region + ships_to_regions from country codes
 *     (via get_region_group() SQL function) so scrapers don't need to know
 *     the region taxonomy.
 *   - content_hash drives drift detection — server skips rows with an
 *     unchanged hash, making re-scrapes cheap.
 */

import { z } from 'zod';

// ==================== Enums + shared primitives ====================

export const CountryCode = z
  .string()
  .length(2, 'country_code must be exactly 2 characters (ISO 3166-1 alpha-2)')
  .regex(/^[A-Za-z]{2}$/, 'country_code must be alphabetic')
  .transform((s) => s.toUpperCase());

export const CurrencyCode = z
  .string()
  .length(3, 'currency must be exactly 3 characters (ISO 4217)')
  .regex(/^[A-Za-z]{3}$/, 'currency must be alphabetic')
  .transform((s) => s.toUpperCase());

export const RegionGroup = z.enum([
  'EU',
  'UK',
  'US',
  'CA',
  'LATAM',
  'MENA',
  'APAC_JP_KR_TW',
  'APAC_CN',
  'APAC_SEA',
  'APAC_IN',
  'AFRICA',
  'OCEANIA',
  'OTHER',
]);
export type RegionGroup = z.infer<typeof RegionGroup>;

export const SourceNetwork = z
  .string()
  .min(1)
  .max(64)
  .describe(
    'Source identifier: "cj", "amazon", "shopify", "awin", "rakuten", "direct_scrape", "manual", or a scoped form like "scrape:amazon.de", "shopify:partner-store-slug".'
  );

export const Availability = z.enum([
  'in_stock',
  'out_of_stock',
  'preorder',
  'discontinued',
  'unknown',
]);

export const Form = z.enum([
  'capsule',
  'tablet',
  'powder',
  'liquid',
  'gummy',
  'softgel',
  'spray',
  'other',
]);

export const CheckoutMode = z.enum([
  'affiliate_link',
  'stripe_connect',
  'embedded',
  'manual',
]);

export const CustomsRisk = z.enum(['low', 'medium', 'high', 'unknown']);

// ==================== Ingestion run ====================

export const IngestStartRequestSchema = z.object({
  source_network: SourceNetwork,
  source_url: z.string().url().optional(),
  triggered_by: z
    .string()
    .default('claude_code')
    .describe(
      'Who/what kicked off this run: "claude_code", "cron_cj_daily", "manual_admin", "marketplace_curator_agent".'
    ),
  notes: z.string().max(2000).optional(),
});
export type IngestStartRequest = z.infer<typeof IngestStartRequestSchema>;

export const IngestStartResponseSchema = z.object({
  ok: z.literal(true),
  run_id: z.string().uuid(),
  started_at: z.string().datetime(),
});
export type IngestStartResponse = z.infer<typeof IngestStartResponseSchema>;

// ==================== Merchant ingest ====================

export const MerchantIngestRowSchema = z.object({
  source_merchant_id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  slug: z.string().max(128).optional(),
  storefront_url: z.string().url().optional(),

  merchant_country: CountryCode.optional(),
  ships_to_countries: z.array(CountryCode).optional(),
  ships_to_regions: z.array(RegionGroup).optional(),
  currencies: z.array(CurrencyCode).default([]),
  avg_delivery_days_eu: z.number().int().min(0).max(120).optional(),
  avg_delivery_days_us: z.number().int().min(0).max(120).optional(),
  avg_delivery_days_mena: z.number().int().min(0).max(120).optional(),

  affiliate_network: z.string().max(64).optional(),
  commission_rate: z.number().min(0).max(1).optional(),
  quality_score: z.number().int().min(0).max(100).optional(),
  customs_risk: CustomsRisk.optional(),

  admin_notes: z.string().max(2000).optional(),
});
export type MerchantIngestRow = z.infer<typeof MerchantIngestRowSchema>;

export const MerchantIngestRequestSchema = z.object({
  run_id: z.string().uuid(),
  source_network: SourceNetwork,
  merchants: z
    .array(MerchantIngestRowSchema)
    .min(1, 'At least one merchant row required')
    .max(500, 'Max 500 merchants per batch'),
});
export type MerchantIngestRequest = z.infer<typeof MerchantIngestRequestSchema>;

export const MerchantIngestResponseSchema = z.object({
  ok: z.boolean(),
  run_id: z.string().uuid(),
  inserted: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(
    z.object({
      source_merchant_id: z.string(),
      error: z.string(),
    })
  ),
});
export type MerchantIngestResponse = z.infer<typeof MerchantIngestResponseSchema>;

// ==================== Product ingest ====================

/**
 * Product ingestion row.
 *
 * REQUIRED for every row (API rejects if missing):
 *   - source_product_id
 *   - merchant source_merchant_id (to resolve merchant_id)
 *   - title
 *   - price_cents + currency
 *   - affiliate_url
 *   - origin_country (2-letter ISO)
 *   - At least one of: ships_to_countries, ships_to_regions
 *
 * Server derives:
 *   - merchant_id (from source_network + source_merchant_id)
 *   - origin_region (from origin_country)
 *   - content_hash (from canonical fields)
 *   - search_text (generated TSVector column)
 */
export const ProductIngestRowSchema = z.object({
  // Source tracking (required for idempotent upsert)
  source_product_id: z
    .string()
    .min(1)
    .max(512)
    .describe('Stable source identifier — ASIN, Shopify GID, CJ advertiser-product-id, URL hash for scrapes.'),
  source_merchant_id: z
    .string()
    .min(1)
    .max(256)
    .describe('Merchant identifier at the source. Must match a merchant already ingested in this run or a prior run.'),
  gtin: z.string().max(64).optional(),
  sku: z.string().max(128).optional(),
  asin: z.string().max(32).optional(),

  // Core
  title: z.string().min(1).max(512),
  description: z.string().max(10000).optional(),
  brand: z.string().max(256).optional(),
  category: z.string().max(128).optional(),
  subcategory: z.string().max(128).optional(),
  topic_keys: z.array(z.string().max(64)).default([]),

  // Price (required)
  price_cents: z.number().int().min(0),
  currency: CurrencyCode,
  compare_at_price_cents: z.number().int().min(0).optional(),

  // Media
  images: z.array(z.string().url()).default([]),

  // Purchase (required)
  affiliate_url: z.string().url(),
  availability: Availability.default('in_stock'),
  rating: z.number().min(0).max(5).optional(),
  review_count: z.number().int().min(0).optional(),

  // Geo (required: origin_country + ships destination)
  origin_country: CountryCode,
  ships_to_countries: z.array(CountryCode).optional(),
  ships_to_regions: z.array(RegionGroup).optional(),
  excluded_from_regions: z.array(RegionGroup).default([]),
  customs_risk: CustomsRisk.optional(),

  // Search + personalization (optional but strongly encouraged)
  health_goals: z.array(z.string().max(64)).default([]),
  dietary_tags: z.array(z.string().max(64)).default([]),
  form: Form.optional(),
  certifications: z.array(z.string().max(64)).default([]),
  ingredients_primary: z.array(z.string().max(128)).default([]),
  target_audience: z.array(z.string().max(64)).default([]),
  contains_allergens: z.array(z.string().max(64)).default([]),
  contraindicated_with_conditions: z.array(z.string().max(64)).default([]),
  contraindicated_with_medications: z.array(z.string().max(64)).default([]),

  // Ingestion metadata
  raw: z.record(z.string(), z.unknown()).optional(),
})
  .refine(
    (row) =>
      (row.ships_to_countries && row.ships_to_countries.length > 0) ||
      (row.ships_to_regions && row.ships_to_regions.length > 0),
    {
      message:
        'Row must specify at least one of ships_to_countries or ships_to_regions — otherwise the product can never be shown to any user.',
    }
  );
export type ProductIngestRow = z.infer<typeof ProductIngestRowSchema>;

export const ProductIngestRequestSchema = z.object({
  run_id: z.string().uuid(),
  source_network: SourceNetwork,
  products: z
    .array(ProductIngestRowSchema)
    .min(1, 'At least one product row required')
    .max(500, 'Max 500 products per batch'),
});
export type ProductIngestRequest = z.infer<typeof ProductIngestRequestSchema>;

export const ProductIngestErrorSchema = z.object({
  source_product_id: z.string(),
  error: z.string(),
  field: z.string().optional(),
});
export type ProductIngestError = z.infer<typeof ProductIngestErrorSchema>;

export const ProductIngestResponseSchema = z.object({
  ok: z.boolean(),
  run_id: z.string().uuid(),
  inserted: z.number().int(),
  updated: z.number().int(),
  skipped_unchanged: z.number().int(),
  skipped_missing_merchant: z.number().int(),
  errors: z.array(ProductIngestErrorSchema),
});
export type ProductIngestResponse = z.infer<typeof ProductIngestResponseSchema>;

// ==================== Finish run ====================

export const IngestFinishRequestSchema = z.object({
  run_id: z.string().uuid(),
  deactivate_stale: z
    .boolean()
    .default(false)
    .describe(
      'If true, mark products from this source_network with last_seen_at older than the run start as is_active=false.'
    ),
  stale_threshold_days: z.number().int().min(1).max(365).default(30),
});
export type IngestFinishRequest = z.infer<typeof IngestFinishRequestSchema>;

export const IngestFinishResponseSchema = z.object({
  ok: z.literal(true),
  run_id: z.string().uuid(),
  finished_at: z.string().datetime(),
  stats: z.object({
    products_inserted: z.number().int(),
    products_updated: z.number().int(),
    products_skipped: z.number().int(),
    errors: z.number().int(),
    deactivated_stale: z.number().int().optional(),
  }),
});
export type IngestFinishResponse = z.infer<typeof IngestFinishResponseSchema>;

// ==================== Dry run ====================

export const IngestDryRunRequestSchema = z.object({
  source_network: SourceNetwork,
  products: z.array(ProductIngestRowSchema).min(1).max(100),
});
export type IngestDryRunRequest = z.infer<typeof IngestDryRunRequestSchema>;

export const IngestDryRunResponseSchema = z.object({
  ok: z.boolean(),
  valid_rows: z.number().int(),
  invalid_rows: z.number().int(),
  would_insert: z.number().int(),
  would_update: z.number().int(),
  would_skip_unchanged: z.number().int(),
  would_skip_missing_merchant: z.number().int(),
  errors: z.array(ProductIngestErrorSchema),
  preview: z
    .array(
      z.object({
        source_product_id: z.string(),
        derived_origin_region: RegionGroup,
        derived_merchant_resolved: z.boolean(),
        action: z.enum(['insert', 'update', 'skip_unchanged', 'skip_missing_merchant']),
      })
    )
    .describe('First 10 rows with computed action — helps scraper self-correct.'),
});
export type IngestDryRunResponse = z.infer<typeof IngestDryRunResponseSchema>;

// ==================== Error payload (generic) ====================

export const IngestErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z
    .enum([
      'VALIDATION_FAILED',
      'RUN_NOT_FOUND',
      'RUN_ALREADY_FINISHED',
      'RATE_LIMIT_EXCEEDED',
      'UNAUTHORIZED',
      'INTERNAL_ERROR',
    ])
    .optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type IngestErrorResponse = z.infer<typeof IngestErrorResponseSchema>;

// ==================== Canonical fact keys (for client-side validation mirrors) ====================

/**
 * Health-affecting memory_fact keys the server enforces via check_canonical_fact_key().
 * Mirror of the canonical_fact_keys table seed — exported here so agents (orb,
 * inline-fact-extractor, tests) can validate keys without hitting the DB.
 *
 * Keep in sync with supabase/migrations/20260416120100_vtid_02000_marketplace_seed.sql.
 */
export const CANONICAL_FACT_KEYS_HEALTH = [
  'user_allergy',
  'user_medication',
  'user_health_condition',
  'user_pregnancy_status',
  'user_ingredient_sensitivity',
] as const;

export const CANONICAL_FACT_KEYS_DIETARY = [
  'user_dietary_preference',
  'user_religious_restriction',
] as const;

export const CANONICAL_FACT_KEYS_BUDGET = [
  'user_budget_ceiling',
  'user_budget_monthly_cap',
  'user_budget_band',
] as const;

export const CANONICAL_FACT_KEYS_ACCESSIBILITY = [
  'user_physical_accessibility_need',
] as const;

export const CANONICAL_FACT_KEYS_PREFERENCE = [
  'user_goal',
  'user_favorite_food',
  'user_favorite_drink',
  'user_birthday',
] as const;

export const ALL_CANONICAL_FACT_KEYS = [
  ...CANONICAL_FACT_KEYS_HEALTH,
  ...CANONICAL_FACT_KEYS_DIETARY,
  ...CANONICAL_FACT_KEYS_BUDGET,
  ...CANONICAL_FACT_KEYS_ACCESSIBILITY,
  ...CANONICAL_FACT_KEYS_PREFERENCE,
] as const;

export type CanonicalFactKey = (typeof ALL_CANONICAL_FACT_KEYS)[number];

// ==================== Marketplace commerce events (reward-system contract) ====================

/**
 * OASIS event topics emitted by marketplace code. The reward system subscribes
 * to these topics to award points.
 *
 * DO NOT RENAME without coordinating with the parallel reward-system session —
 * these are committed as stable Phase 0.
 */
export const MARKETPLACE_COMMERCE_TOPICS = {
  CLICK_OUTBOUND: 'marketplace.click.outbound',
  ORDER_CONVERSION: 'marketplace.order.conversion',
  OUTCOME_REPORTED: 'marketplace.outcome.reported',
  SHARE_INITIATED: 'marketplace.share.initiated',
  RECOMMENDATION_ACCEPTED: 'marketplace.recommendation.accepted',
  PREFERENCES_UPDATED: 'marketplace.preferences.updated',
} as const;

export type MarketplaceCommerceTopic =
  (typeof MARKETPLACE_COMMERCE_TOPICS)[keyof typeof MARKETPLACE_COMMERCE_TOPICS];

export const AttributionSurface = z.enum([
  'feed',
  'search',
  'orb',
  'autopilot',
  'share_and_earn',
  'product_detail',
  'direct',
]);
export type AttributionSurface = z.infer<typeof AttributionSurface>;

// ==================== Scope preference (user-facing dropdown) ====================

export const ProductScopePreference = z.enum([
  'local',
  'regional',
  'friendly',
  'international',
]);
export type ProductScopePreference = z.infer<typeof ProductScopePreference>;

export const LIFECYCLE_STAGES = [
  'onboarding',
  'early',
  'established',
  'mature',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
