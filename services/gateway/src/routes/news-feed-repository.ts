// Coverage note: test/news-feed.test.ts exercises this route against a
// mocked '../src/lib/supabase' client (a functional fake, not a
// wholesale mock of this repository module), so these wrappers get
// genuine coverage, not a documented zero.
/**
 * routes/news-feed.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in news-feed.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * `fetchVitanaIndexScoresForUsersSince` resolves the terminal await
 * inside an async function (rather than returning a partial builder)
 * so the source's optional tenant_id conditional `.eq()` step still
 * runs before the query executes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchSpotlightConsentedProfiles(sb: SupabaseClient) {
  return sb.from('profiles').select('user_id, display_name, avatar_url').eq('index_spotlight_consent', true);
}

export async function fetchVitanaIndexScoresForUsersSince(
  sb: SupabaseClient,
  args: { userIds: string[]; sinceIso: string; tenantId: string | null },
) {
  let query = sb
    .from('vitana_index_scores')
    .select('user_id, date, score_total')
    .in('user_id', args.userIds)
    .gte('date', args.sinceIso)
    .order('date', { ascending: true });
  if (args.tenantId) query = query.eq('tenant_id', args.tenantId);
  return query;
}
