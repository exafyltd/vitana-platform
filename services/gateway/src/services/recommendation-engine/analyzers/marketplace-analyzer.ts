/**
 * VTID-02000: Marketplace Analyzer — 8th analyzer for the recommendation engine.
 *
 * Mirrors the pattern of llm-analyzer.ts but operates on the product catalog.
 * For each user, pulls UserHealthContext, infers a primary condition (or uses
 * the one provided by the caller), joins to `condition_product_mappings` to
 * derive candidate ingredients, queries `products` applying geo + limitations
 * filters, scores, and emits top candidates as autopilot recommendations.
 *
 * Scheduling: consumed by recommendation-generator via source_type='marketplace'.
 * Runs in the existing daily 7 AM per-user cadence (community-user-analyzer path)
 * AND the 6-hour OASIS cadence. No new scheduler infrastructure.
 *
 * Phase 0: pure heuristic — no LLM call required. Phase 2 adds the LLM pre-ranker
 * mirroring llm-analyzer.ts's Gemini integration.
 */

import { createHash } from 'crypto';
import { getSupabase } from '../../../lib/supabase';
import { getUserHealthContext, inferPrimaryCondition } from '../../user-health-context';
import { applyUserLimitations, type FilterableProduct } from '../../limitations-filter';

const LOG_PREFIX = '[VTID-02000:Marketplace]';

// ==================== Types ====================

export interface MarketplaceSignal {
  user_id: string;
  tenant_id: string | null;
  condition_key: string | null;
  product_id: string;
  product_title: string;
  merchant_id: string | null;
  price_cents: number | null;
  currency: string | null;
  match_score: number; // 0..1
  match_reasons: Array<{ kind: string; text: string }>;
  severity: 'low' | 'medium' | 'high';
  confidence: number;
}

export interface MarketplaceAnalysisResult {
  ok: boolean;
  signals: MarketplaceSignal[];
  summary: {
    users_analyzed: number;
    products_scored: number;
    top_picks_per_user: number;
    duration_ms: number;
  };
  error?: string;
}

interface ConditionMapping {
  condition_key: string;
  recommended_ingredients: Array<{ ingredient: string; evidence: string; rank: number }>;
  recommended_health_goals: string[];
  contraindicated_ingredients: string[];
}

interface ProductRow extends FilterableProduct {
  id: string;
  title: string;
  merchant_id: string | null;
  price_cents: number | null;
  currency: string | null;
  rating: number | null;
  origin_country: string | null;
  origin_region: string | null;
  health_goals: string[];
  ingredients_primary: string[];
}

const TOP_PICKS_PER_USER = 5;
const PRODUCT_CANDIDATE_LIMIT = 100;

// ==================== Condition mapping fetch ====================

async function fetchConditionMapping(condition_key: string): Promise<ConditionMapping | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('condition_product_mappings')
    .select('condition_key, recommended_ingredients, recommended_health_goals, contraindicated_ingredients')
    .eq('condition_key', condition_key)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return null;
  return {
    condition_key: data.condition_key,
    recommended_ingredients: (data.recommended_ingredients as Array<{ ingredient: string; evidence: string; rank: number }>) ?? [],
    recommended_health_goals: data.recommended_health_goals ?? [],
    contraindicated_ingredients: data.contraindicated_ingredients ?? [],
  };
}

// ==================== Candidate fetch ====================

async function fetchCandidateProducts(
  mapping: ConditionMapping | null,
  scopeRegion: string | null
): Promise<ProductRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const query = supabase
    .from('products')
    .select(
      'id, title, merchant_id, price_cents, currency, rating, origin_country, origin_region, health_goals, ingredients_primary, dietary_tags, contains_allergens, contraindicated_with_conditions, contraindicated_with_medications, ships_to_countries, ships_to_regions, excluded_from_regions'
    )
    .eq('is_active', true)
    .limit(PRODUCT_CANDIDATE_LIMIT);

  // Narrow by mapping ingredients if available — via GIN-indexed ingredients_primary
  if (mapping?.recommended_ingredients.length) {
    const ingredients = mapping.recommended_ingredients.map((i) => i.ingredient);
    query.overlaps('ingredients_primary', ingredients);
  } else if (mapping?.recommended_health_goals.length) {
    query.overlaps('health_goals', mapping.recommended_health_goals);
  }
  // Prefer same-region products if user region known
  if (scopeRegion) {
    query.eq('origin_region', scopeRegion);
  }

  const { data, error } = await query;
  if (error) {
    console.warn(`${LOG_PREFIX} candidate fetch failed:`, error.message);
    return [];
  }
  return (data ?? []) as ProductRow[];
}

// ==================== Scoring ====================

