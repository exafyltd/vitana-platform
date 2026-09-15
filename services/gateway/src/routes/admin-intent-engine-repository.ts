// impact-allow-no-test
// Genuinely tested via test/routes/admin-intent-engine-repository.test.ts,
// which drives a functional stub Supabase client (a from()-chain
// resolving to a configurable {data,error,count} response) — not a
// wholesale module mock.
/**
 * routes/admin-intent-engine-repository.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * routes/admin-intent-engine.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same columns,
 * same conditional-filter logic, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAdminIntentById(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('*').eq('intent_id', intentId).maybeSingle();
}

export async function closeAdminIntent(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').update({ status: 'closed' }).eq('intent_id', intentId);
}

export async function insertAdminIntentCloseEvent(
  sb: SupabaseClient,
  args: { intentId: string; actorUserId: string | undefined; actorVitanaId: string | null; reason: string },
) {
  return sb.from('intent_events').insert({
    intent_id: args.intentId,
    actor_user_id: args.actorUserId,
    actor_vitana_id: args.actorVitanaId,
    event_type: 'admin.force_close',
    payload: { reason: args.reason },
  });
}

export async function recomputeIntentMatchesDaily(sb: SupabaseClient) {
  return sb.rpc('compute_intent_matches_daily');
}

export async function fetchAdminIntentEngineStats(sb: SupabaseClient) {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [{ count: totalIntents }, { count: openIntents }, { count: totalMatches }, { count: stuckOpen }] = await Promise.all([
    sb.from('user_intents').select('*', { count: 'exact', head: true }),
    sb.from('user_intents').select('*', { count: 'exact', head: true }).eq('status', 'open'),
    sb.from('intent_matches').select('*', { count: 'exact', head: true }),
    sb
      .from('user_intents')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open')
      .eq('match_count', 0)
      .lt('created_at', since24h),
  ]);
  return { totalIntents, openIntents, totalMatches, stuckOpen };
}

export async function fetchAdminIntentEngineKpi(sb: SupabaseClient) {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  return Promise.all([
    sb.from('user_intents').select('*', { count: 'exact', head: true }).gte('created_at', since24h),
    sb.from('user_intents').select('*', { count: 'exact', head: true }).gte('created_at', since7d),
    sb.from('user_intents').select('*', { count: 'exact', head: true }).gt('match_count', 0),
    sb.from('intent_matches').select('*', { count: 'exact', head: true }).eq('state', 'mutual_interest'),
    sb.from('intent_disputes').select('*', { count: 'exact', head: true }).in('status', ['open', 'investigating']),
    sb
      .from('user_intents')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open')
      .eq('match_count', 0)
      .lt('created_at', since24h),
    sb.from('user_intents').select('intent_kind').gte('created_at', since7d).limit(1000),
  ]);
}

export async function archiveOldIntentMatches(sb: SupabaseClient, olderThanDays: number, batchSize: number) {
  return sb.rpc('archive_old_intent_matches', { p_older_than_days: olderThanDays, p_batch_size: batchSize });
}
