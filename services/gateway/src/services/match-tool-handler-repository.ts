// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references match-tool-handler.ts — zero coverage today.
/**
 * services/match-tool-handler.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in match-tool-handler.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchSuggestedMatchesForDate(
  sb: SupabaseClient,
  userId: string,
  date: string,
  minScore: number,
  matchType: string | undefined,
  fetchLimit: number,
) {
  let query = sb
    .from('matches_daily')
    .select('id, match_type, target_id, score, reasons, state')
    .eq('user_id', userId)
    .eq('match_date', date)
    .eq('state', 'suggested')
    .gte('score', minScore)
    .order('score', { ascending: false });

  if (matchType) {
    query = query.eq('match_type', matchType);
  }

  return query.limit(fetchLimit);
}

export async function fetchMatchTargetsByIds(sb: SupabaseClient, targetIds: string[], topicFilter: string | undefined) {
  let query = sb.from('match_targets').select('id, display_name, topic_keys, tags, metadata, target_type').in('id', targetIds);
  if (topicFilter) {
    query = query.contains('topic_keys', [topicFilter]);
  }
  return query;
}

export async function countSuggestedMatchesForDate(sb: SupabaseClient, userId: string, date: string) {
  return sb
    .from('matches_daily')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('match_date', date)
    .eq('state', 'suggested');
}

export async function fetchUserMatchRevealMode(sb: SupabaseClient, userId: string) {
  return sb.from('user_match_preferences').select('reveal_identity_mode').eq('user_id', userId).single();
}
