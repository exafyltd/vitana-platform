/**
 * VTID-02000: Discover Search API — GET /api/v1/discover/search
 *
 * Single endpoint used by:
 *   - The Discover Marketplace UI search bar (typed queries)
 *   - The assistant's `search_marketplace_products` tool (voice/chat intent)
 *   - Deep-links from voice -> UI ("Open these in Discover" -> /discover/marketplace?q=...)
 *
 * One source of truth => voice results and touch results are always identical.
 *
 * Pipeline (server-side):
 *   1. Parse + normalize query params.
 *   2. Resolve UserHealthContext (geo, scope, limitations, conditions).
 *   3. If user_condition or loose `q`: expand via condition-matcher + synonyms.
 *   4. Query `products` with FTS + structured filters.
 *   5. Apply hard limitations filter (pre-ranking).
 *   6. Compute match_score + match_reasons per row.
 *   7. Rank, paginate, return.
 *
 * Auth: user JWT (Bearer). Anonymous requests fall back to a generic feed
 * but do not persist click logs or benefit from personalization.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';
import { getUserHealthContext, inferPrimaryCondition } from '../services/user-health-context';
import { applyUserLimitations, type FilterableProduct } from '../services/limitations-filter';
import { getConditionMapping, expandSynonymPhrase } from '../services/condition-matcher';
import { emitLimitationBypass } from '../services/reward-events';
import * as jose from 'jose';
import {
  CountryCode,
  CurrencyCode,
  ProductScopePreference,
  Availability,
  Form,
} from '../types/catalog-ingest';

const router = Router();

// ==================== Query schema ====================

const SearchQuerySchema = z.object({
  q: z.string().trim().max(512).optional(),
  scope: ProductScopePreference.optional(),
  category: z.string().max(64).optional(),
  subcategory: z.string().max(64).optional(),
  topic_keys: z.union([z.string(), z.array(z.string())]).optional(),
  health_goals: z.union([z.string(), z.array(z.string())]).optional(),
  dietary_tags: z.union([z.string(), z.array(z.string())]).optional(),
  form: Form.optional(),
  ingredients_any: z.union([z.string(), z.array(z.string())]).optional(),
  ingredients_all: z.union([z.string(), z.array(z.string())]).optional(),
  certifications: z.union([z.string(), z.array(z.string())]).optional(),
  brand: z.union([z.string(), z.array(z.string())]).optional(),
  origin_country: z.union([z.string(), z.array(z.string())]).optional(),
  price_min_cents: z.coerce.number().int().min(0).optional(),
  price_max_cents: z.coerce.number().int().min(0).optional(),
  currency: CurrencyCode.optional(),
  rating_min: z.coerce.number().min(0).max(5).optional(),
  availability: Availability.optional(),
  merchant_id: z.union([z.string(), z.array(z.string())]).optional(),
  similar_to_product_id: z.string().uuid().optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'rating', 'newest']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  user_condition: z.string().max(64).optional(),
  bypass_budget: z.coerce.boolean().optional(),
  bypass_dietary: z.coerce.boolean().optional(),
});

type SearchQuery = z.infer<typeof SearchQuerySchema>;

// ==================== Helpers ====================

function toArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

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

interface ProductSearchRow extends FilterableProduct {
  id: string;
  title: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  subcategory: string | null;
  price_cents: number | null;
  currency: string | null;
  compare_at_price_cents: number | null;
  images: string[];
  affiliate_url: string;
  availability: string;
  rating: number | null;
  review_count: number | null;
  origin_country: string | null;
  origin_region: string | null;
  merchant_id: string | null;
  ingredients_primary: string[];
  health_goals: string[];
  dietary_tags: string[];
  reward_preview: Record<string, unknown> | null;
  dosage: string | null;
  serving_size: string | null;
  servings_per_container: number | null;
  evidence_links: Array<{ title?: string; url?: string; source_type?: string }>;
  safety_notes: string | null;
}

// ==================== GET /search ====================

router.get('/search', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'Supabase unavailable' });
    return;
  }

  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: parsed.error.flatten(),
    });
    return;
  }
  const args: SearchQuery = parsed.data;

  // Normalize array params
  const topicKeys = toArray(args.topic_keys);
  let healthGoals = toArray(args.health_goals);
  const dietaryTags = toArray(args.dietary_tags);
  let ingredientsAny = toArray(args.ingredients_any);
  const ingredientsAll = toArray(args.ingredients_all);
  const certifications = toArray(args.certifications);
  const brand = toArray(args.brand);
  const originCountry = toArray(args.origin_country);
  const merchantId = toArray(args.merchant_id);

  // Resolve user context
  const user_id = extractUserIdOptimistic(req);
  const ctx = user_id
    ? await getUserHealthContext(user_id)
    : null;

  // Determine condition + expand
  const conditionKey = args.user_condition ?? (ctx ? inferPrimaryCondition(ctx) : null);
  const mapping = conditionKey ? await getConditionMapping(conditionKey) : null;

  // Synonym expansion from free-text query
  const synonymExpansion = args.q ? await expandSynonymPhrase(args.q) : {};
  if (!healthGoals?.length && synonymExpansion.health_goals) {
    healthGoals = synonymExpansion.health_goals;
  }
  if (!ingredientsAny?.length && synonymExpansion.ingredients) {
    ingredientsAny = synonymExpansion.ingredients;
  }

  // Condition-driven expansion (only if caller didn't override)
  if (mapping) {
    if (!ingredientsAny?.length && mapping.recommended_ingredients.length) {
      ingredientsAny = mapping.recommended_ingredients;
    }
    if (!healthGoals?.length && mapping.recommended_health_goals.length) {
      healthGoals = mapping.recommended_health_goals;
    }
  }

  // Determine effective scope + geo constraints
  const effectiveScope = args.scope ?? ctx?.scope_preference ?? 'friendly';
  const userCountry = ctx?.country_code ?? null;
  const userRegion = ctx?.region_group ?? null;

  // Soft-bypass audit: log if user explicitly bypassed limitations
  if (args.bypass_budget && ctx?.tenant_id && user_id) {
    emitLimitationBypass({
      user_id,
      tenant_id: ctx.tenant_id,
      bypassed_field: 'budget_max_per_product_cents',
      query_context: { q: args.q ?? null, user_condition: conditionKey },
      source: 'discover_search',
    }).catch(() => {});
  }
  if (args.bypass_dietary && ctx?.tenant_id && user_id) {
    emitLimitationBypass({
      user_id,
      tenant_id: ctx.tenant_id,
      bypassed_field: 'dietary_restrictions',
      query_context: { q: args.q ?? null },
      source: 'discover_search',
    }).catch(() => {});
  }

  // Build query
  let query = supabase
    .from('products')
    .select(
      'id, title, description, description_long, brand, category, subcategory, price_cents, currency, compare_at_price_cents, images, affiliate_url, availability, rating, review_count, origin_country, origin_region, merchant_id, ingredients_primary, health_goals, dietary_tags, reward_preview, contains_allergens, contraindicated_with_conditions, contraindicated_with_medications, ships_to_countries, ships_to_regions, excluded_from_regions, dosage, serving_size, servings_per_container, evidence_links, safety_notes',
      { count: 'exact' }
    )
    .eq('is_active', true);

  if (args.q) {
    // Websearch-style FTS: each phrase becomes an AND-of-tokens
    const sanitizedQ = args.q.replace(/[&|!<>()]/g, ' ').trim();
    if (sanitizedQ) {
      query = query.textSearch('search_text', sanitizedQ, { config: 'simple', type: 'websearch' });
    }
  }
  if (args.category) query = query.eq('category', args.category);
  if (args.subcategory) query = query.eq('subcategory', args.subcategory);
  if (topicKeys?.length) query = query.overlaps('topic_keys', topicKeys);
  if (healthGoals?.length) query = query.overlaps('health_goals', healthGoals);
  if (dietaryTags?.length) query = query.contains('dietary_tags', dietaryTags);
  if (args.form) query = query.eq('form', args.form);
  if (ingredientsAny?.length) query = query.overlaps('ingredients_primary', ingredientsAny);
  if (ingredientsAll?.length) query = query.contains('ingredients_primary', ingredientsAll);
  if (certifications?.length) query = query.contains('certifications', certifications);
  if (brand?.length) query = query.in('brand', brand);
  if (originCountry?.length) query = query.in('origin_country', originCountry);
  if (merchantId?.length) query = query.in('merchant_id', merchantId);
  if (args.price_min_cents !== undefined) query = query.gte('price_cents', args.price_min_cents);
  if (args.price_max_cents !== undefined) query = query.lte('price_cents', args.price_max_cents);
  if (args.rating_min !== undefined) query = query.gte('rating', args.rating_min);
  if (args.availability) query = query.eq('availability', args.availability);

  // Geo gate (if user country known)
  // Avoid using Supabase `.or()` with array interpolation — do this filter
  // client-side after fetch for correctness.

  // Scope-based origin exclusion (fast path; fine-grained geo_policy applied below)
  if (effectiveScope === 'local' && userCountry) {
    query = query.eq('origin_country', userCountry);
  } else if (effectiveScope === 'regional' && userRegion) {
    query = query.eq('origin_region', userRegion);
  } else if (effectiveScope === 'friendly' && userRegion) {
    // Approximate friendly = {EU ⇒ [EU,UK], US ⇒ [US,CA], MENA ⇒ [MENA]}
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
    const allowedOrigins = friendlyMap[userRegion] ?? [userRegion];
    query = query.in('origin_region', allowedOrigins);
  }
  // For 'international' we apply no origin filter here — geo_policy still
  // applies but only as a ranking weight in this pass.

  // Sort
  switch (args.sort) {
    case 'price_asc':
      query = query.order('price_cents', { ascending: true, nullsFirst: false });
      break;
    case 'price_desc':
      query = query.order('price_cents', { ascending: false, nullsFirst: false });
      break;
    case 'rating':
      query = query.order('rating', { ascending: false, nullsFirst: false });
      break;
    case 'newest':
      query = query.order('ingested_at', { ascending: false });
      break;
    case 'relevance':
    default:
      // Relevance fallback: rating DESC + review_count DESC when no FTS query
      query = query.order('rating', { ascending: false, nullsFirst: false });
      break;
  }

  // Over-fetch to allow for post-filter rejections (limitations, geo countries)
  const overFetch = Math.min(args.limit * 3, 150);
  query = query.range(0, overFetch - 1);

  const { data: rows, error } = await query;
  if (error) {
    console.error('[discover-search] query failed:', error);
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  const fetched: ProductSearchRow[] = (rows ?? []) as ProductSearchRow[];

  // Post-filter: geo country-level exact match + limitations
  const geoAllowed = fetched.filter((p) => {
    if (!userCountry) return true;
    const countryMatch = (p.ships_to_countries ?? []).includes(userCountry);
    const regionMatch = userRegion ? (p.ships_to_regions ?? []).includes(userRegion) : false;
    return countryMatch || regionMatch;
  });

  let allowed: ProductSearchRow[];
  let hiddenBreakdown = {
    allergies: 0,
    contraindications: 0,
    medications: 0,
    dietary: 0,
    budget: 0,
    sensitivities: 0,
    geo: fetched.length - geoAllowed.length,
    excluded_region: 0,
  };

  if (ctx) {
    const result = applyUserLimitations(geoAllowed, ctx, {
      bypass_budget: args.bypass_budget,
      bypass_dietary: args.bypass_dietary,
      surface: 'search',
    });
    allowed = result.allowed;
    hiddenBreakdown = {
      ...result.hidden_breakdown,
      geo: hiddenBreakdown.geo + result.hidden_breakdown.geo,
      excluded_region: result.hidden_breakdown.excluded_region,
    };
  } else {
    allowed = geoAllowed;
  }

  // Exclude past purchases (anonymized — only for logged-in user)
  const pastIds = new Set(ctx?.past_purchases.map((p) => p.product_id) ?? []);
  const withoutPast = allowed.filter((p) => !pastIds.has(p.id));

  // Match reasons + score
  const enriched = withoutPast.map((p) => {
    const reasons: Array<{ kind: string; text: string }> = [];
    let score = 0.5;

    if (mapping?.recommended_ingredients_ranked.length && p.ingredients_primary?.length) {
      const pIngs = new Set(p.ingredients_primary.map((x) => x.toLowerCase()));
      for (const rec of mapping.recommended_ingredients_ranked) {
        if (pIngs.has(rec.ingredient.toLowerCase())) {
          reasons.push({ kind: 'condition', text: `Contains ${rec.ingredient} (${rec.evidence} evidence for ${mapping.display_label})` });
          score += Math.max(0.1, 0.35 - (rec.rank - 1) * 0.05);
          break;
        }
      }
    }
    if (dietaryTags?.length && p.dietary_tags?.length) {
      const productSet = new Set(p.dietary_tags.map((d) => d.toLowerCase()));
      const allMatch = dietaryTags.every((d) => productSet.has(d.toLowerCase()));
      if (allMatch) {
        reasons.push({ kind: 'dietary', text: `Matches your ${dietaryTags.join(', ')} preference` });
        score += 0.08;
      }
    }
    if (userRegion && p.origin_region === userRegion) {
      reasons.push({ kind: 'origin', text: `Ships from ${p.origin_country ?? 'your region'}` });
      score += 0.07;
    }
    if (p.rating !== null && p.rating >= 4.5) {
      reasons.push({ kind: 'rating', text: `Rated ${p.rating.toFixed(1)}/5 by ${p.review_count ?? 'many'} users` });
      score += 0.05;
    }
    // Reward-system preview (if populated later by reward system)
    if (p.reward_preview && typeof p.reward_preview === 'object') {
      const rp = p.reward_preview as { points_estimate?: number };
      if (rp.points_estimate) {
        reasons.push({ kind: 'reward', text: `Earn ${rp.points_estimate} points on purchase` });
      }
    }

    return {
      id: p.id,
      title: p.title,
      description: p.description,
      description_long: (p as { description_long?: string | null }).description_long ?? null,
      brand: p.brand,
      category: p.category,
      subcategory: p.subcategory,
      price_cents: p.price_cents,
      currency: p.currency,
      compare_at_price_cents: p.compare_at_price_cents,
      images: p.images,
      affiliate_url: p.affiliate_url,
      availability: p.availability,
      rating: p.rating,
      review_count: p.review_count,
      origin_country: p.origin_country,
      origin_region: p.origin_region,
      merchant_id: p.merchant_id,
      ingredients_primary: p.ingredients_primary,
      health_goals: p.health_goals,
      dietary_tags: p.dietary_tags,
      reward_preview: p.reward_preview,
      dosage: p.dosage ?? null,
      serving_size: p.serving_size ?? null,
      servings_per_container: p.servings_per_container ?? null,
      evidence_links: Array.isArray(p.evidence_links) ? p.evidence_links : [],
      safety_notes: p.safety_notes ?? null,
      match_score: Math.min(1, score),
      match_reasons: reasons,
    };
  });

  // Final sort if relevance-based (match_score DESC)
  if ((args.sort ?? 'relevance') === 'relevance' && enriched.length > 0) {
    enriched.sort((a, b) => b.match_score - a.match_score);
  }

  const paged = enriched.slice(args.offset, args.offset + args.limit);

  // Suggested expansions if feed thin
  const suggested_expansions: string[] = [];
  if (paged.length < 5 && effectiveScope !== 'international') {
    suggested_expansions.push(`Widen scope to international to see more options`);
  }

  res.json({
    ok: true,
    items: paged,
    total_count: enriched.length,
    applied_filters: {
      q: args.q ?? null,
      scope: effectiveScope,
      category: args.category ?? null,
      subcategory: args.subcategory ?? null,
      topic_keys: topicKeys ?? null,
      health_goals: healthGoals ?? null,
      dietary_tags: dietaryTags ?? null,
      ingredients_any: ingredientsAny ?? null,
      ingredients_all: ingredientsAll ?? null,
      certifications: certifications ?? null,
      brand: brand ?? null,
      origin_country: originCountry ?? null,
      price_min_cents: args.price_min_cents ?? null,
      price_max_cents: args.price_max_cents ?? null,
      rating_min: args.rating_min ?? null,
      user_condition: conditionKey,
      user_country: userCountry,
      user_region: userRegion,
    },
    hidden_breakdown: hiddenBreakdown,
    hidden_total: Object.values(hiddenBreakdown).reduce((a, b) => a + b, 0),
    suggested_expansions,
  });
});

export default router;
