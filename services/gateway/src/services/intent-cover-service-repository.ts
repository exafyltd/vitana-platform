// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// test/intent-cover-service.test.ts, which covers every call site here.
/**
 * services/intent-cover-service.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Covers only the Postgres `.from(...)` table queries in
 * intent-cover-service.ts. The `supabase.storage.from(BUCKET)` calls in the
 * same file are Supabase Storage (object storage), not Postgres — out of
 * scope for the Aurora seam, which only concerns the Postgres data store.
 * PURE MOVE, not a rewrite: same queries, same columns, same conditional-
 * filter logic, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserGenderProfile(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('gender').eq('user_id', userId).maybeSingle();
}

export async function fetchUserUniversalCoverProfile(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('universal_intent_cover_url').eq('user_id', userId).maybeSingle();
}

export async function fetchUserLibraryCoversForCategory(sb: SupabaseClient, userId: string, category: string) {
  return sb.from('user_intent_cover_library').select('cover_url').eq('user_id', userId).eq('category', category);
}

export async function countRecentCoverGenerations(sb: SupabaseClient, userId: string, sinceIso: string) {
  return sb
    .from('user_intents')
    .select('intent_id', { count: 'exact', head: true })
    .eq('requester_user_id', userId)
    .gte('cover_generated_at', sinceIso);
}

export async function updateIntentCover(sb: SupabaseClient, intentId: string, userId: string, patch: Record<string, unknown>) {
  return sb.from('user_intents').update(patch).eq('intent_id', intentId).eq('requester_user_id', userId);
}

export async function fetchIntentForCoverGen(sb: SupabaseClient, intentId: string) {
  return sb
    .from('user_intents')
    .select('intent_id, requester_user_id, cover_url, cover_source, category')
    .eq('intent_id', intentId)
    .maybeSingle();
}
