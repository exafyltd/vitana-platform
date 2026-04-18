/**
 * VTID-02000: Discover Feed API — GET /api/v1/discover/feed
 *
 * The default browse experience. Distinct from /search: no user query, no
 * explicit intent — just "what matters to this user right now?"
 *
 * Pipeline:
 *   1. Resolve UserHealthContext (geo, scope, lifecycle, limitations).
 *   2. Load applicable default_feed_config (tenant_id × region × lifecycle_stage,
 *      with GLOBAL × stage fallback).
 *   3. Candidate fetch: products in user's region + scope, limited.
 *   4. Apply hard limitations filter.
 *   5. Rank via feed-ranker (default_score + personalized_score blend).
 *   6. Return items + feed_context (lifecycle_stage, personalization_weight, rationale).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';
import { getUserHealthContext } from '../services/user-health-context';
import { applyUserLimitations, type FilterableProduct } from '../services/limitations-filter';
import { rankFeedProducts, type FeedConfig } from '../services/feed-ranker';
import * as jose from 'jose';

const router = Router();

const FeedQuerySchema = z.object({
  category: z.string().max(64).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(30).default(20),
});

function extractUserIdOptimistic(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const claims = jose.decodeJwt(token);
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

router.get('/feed', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'Supabase unavailable' });
    return;
  }

  const parsed = FeedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { category, limit } = parsed.data;

  const user_id = extractUserIdOptimistic(req);
  if (!user_id) {
    res.status(401).json({ ok: false, error: 'Authentication required for feed' });
    return;
  }
  const ctx = await getUserHealthContext(user_id);

  const regionGroup = ctx.region_group ?? 'GLOBAL';
  const lifecycleStage = ctx.lifecycle_stage ?? 'onboarding';

  // Resolve feed config: tenant-specific > platform-wide > GLOBAL × stage fallback
  let feedConfig: FeedConfig | null = null;
  const { data: configRows } = await supabase
    .from('default_feed_config')
    .select(
      'id, tenant_id, region_group, lifecycle_stage, featured_product_ids, category_mix, max_products_per_merchant, max_products_per_category, starter_conditions, personalization_weight_override, diversity_rules, notes'
    )
    .in('region_group', [regionGroup, 'GLOBAL'])
    .eq('lifecycle_stage', lifecycleStage)
    .eq('is_active', true);

  if (configRows?.length) {
    // Prefer tenant-specific, then platform-default for region, then GLOBAL fallback
    const tenantRow = configRows.find((r) => r.tenant_id === ctx.tenant_id);
    const regionRow = configRows.find((r) => r.tenant_id === null && r.region_group === regionGroup);
    const globalRow = configRows.find((r) => r.tenant_id === null && r.region_group === 'GLOBAL');
    const chosen = tenantRow ?? regionRow ?? globalRow ?? configRows[0];
    feedConfig = {
      id: chosen.id,
      region_group: chosen.region_group,
      lifecycle_stage: chosen.lifecycle_stage,
      featured_product_ids: chosen.featured_product_ids ?? [],
      category_mix: (chosen.category_mix as Record<string, number>) ?? {},
      max_products_per_merchant: chosen.max_products_per_merchant ?? 3,
      max_products_per_category: chosen.max_products_per_category ?? null,
      starter_conditions: chosen.starter_conditions ?? [],
      personalization_weight_override: chosen.personalization_weight_override ?? null,
      diversity_rules: (chosen.diversity_rules as Record<string, unknown>) ?? {},
      notes: chosen.notes ?? null,
    };
  }

  // Candidate fetch
  let candidateQuery = supabase
    .from('products')
    .select(
      'id, title, description, brand, category, subcategory, price_cents, currency, compare_at_price_cents, images, affiliate_url, availability, rating, review_count, origin_country, origin_region, merchant_id, ingredients_primary, health_goals, dietary_tags, reward_preview, contains_allergens, contraindicated_with_conditions, contraindicated_with_medications, ships_to_countries, ships_to_regions, excluded_from_regions, dosage, serving_size, servings_per_container, evidence_links, safety_notes'
    )
    .eq('is_active', true)
    .eq('availability', 'in_stock');

  if (category) candidateQuery = candidateQuery.eq('category', category);

  // Scope-based origin
  const scope = ctx.scope_preference;
  if (scope === 'local' && ctx.country_code) {
    candidateQuery = candidateQuery.eq('origin_country', ctx.country_code);
  } else if (scope === 'regional' && ctx.region_group) {
    candidateQuery = candidateQuery.eq('origin_region', ctx.region_group);
  } else if (scope === 'friendly' && ctx.region_group) {
    const friendlyMap: Record<string, string[]> = {
      EU: ['EU', 'UK'],
      UK: ['UK', 'EU'],
      US: ['US', 'CA'],
      CA: ['CA', 'US'],
      MENA: ['MENA'],
      APAC_JP_KR_TW: ['APAC_JP_KR_TW'],
      APAC_SEA: ['APAC_SEA'],
      APAC_IN: ['APAC_IN'],
      LATAM: ['LATAM'],
      OCEANIA: ['OCEANIA'],
    };
    const allowedOrigins = friendlyMap[ctx.region_group] ?? [ctx.region_group];
    candidateQuery = candidateQuery.in('origin_region', allowedOrigins);
  }

  candidateQuery = candidateQuery.order('rating', { ascending: false, nullsFirst: false }).limit(150);

  const { data: rows, error } = await candidateQuery;
  if (error) {
    console.error('[discover-feed] candidate fetch failed:', error);
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  const candidates = (rows ?? []) as (FilterableProduct & {
    id: string;
    title: string;
    category: string | null;
    merchant_id: string | null;
    rating: number | null;
    origin_region: string | null;
    health_goals: string[] | null;
    price_cents: number | null;
  })[];

  // Geo country-level + limitations
  const geoAllowed = candidates.filter((p) => {
    if (!ctx.country_code) return true;
    const countryMatch = (p.ships_to_countries ?? []).includes(ctx.country_code);
    const regionMatch = ctx.region_group ? (p.ships_to_regions ?? []).includes(ctx.region_group) : false;
    return countryMatch || regionMatch;
  });

  const { allowed, hidden_breakdown } = applyUserLimitations(geoAllowed, ctx, { surface: 'feed' });

  // Exclude past purchases
  const pastIds = new Set(ctx.past_purchases.map((p) => p.product_id));
  const withoutPast = allowed.filter((p) => !pastIds.has(p.id));

  const ranked = rankFeedProducts({
    products: withoutPast,
    config: feedConfig,
    ctx,
    limit,
  });

  res.json({
    ok: true,
    items: ranked.items,
    feed_context: {
      lifecycle_stage: lifecycleStage,
      personalization_weight: ranked.personalization_weight,
      region_group: regionGroup,
      scope: ctx.scope_preference,
      rationale: ranked.rationale,
      config_id: feedConfig?.id ?? null,
    },
    hidden_breakdown: {
      ...hidden_breakdown,
      geo: hidden_breakdown.geo + (candidates.length - geoAllowed.length),
      past_purchases: allowed.length - withoutPast.length,
    },
  });
});

export default router;
