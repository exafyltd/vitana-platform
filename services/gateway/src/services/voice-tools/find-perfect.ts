/**
 * VTID-02780 — Voice Tool Expansion P1r: Find Perfect flagship tools.
 *
 * The four highest-bar voice tools per the user's priority feedback:
 *   - find_perfect_product
 *   - find_perfect_practitioner
 *   - find_perfect_match (people)
 *   - ask_who_is (superlative NL)
 *
 * These intentionally degrade gracefully: when a backing table or RPC isn't
 * deployed in the active environment, the tool returns
 * `{ ok: true, available: false, reason: '...' }` so ORB can speak a clean
 * "not yet computed" reply instead of erroring.
 *
 * Each tool fuses (where available):
 *   - Vitana Index pillar deficits (weakest pillar)
 *   - Active Life Compass goal
 *   - Multi-criteria filters from the natural-language ask
 *   - Reciprocal compatibility (for match search)
 */

import { SupabaseClient } from '@supabase/supabase-js';

interface Identity {
  user_id: string;
  tenant_id: string | null;
}

async function getWeakestPillarAndGoal(
  sb: SupabaseClient,
  userId: string,
): Promise<{ weakest_pillar: string | null; compass_goal: string | null }> {
  let weakest: string | null = null;
  let goal: string | null = null;
  try {
    const { data: idx } = await sb
      .from('vitana_index_scores')
      .select('pillars')
      .eq('user_id', userId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (idx?.pillars && typeof idx.pillars === 'object') {
      const pairs = Object.entries(idx.pillars as Record<string, number>);
      pairs.sort((a, b) => a[1] - b[1]);
      weakest = pairs[0]?.[0] ?? null;
    }
  } catch {
    /* table may not exist in all envs */
  }
  try {
    const { data: lc } = await sb
      .from('life_compass')
      .select('current_goal')
      .eq('user_id', userId)
      .maybeSingle();
    goal = (lc?.current_goal as string) ?? null;
  } catch {
    /* table may not exist */
  }
  return { weakest_pillar: weakest, compass_goal: goal };
}

export async function findPerfectProduct(
  sb: SupabaseClient,
  identity: Identity,
  args: {
    goal_text?: string;
    pillar?: string;
    max_price?: number;
    exclude_ingredients?: string[];
    dietary_restrictions?: string[];
  },
): Promise<{ ok: true; results: any[]; rationale: string; available: boolean }> {
  const ctx = await getWeakestPillarAndGoal(sb, identity.user_id);
  const targetPillar = (args.pillar || ctx.weakest_pillar || '').toLowerCase();

  let query = sb.from('products_catalog').select('*').limit(3);
  if (targetPillar) query = query.contains('pillar_tags', [targetPillar]);
  if (args.max_price) query = query.lte('price', args.max_price);

  const { data, error } = await query;
  if (error || !data) {
    return {
      ok: true,
      available: false,
      results: [],
      rationale: error?.message?.includes('relation') ? 'product_catalog_not_deployed' : 'no_matches',
    };
  }
  const filtered = (data || []).filter((p: any) => {
    if (args.exclude_ingredients?.length) {
      const ings = (p.ingredients || []).map((i: string) => i.toLowerCase());
      if (args.exclude_ingredients.some((ex) => ings.includes(ex.toLowerCase()))) return false;
    }
    return true;
  });

  const rationale = targetPillar
    ? `Picked for your ${targetPillar} pillar${ctx.compass_goal ? ` and Life Compass goal "${ctx.compass_goal}"` : ''}.`
    : 'Top picks based on community ratings.';

  return { ok: true, available: true, results: filtered.slice(0, 3), rationale };
}

export async function findPerfectPractitioner(
  sb: SupabaseClient,
  identity: Identity,
  args: {
    specialty?: string;
    goal_text?: string;
    language?: string;
    telehealth_ok?: boolean;
    max_price?: number;
  },
): Promise<{ ok: true; results: any[]; rationale: string; available: boolean }> {
  const ctx = await getWeakestPillarAndGoal(sb, identity.user_id);

  let query = sb.from('services_catalog').select('*').limit(3);
  if (args.specialty) query = query.ilike('specialty', `%${args.specialty}%`);
  if (args.language) query = query.contains('languages', [args.language]);
  if (args.telehealth_ok !== undefined) query = query.eq('telehealth_supported', args.telehealth_ok);
  if (args.max_price) query = query.lte('price', args.max_price);

  const { data, error } = await query;
  if (error || !data) {
    return {
      ok: true,
      available: false,
      results: [],
      rationale: error?.message?.includes('relation') ? 'services_catalog_not_deployed' : 'no_matches',
    };
  }

  const rationale = args.specialty
    ? `Practitioners matching "${args.specialty}"${ctx.compass_goal ? ` aligned with your goal "${ctx.compass_goal}"` : ''}.`
    : 'Top-rated practitioners matching your filters.';

  return { ok: true, available: true, results: data.slice(0, 3), rationale };
}

export async function findPerfectMatch(
  sb: SupabaseClient,
  identity: Identity,
  args: {
    intent_kind?: 'commercial_buy' | 'commercial_sell' | 'activity_seek' | 'partner_seek' | 'social_seek' | 'mutual_aid';
    goal_text?: string;
    pillar_focus?: string;
    location_radius_km?: number;
    language?: string;
  },
): Promise<{ ok: true; results: any[]; rationale: string; available: boolean }> {
  const ctx = await getWeakestPillarAndGoal(sb, identity.user_id);
  const pillar = (args.pillar_focus || ctx.weakest_pillar || '').toLowerCase();

  // Try the intent-engine's perfect-match RPC first (when deployed).
  try {
    const { data, error } = await sb.rpc('intent_matches_perfect', {
      p_user_id: identity.user_id,
      p_intent_kind: args.intent_kind || 'partner_seek',
      p_goal_text: args.goal_text || null,
      p_pillar: pillar || null,
      p_radius_km: args.location_radius_km || null,
      p_language: args.language || null,
      p_limit: 3,
    });
    if (!error && Array.isArray(data) && data.length > 0) {
      return {
        ok: true,
        available: true,
        results: data,
        rationale: `Top matches reciprocally aligned with your ${pillar || 'goals'}${ctx.compass_goal ? ` and "${ctx.compass_goal}"` : ''}.`,
      };
    }
  } catch {
    /* RPC missing — fall through to public-profile fallback */
  }

  // Fallback: visible community members who share the pillar tag.
  try {
    let q = sb
      .from('app_users')
      .select('user_id, display_name, vitana_id, archetype, pillar_strengths, languages, account_visibility')
      .eq('account_visibility', 'public')
      .neq('user_id', identity.user_id)
      .limit(3);
    if (pillar) q = q.contains('pillar_strengths', [pillar]);
    if (args.language) q = q.contains('languages', [args.language]);
    const { data, error } = await q;
    if (error || !data) {
      return { ok: true, available: false, results: [], rationale: 'matches_unavailable' };
    }
    return {
      ok: true,
      available: true,
      results: data,
      rationale: pillar
        ? `Members with strong ${pillar} who match your filters.`
        : 'Public-profile members matching your filters.',
    };
  } catch (err) {
    return { ok: true, available: false, results: [], rationale: 'matches_unavailable' };
  }
}

export async function askWhoIs(
  sb: SupabaseClient,
  args: { question: string; limit?: number },
): Promise<{ ok: true; metric: string; results: any[]; available: boolean }> {
  const q = (args.question || '').toLowerCase().trim();
  const limit = Math.min(Math.max(args.limit || 1, 1), 10);
  if (!q) {
    return { ok: true, metric: 'unknown', available: false, results: [] };
  }

  // Tiny rule-based router. The flagship voice path: voice asks question →
  // ORB gets back a single profile card (or a short ranked list when limit > 1).
  let metric: string;
  let column: string;
  let direction: 'asc' | 'desc' = 'desc';
  if (q.includes('first') && q.includes('member')) {
    metric = 'first_member';
    column = 'created_at';
    direction = 'asc';
  } else if (q.includes('newest') || q.includes('latest member')) {
    metric = 'newest_member';
    column = 'created_at';
  } else if (q.includes('youngest')) {
    metric = 'youngest_member';
    column = 'birth_date';
  } else if (q.includes('oldest')) {
    metric = 'oldest_member';
    column = 'birth_date';
    direction = 'asc';
  } else if (q.includes('vitana index') || q.includes('highest index') || q.includes('healthiest')) {
    metric = 'highest_vitana_index';
    column = 'vitana_index_score';
  } else if (q.includes('most followed') || q.includes('most followers')) {
    metric = 'most_followed';
    column = 'follower_count';
  } else if (q.includes('longest streak') || q.includes('most streak')) {
    metric = 'longest_streak';
    column = 'longest_streak_days';
  } else {
    return {
      ok: true,
      metric: 'unrouted',
      available: false,
      results: [
        {
          clarification: `Could you rephrase? Try "who has the highest vitana index?" or "who is the youngest member?"`,
        },
      ],
    };
  }

  try {
    const { data, error } = await sb
      .from('app_users')
      .select('user_id, display_name, vitana_id, archetype, account_visibility')
      .eq('account_visibility', 'public')
      .order(column, { ascending: direction === 'asc', nullsFirst: false })
      .limit(limit);
    if (error || !data) {
      return { ok: true, metric, available: false, results: [] };
    }
    return { ok: true, metric, available: true, results: data };
  } catch {
    return { ok: true, metric, available: false, results: [] };
  }
}
