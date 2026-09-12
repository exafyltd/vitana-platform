/**
 * voice-tools/community-member-ranker.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in voice-tools/community-member-ranker.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic
 * (including the raw `.filter('col::text', 'ilike', ...)` JSONB-cast
 * filters), same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param) — the ranker receives its client per-call, not a
 * module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== global_community_profiles ====================

export async function fetchVisibleProfileUserIds(sb: SupabaseClient) {
  return sb.from('global_community_profiles').select('user_id').eq('is_visible', true);
}

// ==================== profiles ====================

export async function fetchViewerCityCountry(sb: SupabaseClient, viewerUserId: string) {
  return sb.from('profiles').select('city, country').eq('user_id', viewerUserId).maybeSingle();
}

export async function fetchProfilesByIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('profiles').select('user_id, full_name, display_name, handle, city, country, registration_seq').in('user_id', userIds);
}

export async function searchServiceOfferingsByKeyword(sb: SupabaseClient, kwLike: string) {
  return sb.from('profiles').select('user_id, service_offerings').filter('service_offerings::text', 'ilike', kwLike).limit(50);
}

export async function searchTeachingServiceOfferings(sb: SupabaseClient) {
  return sb
    .from('profiles')
    .select('user_id, service_offerings')
    .or('service_offerings::text.ilike.%teaching%,service_offerings::text.ilike.%coaching%,service_offerings::text.ilike.%mentoring%,service_offerings::text.ilike.%instructor%')
    .limit(100);
}

export async function searchEducationServiceOfferings(sb: SupabaseClient) {
  return sb.from('profiles').select('user_id, service_offerings').filter('service_offerings::text', 'ilike', '%education%').limit(50);
}

// ==================== app_users ====================

export async function fetchUsersByIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, display_name, vitana_id').in('user_id', userIds);
}

export async function searchBioByKeyword(sb: SupabaseClient, kwLike: string) {
  return sb.from('app_users').select('user_id, bio').ilike('bio', kwLike).limit(50);
}

export async function fetchUserCreatedAt(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('created_at').eq('user_id', userId).maybeSingle();
}

// ==================== memory_facts ====================

export async function searchMemoryFactsByKeyword(sb: SupabaseClient, kwLike: string) {
  return sb
    .from('memory_facts')
    .select('user_id, fact_key, fact_value, provenance_source')
    .or(`fact_key.ilike.${kwLike},fact_value.ilike.${kwLike}`)
    .in('provenance_source', ['user_stated', 'assistant_inferred'])
    .limit(50);
}

export async function fetchYearsExperienceFacts(sb: SupabaseClient, userId: string) {
  return sb.from('memory_facts').select('fact_key, fact_value').eq('user_id', userId).ilike('fact_key', 'years_experience_%').limit(5);
}

export async function searchExpertiseFacts(sb: SupabaseClient) {
  return sb.from('memory_facts').select('user_id, fact_key, fact_value').or('fact_key.ilike.expert_in_%,fact_key.ilike.certified_%,fact_key.ilike.degree_%').limit(100);
}

// ==================== health_features_daily ====================

export async function searchHealthFeaturesByKeyword(sb: SupabaseClient, kwLike: string) {
  return sb.from('health_features_daily').select('user_id, feature_key').ilike('feature_key', kwLike).limit(200);
}

// ==================== community_groups ====================

export async function searchGroupsByTopicOrName(sb: SupabaseClient, kwLike: string) {
  return sb.from('community_groups').select('id, name, topic_key').or(`topic_key.ilike.${kwLike},name.ilike.${kwLike}`).limit(20);
}

export async function searchEntertainmentGroups(sb: SupabaseClient) {
  return sb
    .from('community_groups')
    .select('id, name, topic_key')
    .or('topic_key.ilike.%entertainment%,topic_key.ilike.%fun%,topic_key.ilike.%music%,topic_key.ilike.%comedy%,topic_key.ilike.%dance%,name.ilike.%entertainment%,name.ilike.%comedy%')
    .limit(20);
}

// ==================== community_group_members ====================

export async function fetchGroupMembersByGroupIds(sb: SupabaseClient, groupIds: string[]) {
  return sb.from('community_group_members').select('user_id, group_id').in('group_id', groupIds).limit(500);
}

// ==================== vitana_index_scores ====================

export async function fetchRecentIndexScoresSince(sb: SupabaseClient, sinceDate: string) {
  return sb.from('vitana_index_scores').select('user_id, score_total, date').gte('date', sinceDate).order('date', { ascending: false }).limit(2000);
}

export async function fetchTopMentalPillarScores(sb: SupabaseClient) {
  return sb.from('vitana_index_scores').select('user_id, score_mental, date').order('score_mental', { ascending: false }).order('date', { ascending: false }).limit(50);
}
