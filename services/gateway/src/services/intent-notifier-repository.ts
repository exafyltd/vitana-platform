// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references intent-notifier.ts — zero coverage today.
/**
 * services/intent-notifier.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-notifier.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchIntentSummaryById(sb: SupabaseClient, intentId: string) {
  return sb
    .from('user_intents')
    .select('intent_id, requester_user_id, requester_vitana_id, tenant_id, category, title, intent_kind')
    .eq('intent_id', intentId)
    .maybeSingle();
}

export async function fetchIntentMatchById(sb: SupabaseClient, matchId: string) {
  return sb
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, vitana_id_a, vitana_id_b, kind_pairing, score, compass_aligned')
    .eq('match_id', matchId)
    .maybeSingle();
}

export async function insertSeedChatMessage(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('chat_messages').insert(row);
}
