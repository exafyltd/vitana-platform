// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references proactive-match-messenger.ts — zero coverage
// today.
/**
 * services/proactive-match-messenger.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in proactive-match-messenger.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchExistingProactiveMessage(sb: SupabaseClient, senderId: string, receiverId: string, tenantId: string, date: string) {
  return sb
    .from('chat_messages')
    .select('id')
    .eq('sender_id', senderId)
    .eq('receiver_id', receiverId)
    .eq('tenant_id', tenantId)
    .contains('metadata', { proactive_match_date: date })
    .limit(1);
}

export async function fetchTopDailyMatches(sb: SupabaseClient, userId: string, date: string, minScore: number, maxMatches: number) {
  return sb
    .from('matches_daily')
    .select('id, match_type, target_id, score, reasons')
    .eq('user_id', userId)
    .eq('match_date', date)
    .eq('state', 'suggested')
    .gte('score', minScore)
    .order('score', { ascending: false })
    .limit(maxMatches);
}

export async function fetchMatchTargets(sb: SupabaseClient, targetIds: string[]) {
  return sb.from('match_targets').select('id, display_name, topic_keys, tags, metadata, target_type').in('id', targetIds);
}

export async function countSuggestedDailyMatches(sb: SupabaseClient, userId: string, date: string) {
  return sb.from('matches_daily').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('match_date', date).eq('state', 'suggested');
}

export async function fetchUserMatchRevealPreference(sb: SupabaseClient, userId: string) {
  return sb.from('user_match_preferences').select('reveal_identity_mode').eq('user_id', userId).single();
}

export function insertProactiveMatchChatMessage(
  sb: SupabaseClient,
  payload: { tenant_id: string; sender_id: string; receiver_id: string; content: string; message_type: string; metadata: Record<string, unknown> },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('chat_messages').insert(payload);
}
