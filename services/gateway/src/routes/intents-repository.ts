// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/intents.ts — zero coverage today.
/**
 * routes/intents.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in this file now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries/RPC names, same columns, same conditional-
 * filter logic, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchRecentOpenIntentsForDedup(sb: SupabaseClient, userId: string, intentKind: string, since: string) {
  return sb
    .from('user_intents')
    .select('intent_id, requester_vitana_id, title, scope, category, kind_payload, created_at')
    .eq('requester_user_id', userId)
    .eq('intent_kind', intentKind)
    .eq('status', 'open')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);
}

export async function insertUserIntent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_intents').insert(row).select('intent_id, requester_vitana_id').single();
}

export function promoteUserProvidedCover(sb: SupabaseClient, intentId: string, coverUrl: string): PromiseLike<{ error: { message?: string } | null }> {
  return sb.from('user_intents').update({ cover_url: coverUrl, cover_source: 'user_upload' }).eq('intent_id', intentId);
}

export async function updateIntentEmbedding(sb: SupabaseClient, intentId: string, embedding: unknown) {
  return sb.from('user_intents').update({ embedding: embedding as any }).eq('intent_id', intentId);
}

export async function fetchIntentVisibilityForMatchmakerPoll(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('intent_id, requester_user_id, visibility').eq('intent_id', intentId).maybeSingle();
}

export async function fetchIntentMatchRecommendation(sb: SupabaseClient, intentId: string) {
  return sb
    .from('intent_match_recommendations')
    .select('intent_id, status, mode, pool_size, candidates, counter_questions, voice_readback, reasoning_summary, used_fallback, model, latency_ms, error, computed_at, updated_at')
    .eq('intent_id', intentId)
    .maybeSingle();
}

export async function fetchOwnIntents(sb: SupabaseClient, userId: string, limit: number, kind: string | undefined, status: string | undefined) {
  let q = sb.from('user_intents').select('*').eq('requester_user_id', userId).order('created_at', { ascending: false }).limit(limit);
  if (kind) q = q.eq('intent_kind', kind);
  if (status) q = q.eq('status', status);
  return q;
}

/** Reused by both the GET-detail and GET-matches visibility checks. */
export async function canReadIntentRpc(sb: SupabaseClient, readerUserId: string, intentId: string) {
  return sb.rpc('can_read_intent', { p_reader: readerUserId, p_intent_id: intentId });
}

export async function fetchIntentById(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('*').eq('intent_id', intentId).maybeSingle();
}

export async function updateOwnIntent(sb: SupabaseClient, intentId: string, userId: string, patch: Record<string, unknown>) {
  return sb.from('user_intents').update(patch).eq('intent_id', intentId).eq('requester_user_id', userId).select('*').maybeSingle();
}

export async function closeOwnIntent(sb: SupabaseClient, intentId: string, userId: string) {
  return sb.from('user_intents').update({ status: 'closed' }).eq('intent_id', intentId).eq('requester_user_id', userId).select('*').maybeSingle();
}

export async function fetchIntentForCoverGenerate(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('intent_id, requester_user_id, category').eq('intent_id', intentId).maybeSingle();
}
