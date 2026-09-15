// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in intent-matcher.ts has any test coverage today —
// test/services/find-match-exact-name.test.ts and
// test/services/conversation/intent-matches-speakable.test.ts both mock
// this module wholesale (jest.mock('.../intent-matcher', ...)).
/**
 * services/intent-matcher.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in intent-matcher.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — the source file still owns creating the client via its own
 * getSupabase() and passes it in, exactly as before.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function computeIntentMatchesRpc(sb: SupabaseClient, intentId: string, topN: number) {
  return sb.rpc('compute_intent_matches', { p_intent_id: intentId, p_top_n: topN });
}

export async function fetchIntentForCommercialFederation(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('intent_kind, category, requester_vitana_id').eq('intent_id', intentId).maybeSingle();
}

export async function fetchProductsByParentCategory(sb: SupabaseClient, parentCategory: string, limit: number) {
  return sb.from('products').select('id, name, category').eq('category', parentCategory).limit(limit);
}

export async function fetchIntentForDanceFederation(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('intent_kind, category, requester_vitana_id, kind_payload').eq('intent_id', intentId).maybeSingle();
}

export async function fetchUpcomingDanceLiveRooms(sb: SupabaseClient, nowIso: string, horizonIso: string, limit: number) {
  return sb
    .from('live_rooms')
    .select('id, title, category, starts_at, location_label, price_cents, dance_payload')
    .ilike('category', 'dance.%')
    .gte('starts_at', nowIso)
    .lte('starts_at', horizonIso)
    .limit(limit);
}

/** Reused for both the product-federation and dance-federation match-row inserts — same table/shape. */
export async function insertIntentMatchRows(sb: SupabaseClient, rows: Record<string, unknown>[]) {
  return sb.from('intent_matches').insert(rows as any);
}

export async function fetchTopIntentMatches(sb: SupabaseClient, intentId: string, limit: number) {
  return sb.from('intent_matches').select('*').eq('intent_a_id', intentId).order('score', { ascending: false }).limit(limit);
}