function scoreProduct(
  p: ProductRow,
  mapping: ConditionMapping | null,
  userRegion: string | null,
  pastPurchaseIds: Set<string>
): { score: number; reasons: Array<{ kind: string; text: string }> } {
  const reasons: Array<{ kind: string; text: string }> = [];
  let score = 0;

  // Ingredient-fit (0..0.5) — highest-rank-match wins
  if (mapping?.recommended_ingredients.length) {
    const productIngs = new Set(p.ingredients_primary.map((x) => x.toLowerCase()));
    for (const rec of mapping.recommended_ingredients) {
      if (productIngs.has(rec.ingredient.toLowerCase())) {
        const rankBoost = Math.max(0, 0.5 - (rec.rank - 1) * 0.08);
        const evidenceBoost = rec.evidence === 'strong' ? 1.0 : rec.evidence === 'moderate' ? 0.8 : 0.5;
        score += rankBoost * evidenceBoost;
        reasons.push({
          kind: 'condition',
          text: `Contains ${rec.ingredient} — ${rec.evidence} evidence for ${mapping.condition_key}`,
        });
        break;
      }
    }
  }

  // Goal-fit (0..0.2)
  if (mapping?.recommended_health_goals.length && p.health_goals?.length) {
    const hg = new Set(p.health_goals.map((g) => g.toLowerCase()));
    const match = mapping.recommended_health_goals.find((g) => hg.has(g.toLowerCase()));
    if (match) {
      score += 0.2;
      reasons.push({ kind: 'goal', text: `Supports ${match}` });
    }
  }

  // Origin-proximity (0..0.15) — same-region gets the full boost
  if (userRegion && p.origin_region === userRegion) {
    score += 0.15;
    reasons.push({ kind: 'origin', text: `Ships from ${p.origin_country ?? 'your region'}` });
  }

  // Rating (0..0.1)
  if (p.rating !== null && p.rating > 0) {
    const ratingBoost = Math.max(0, Math.min(0.1, ((p.rating - 3) / 2) * 0.1));
    if (ratingBoost > 0.02) {
      score += ratingBoost;
      reasons.push({ kind: 'rating', text: `Rated ${p.rating.toFixed(1)}/5` });
    }
  }

  // Penalty: past purchase (don't re-recommend)
  if (pastPurchaseIds.has(p.id)) {
    score -= 1.0;
  }

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

// ==================== Per-user analysis ====================

export async function analyzeMarketplaceForUser(
  user_id: string,
  opts: { condition_key?: string | null } = {}
): Promise<MarketplaceSignal[]> {
  const ctx = await getUserHealthContext(user_id, { bypass_cache: true });
  const conditionKey = opts.condition_key ?? inferPrimaryCondition(ctx);
  if (!conditionKey) {
    return [];
  }

  const mapping = await fetchConditionMapping(conditionKey);
  if (!mapping) {
    console.log(`${LOG_PREFIX} no condition mapping for ${conditionKey} — skipping user ${user_id}`);
    return [];
  }

  const scopeRegion =
    ctx.scope_preference === 'local' || ctx.scope_preference === 'regional'
      ? ctx.region_group
      : null;
  const candidates = await fetchCandidateProducts(mapping, scopeRegion);
  if (candidates.length === 0) return [];

  // Apply hard limitations filter
  const filtered = applyUserLimitations(candidates, ctx, { surface: 'marketplace_analyzer' });

  const pastPurchaseIds = new Set(ctx.past_purchases.map((p) => p.product_id));
  const scored = filtered.allowed
    .map((p) => {
      const { score, reasons } = scoreProduct(p as ProductRow, mapping, ctx.region_group, pastPurchaseIds);
      return { product: p as ProductRow, score, reasons };
    })
    .filter((s) => s.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_PICKS_PER_USER);

  return scored.map((s) => ({
    user_id,
    tenant_id: ctx.tenant_id,
    condition_key: conditionKey,
    product_id: s.product.id,
    product_title: s.product.title,
    merchant_id: s.product.merchant_id,
    price_cents: s.product.price_cents,
    currency: s.product.currency,
    match_score: s.score,
    match_reasons: s.reasons,
    severity: s.score > 0.7 ? 'high' : s.score > 0.4 ? 'medium' : 'low',
    confidence: Math.min(0.95, s.score + 0.2),
  }));
}

// ==================== Main analyzer entry (for recommendation-generator) ====================

export async function analyzeMarketplace(opts: {
  user_ids?: string[]; // if omitted, run for all "recent" users (stub for Phase 0)
  limit_per_user?: number;
}): Promise<MarketplaceAnalysisResult> {
  const startTime = Date.now();
  const supabase = getSupabase();
  if (!supabase) {
    return {
      ok: false,
      signals: [],
      summary: { users_analyzed: 0, products_scored: 0, top_picks_per_user: 0, duration_ms: 0 },
      error: 'Supabase unavailable',
    };
  }

  // Resolve user list — if not specified, pull users that have conditions set
  let userIds: string[] = opts.user_ids ?? [];
  if (userIds.length === 0) {
    const { data } = await supabase
      .from('user_limitations')
      .select('user_id')
      .or('contraindications.neq.{},allergies.neq.{}')
      .limit(50);
    userIds = (data ?? []).map((r) => r.user_id as string);
  }

  const allSignals: MarketplaceSignal[] = [];
  let productsScored = 0;

  for (const uid of userIds) {
    try {
      const signals = await analyzeMarketplaceForUser(uid);
      allSignals.push(...signals);
      productsScored += signals.length;
    } catch (err) {
      console.warn(`${LOG_PREFIX} per-user analysis failed for ${uid}:`, err);
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `${LOG_PREFIX} Analysis complete: ${userIds.length} users, ${allSignals.length} recommendations in ${duration}ms`
  );

  return {
    ok: true,
    signals: allSignals,
    summary: {
      users_analyzed: userIds.length,
      products_scored: productsScored,
      top_picks_per_user: TOP_PICKS_PER_USER,
      duration_ms: duration,
    },
  };
}

// ==================== Fingerprint ====================

export function generateMarketplaceFingerprint(signal: MarketplaceSignal): string {
  const data = `marketplace:${signal.user_id}:${signal.condition_key}:${signal.product_id}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}
