// Coverage note: test/routes/discover-recommendations-public.test.ts
// exercises this route against a mocked '../../src/lib/supabase' client
// (a functional fake, not a wholesale mock of this repository module),
// so these wrappers get genuine coverage, not a documented zero.
/**
 * routes/discover-recommendations-public.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in discover-recommendations-public.ts
 * now goes through here instead of being written inline. PURE MOVE, not
 * a rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchProfileUserIdByVitanaId(sb: SupabaseClient, vitanaId: string) {
  return sb.from('profiles').select('user_id').eq('vitana_id', vitanaId).maybeSingle();
}

export async function fetchGlobalCommunityProfileVisibility(sb: SupabaseClient, userId: string) {
  return sb.from('global_community_profiles').select('is_visible').eq('user_id', userId).maybeSingle();
}

export async function fetchActiveProductRecommendations(sb: SupabaseClient, userId: string, maxItems: number) {
  return sb
    .from('product_recommendations')
    .select('id, product_id, created_at, products(title, images)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(maxItems);
}
