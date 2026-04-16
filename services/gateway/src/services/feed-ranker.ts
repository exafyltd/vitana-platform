/**
 * VTID-02000: Feed Ranker — lifecycle-aware blend of admin-defined defaults
 * and per-user personalization.
 *
 * Used by /api/v1/discover/feed and the `open_discover_feed` assistant tool.
 */

import type { UserHealthContext } from './user-health-context';
import type { FilterableProduct } from './limitations-filter';

export interface FeedConfig {
  id: string;
  region_group: string;
  lifecycle_stage: string;
  category_mix: Record<string, number>;
  max_products_per_merchant: number;
  max_products_per_category: number | null;
  starter_conditions: string[];
  personalization_weight_override: number | null;
  diversity_rules: Record<string, unknown>;
  notes: string | null;
  featured_product_ids: string[];
}

interface RankableProduct extends FilterableProduct {
  id: string;
  category: string | null;
  merchant_id: string | null;
  rating: number | null;
  origin_region: string | null;
  health_goals: string[] | null;
  price_cents: number | null;
}

export function defaultPersonalizationWeightForStage(stage: string | null): number {
  switch (stage) {
    case 'onboarding':
      return 0.2;
    case 'early':
      return 0.45;
    case 'established':
      return 0.7;
    case 'mature':
      return 0.9;
    default:
      return 0.3;
  }
}

export interface FeedRankInput<T extends RankableProduct> {
  products: T[];
  config: FeedConfig | null;
  ctx: UserHealthContext;
  limit: number;
}

export interface FeedRankOutput<T extends RankableProduct> {
  items: Array<T & { rank_score: number; rank_reasons: string[] }>;
  personalization_weight: number;
  rationale: string;
}

/**
 * Score + blend + diversity-cap products for the feed view. Operates on
 * an already-limitations-filtered pool.
 */
export function rankFeedProducts<T extends RankableProduct>(
  input: FeedRankInput<T>
): FeedRankOutput<T> {
  const { products, config, ctx, limit } = input;

  const personalizationWeight =
    config?.personalization_weight_override ??
    defaultPersonalizationWeightForStage(ctx.lifecycle_stage);

  const featuredSet = new Set(config?.featured_product_ids ?? []);
  const starterConditions = new Set(config?.starter_conditions ?? []);
  const maxPerMerchant = config?.max_products_per_merchant ?? 3;
  const maxPerCategory = config?.max_products_per_category ?? null;

  const scored = products.map((p) => {
    const rank_reasons: string[] = [];

    // Default score component: featured pins + rating + category mix fit
    let defaultScore = 0;
    if (featuredSet.has(p.id)) {
      defaultScore += 0.7;
      rank_reasons.push('Featured by editors');
    }
    if (p.rating !== null && p.rating > 0) {
      defaultScore += Math.max(0, Math.min(0.3, ((p.rating - 3) / 2) * 0.3));
    }
    if (config && p.category && config.category_mix[p.category]) {
      // Slight boost for categories that the admin config prioritizes
      defaultScore += config.category_mix[p.category] * 0.2;
    }

    // Personalization score component
    let personalizedScore = 0;
    // Topic affinity
    if (p.category && ctx.topic_affinity[p.category]) {
      personalizedScore += Math.min(0.4, ctx.topic_affinity[p.category]);
    }
    // Active-condition fit: if product's health_goals overlap starter or active conditions
    if (p.health_goals?.length) {
      for (const cond of ctx.active_conditions) {
        if (starterConditions.has(cond.key) || cond.source === 'user_stated') {
          const goals = p.health_goals.map((g) => g.toLowerCase());
          if (goals.some((g) => g.includes(cond.key.toLowerCase().replace(/-/g, '')))) {
            personalizedScore += 0.3;
            rank_reasons.push(`Supports ${cond.key}`);
            break;
          }
        }
      }
    }
    // Same-region origin bonus
    if (ctx.region_group && p.origin_region === ctx.region_group) {
      personalizedScore += 0.1;
      rank_reasons.push('Ships from your region');
    }
    // Rating — also shared with default score but we leave both for simplicity
    if (p.rating !== null && p.rating >= 4.5) {
      personalizedScore += 0.1;
    }
    // Budget fit
    if (ctx.budget_max_per_product_cents && p.price_cents !== null && p.price_cents !== undefined && p.price_cents <= ctx.budget_max_per_product_cents) {
      personalizedScore += 0.05;
    }

    const blended = (1 - personalizationWeight) * defaultScore + personalizationWeight * personalizedScore;
    return {
      ...p,
      rank_score: Math.min(1, blended),
      rank_reasons,
    };
  });

  // Sort + diversity cap
  scored.sort((a, b) => b.rank_score - a.rank_score);

  const merchantCount = new Map<string, number>();
  const categoryCount = new Map<string, number>();
  const output: Array<T & { rank_score: number; rank_reasons: string[] }> = [];

  for (const item of scored) {
    if (output.length >= limit) break;
    const merchant = item.merchant_id ?? '(none)';
    const category = item.category ?? '(none)';
    if ((merchantCount.get(merchant) ?? 0) >= maxPerMerchant) continue;
    if (maxPerCategory !== null && (categoryCount.get(category) ?? 0) >= maxPerCategory) continue;
    output.push(item);
    merchantCount.set(merchant, (merchantCount.get(merchant) ?? 0) + 1);
    categoryCount.set(category, (categoryCount.get(category) ?? 0) + 1);
  }

  const rationale = buildRationale(ctx, config, personalizationWeight);
  return { items: output, personalization_weight: personalizationWeight, rationale };
}

function buildRationale(
  ctx: UserHealthContext,
  config: FeedConfig | null,
  weight: number
): string {
  const regionLabel = ctx.region_group ?? config?.region_group ?? 'your region';
  if (!ctx.lifecycle_stage || ctx.lifecycle_stage === 'onboarding') {
    return `Starter selection for new users in ${regionLabel}. I'll tailor it as I learn more about you.`;
  }
  if (ctx.lifecycle_stage === 'early') {
    return `Your feed, starting to reflect what you've told me. Personalization ${Math.round(weight * 100)}%.`;
  }
  if (ctx.lifecycle_stage === 'established') {
    return `Your feed, mostly tailored to your needs. Personalization ${Math.round(weight * 100)}%.`;
  }
  return `Your feed, shaped by everything I've learned about you. Personalization ${Math.round(weight * 100)}%.`;
}
