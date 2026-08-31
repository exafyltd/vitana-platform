/**
 * orb-tools/discovery-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in orb-tools/
 * discovery-tools.ts now goes through here instead of being written
 * inline. PURE MOVE, not a rewrite: same queries, same columns, same
 * conditional-filter logic, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param) — tools receive their
 * client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== life_compass / vitana_index_scores ====================

export async function fetchLifeCompassGoal(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('primary_goal, category')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchLatestVitanaIndexScore(sb: SupabaseClient, userId: string) {
  return sb
    .from('vitana_index_scores')
    .select('pillars')
    .eq('user_id', userId)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

// ==================== global_search lanes ====================

export async function searchProfilesByNameOrHandle(sb: SupabaseClient, safe: string, limit: number) {
  return sb
    .from('profiles')
    .select('user_id, display_name, handle, vitana_id, city')
    .or(`display_name.ilike.*${safe}*,handle.ilike.*${safe}*`)
    .limit(limit);
}

export async function searchPublicPosts(sb: SupabaseClient, query: string, limit: number) {
  return sb
    .from('profile_posts')
    .select('id, user_id, content, created_at')
    .eq('is_public', true)
    .neq('moderation_status', 'rejected')
    .ilike('content', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function searchUpcomingEventsForGlobalSearch(sb: SupabaseClient, safe: string, limit: number) {
  return sb
    .from('global_community_events')
    .select('id, title, start_time, location')
    .gte('start_time', new Date().toISOString())
    .or(`title.ilike.*${safe}*,description.ilike.*${safe}*`)
    .order('start_time', { ascending: true })
    .limit(limit);
}

export async function searchTenantGroups(sb: SupabaseClient, tenantId: string | null, safe: string, limit: number) {
  return sb
    .from('community_groups')
    .select('id, name, topic_key, description')
    .eq('tenant_id', tenantId)
    .eq('is_public', true)
    .or(`name.ilike.*${safe}*,description.ilike.*${safe}*,topic_key.ilike.*${safe}*`)
    .limit(limit);
}

export async function searchTenantProducts(sb: SupabaseClient, tenantId: string | null, query: string, limit: number) {
  return sb
    .from('products_catalog')
    .select('id, name, product_type')
    .eq('tenant_id', tenantId)
    .ilike('name', `%${query}%`)
    .limit(limit);
}

export async function searchTenantServices(sb: SupabaseClient, tenantId: string | null, query: string, limit: number) {
  return sb
    .from('services_catalog')
    .select('id, name, service_type, provider_name')
    .eq('tenant_id', tenantId)
    .ilike('name', `%${query}%`)
    .limit(limit);
}

// ==================== autopilot_recommendations ====================

export async function fetchRecommendationById(sb: SupabaseClient, id: string) {
  return sb.from('autopilot_recommendations').select('*').eq('id', id).maybeSingle();
}

export async function searchRecommendations(
  sb: SupabaseClient,
  userId: string,
  statuses: string[] | null,
  refSafe: string | null
) {
  let q = sb
    .from('autopilot_recommendations')
    .select('*')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('created_at', { ascending: false })
    .limit(5);
  if (statuses && statuses.length > 0) q = q.in('status', statuses);
  if (refSafe) q = q.or(`title.ilike.*${refSafe}*,summary.ilike.*${refSafe}*`);
  return q;
}

export async function snoozeAutopilotRecommendation(sb: SupabaseClient, recommendationId: string, hours: number) {
  return sb.rpc('snooze_autopilot_recommendation', { p_recommendation_id: recommendationId, p_hours: hours });
}

export async function rejectAutopilotRecommendation(sb: SupabaseClient, recommendationId: string, reason: string | null) {
  return sb.rpc('reject_autopilot_recommendation', { p_recommendation_id: recommendationId, p_reason: reason });
}

// ==================== user_intents ====================

const INTENT_COLS = 'intent_id, intent_kind, category, title, scope, status, created_at';

export async function fetchIntentById(sb: SupabaseClient, intentId: string, requesterUserId: string) {
  return sb.from('user_intents').select(INTENT_COLS).eq('intent_id', intentId).eq('requester_user_id', requesterUserId).maybeSingle();
}

export async function searchMyIntents(sb: SupabaseClient, requesterUserId: string, activeStatuses: string[], refSafe: string | null) {
  let q = sb
    .from('user_intents')
    .select(INTENT_COLS)
    .eq('requester_user_id', requesterUserId)
    .in('status', activeStatuses)
    .order('created_at', { ascending: false })
    .limit(5);
  if (refSafe) q = q.or(`title.ilike.*${refSafe}*,scope.ilike.*${refSafe}*,category.ilike.*${refSafe}*`);
  return q;
}

export async function updateMyIntent(sb: SupabaseClient, intentId: string, requesterUserId: string, patch: Record<string, unknown>) {
  return sb
    .from('user_intents')
    .update(patch)
    .eq('intent_id', intentId)
    .eq('requester_user_id', requesterUserId)
    .select('intent_id, title, scope, category')
    .maybeSingle();
}

export async function closeMyIntent(sb: SupabaseClient, intentId: string, requesterUserId: string) {
  return sb
    .from('user_intents')
    .update({ status: 'closed' })
    .eq('intent_id', intentId)
    .eq('requester_user_id', requesterUserId)
    .select('intent_id')
    .maybeSingle();
}

export async function fetchIntentBoard(sb: SupabaseClient, tenantId: string | null, excludeUserId: string, limit: number, querySafe: string | null) {
  let q = sb
    .from('user_intents')
    .select('intent_id, intent_kind, category, title, scope, created_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .neq('requester_user_id', excludeUserId)
    .neq('intent_kind', 'partner_seek')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (querySafe) q = q.or(`title.ilike.*${querySafe}*,scope.ilike.*${querySafe}*,category.ilike.*${querySafe}*`);
  return q;
}

export async function fetchMyIntentIds(sb: SupabaseClient, requesterUserId: string, limit: number) {
  return sb.from('user_intents').select('intent_id').eq('requester_user_id', requesterUserId).order('created_at', { ascending: false }).limit(limit);
}

// ==================== intent_matches ====================

export async function fetchRecentMatchesForIntents(sb: SupabaseClient, intentIdCsv: string, limit: number) {
  return sb
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, state, created_at')
    .or(`intent_a_id.in.(${intentIdCsv}),intent_b_id.in.(${intentIdCsv})`)
    .order('created_at', { ascending: false })
    .limit(limit);
}
