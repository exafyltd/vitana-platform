// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/intents-share.ts — zero coverage today.
/**
 * routes/intents-share.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchIntentForShare(sb: SupabaseClient, intentId: string) {
  return sb
    .from('user_intents')
    .select('intent_id, requester_user_id, requester_vitana_id, intent_kind, category, title, scope, visibility, status, tenant_id')
    .eq('intent_id', intentId)
    .maybeSingle();
}

export async function resolveRecipientsByVitanaId(sb: SupabaseClient, recipientIds: string[]) {
  return sb.from('profiles').select('user_id, vitana_id, display_name').in('vitana_id', recipientIds);
}

export async function fetchExistingDirectShares(sb: SupabaseClient, intentId: string, recipientVids: string[]) {
  return sb
    .from('intent_matches')
    .select('vitana_id_b')
    .eq('intent_a_id', intentId)
    .eq('kind_pairing', 'direct_share')
    .in('vitana_id_b', recipientVids);
}

export async function insertDirectShareMatches(sb: SupabaseClient, matchRows: unknown[]) {
  return sb.from('intent_matches').insert(matchRows as any).select('match_id, vitana_id_b');
}

export function insertShareChatMessages(sb: SupabaseClient, messageRows: unknown[]): PromiseLike<{ error: unknown }> {
  return sb.from('chat_messages').insert(messageRows as any);
}

export async function fetchIntentForPublicView(sb: SupabaseClient, intentId: string) {
  return sb
    .from('user_intents')
    .select('intent_id, requester_vitana_id, intent_kind, category, title, scope, visibility, created_at')
    .eq('intent_id', intentId)
    .maybeSingle();
}
