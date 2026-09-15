// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: the
// test files referencing gemini-operator.ts
// (test/operator-chat-oasis.test.ts, test/task-extractor.test.ts) both
// wholesale jest.mock the module — zero genuine coverage today.
/**
 * services/gemini-operator.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in gemini-operator.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * `buildMarketplaceProductSearchQuery`/`buildDiscoverFeedQuery` preserve
 * the source's conditional-filter-chain pattern (accumulate optional
 * `.eq`/`.overlaps`/`.contains`/`.lte` calls based on which args were
 * passed) — the caller still applies `.order()`/`.limit()` and awaits.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function searchMarketplaceProducts(
  sb: SupabaseClient,
  args: {
    q?: string;
    category?: string;
    form?: string;
    healthGoals?: string[];
    ingredientsAny?: string[];
    dietary_tags?: string[];
    price_max_cents?: number;
    orderLimit: number;
  },
) {
  let query = sb
    .from('products')
    .select(
      'id, title, description, brand, category, price_cents, currency, images, affiliate_url, rating, review_count, origin_country, origin_region, merchant_id, ingredients_primary, health_goals, dietary_tags, reward_preview, contains_allergens, contraindicated_with_conditions, contraindicated_with_medications, ships_to_countries, ships_to_regions, excluded_from_regions'
    )
    .eq('is_active', true)
    .eq('availability', 'in_stock');

  if (args.q) {
    const sanitizedQ = args.q.replace(/[&|!<>()]/g, ' ').trim();
    if (sanitizedQ) query = query.textSearch('search_text', sanitizedQ, { config: 'simple', type: 'websearch' });
  }
  if (args.category) query = query.eq('category', args.category);
  if (args.form) query = query.eq('form', args.form);
  if (args.healthGoals?.length) query = query.overlaps('health_goals', args.healthGoals);
  if (args.ingredientsAny?.length) query = query.overlaps('ingredients_primary', args.ingredientsAny);
  if (args.dietary_tags?.length) query = query.contains('dietary_tags', args.dietary_tags);
  if (args.price_max_cents !== undefined) query = query.lte('price_cents', args.price_max_cents);

  return query.order('rating', { ascending: false, nullsFirst: false }).limit(args.orderLimit);
}

export async function fetchDiscoverFeed(sb: SupabaseClient, category: string | undefined, limit: number) {
  let query = sb
    .from('products')
    .select('id, title, price_cents, currency, rating, origin_country, images, category, brand, reward_preview')
    .eq('is_active', true)
    .eq('availability', 'in_stock');
  if (category) query = query.eq('category', category);
  return query.order('rating', { ascending: false, nullsFirst: false }).limit(limit);
}

export async function fetchWearableRollup7d(sb: SupabaseClient, userId: string) {
  return sb.from('wearable_rollup_7d').select('*').eq('user_id', userId).maybeSingle();
}

export async function fetchRecentWearableDailyMetrics(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('wearable_daily_metrics')
    .select('metric_date, provider, sleep_minutes, sleep_deep_minutes, hrv_avg_ms, resting_hr, active_minutes, workout_count, steps')
    .eq('user_id', userId)
    .order('metric_date', { ascending: false })
    .limit(limit);
}

export async function fetchConversationThreadUserId(sb: SupabaseClient, threadId: string) {
  return sb.from('conversation_threads').select('user_id').eq('thread_id', threadId).maybeSingle();
}
