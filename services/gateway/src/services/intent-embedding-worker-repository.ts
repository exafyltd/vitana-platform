// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references intent-embedding-worker.ts — zero coverage today.
/**
 * services/intent-embedding-worker.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-embedding-worker.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUnembeddedUserIntents(sb: SupabaseClient, batchSize: number) {
  return sb
    .from('user_intents')
    .select('intent_id, intent_kind, category, title, scope, kind_payload')
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .limit(batchSize);
}

export async function updateUserIntentEmbedding(sb: SupabaseClient, intentId: string, embedding: unknown) {
  return sb.from('user_intents').update({ embedding: embedding as any }).eq('intent_id', intentId);
}
