/**
 * automation-handlers/business-marketplace.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * automation-handlers/business-marketplace.ts now goes through here instead
 * of being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no behavior
 * change today. Client-agnostic (takes `supabase` as a param), same
 * convention as the sibling repositories in this directory.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== services_catalog ====================

export async function fetchServiceCatalogSummary(supabase: SupabaseClient, serviceId: string) {
  return supabase.from('services_catalog').select('name, service_type, topic_keys').eq('id', serviceId).maybeSingle();
}

export async function fetchServicesByType(supabase: SupabaseClient, tenantId: string, serviceType: string, limit: number) {
  return supabase
    .from('services_catalog')
    .select('id, name, service_type, provider_name, topic_keys')
    .eq('tenant_id', tenantId)
    .eq('service_type', serviceType)
    .limit(limit);
}

export async function fetchServiceByTopicOverlap(supabase: SupabaseClient, tenantId: string, topicKeys: string[], limit: number) {
  return supabase
    .from('services_catalog')
    .select('id, name, service_type')
    .eq('tenant_id', tenantId)
    .overlaps('topic_keys', topicKeys)
    .limit(limit)
    .maybeSingle();
}

// ==================== user_topic_profile ====================

export async function fetchTopicMatchedUsers(supabase: SupabaseClient, tenantId: string, topicKeys: string[], minScore: number, limit: number) {
  return supabase
    .from('user_topic_profile')
    .select('user_id, score')
    .eq('tenant_id', tenantId)
    .in('topic_key', topicKeys)
    .gte('score', minScore)
    .order('score', { ascending: false })
    .limit(limit);
}

// ==================== relationship_edges ====================

export async function upsertServiceRelationshipEdge(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('relationship_edges').upsert(row, { onConflict: 'tenant_id,user_id,target_type,target_id' });
}

// ==================== products_catalog ====================

export async function fetchProductCatalogSummary(supabase: SupabaseClient, productId: string) {
  return supabase.from('products_catalog').select('name, product_type, topic_keys').eq('id', productId).maybeSingle();
}

export async function fetchProductTopicKeys(supabase: SupabaseClient, productId: string) {
  return supabase.from('products_catalog').select('topic_keys').eq('id', productId).maybeSingle();
}

export async function fetchProductName(supabase: SupabaseClient, productId: string) {
  return supabase.from('products_catalog').select('name').eq('id', productId).maybeSingle();
}

// ==================== recommendations ====================

export async function fetchRecommendationsByPillarOverlap(supabase: SupabaseClient, tenantId: string, topicKeys: string[], limit: number) {
  return supabase.from('recommendations').select('user_id').eq('tenant_id', tenantId).overlaps('pillar', topicKeys).limit(limit);
}

// ==================== user_offers_memory ====================

export async function upsertUserOfferMemory(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_offers_memory').upsert(row, { onConflict: 'tenant_id,user_id,target_type,target_id' });
}

export async function fetchUsedOffersInWindow(
  supabase: SupabaseClient,
  tenantId: string,
  targetType: string,
  fromIso: string,
  toIso: string,
  limit: number,
) {
  return supabase
    .from('user_offers_memory')
    .select('user_id, target_id, target_type')
    .eq('tenant_id', tenantId)
    .eq('state', 'used')
    .eq('target_type', targetType)
    .gte('updated_at', fromIso)
    .lte('updated_at', toIso)
    .limit(limit);
}

// ==================== usage_outcomes ====================

export async function countExistingOutcome(supabase: SupabaseClient, tenantId: string, userId: string, targetId: string) {
  return supabase
    .from('usage_outcomes')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('target_id', targetId);
}

// ==================== live_rooms ====================

export async function fetchRecentHostedRooms(supabase: SupabaseClient, tenantId: string, sinceIso: string, limit: number) {
  return supabase
    .from('live_rooms')
    .select('id, host_user_id, price_cents, capacity, created_at')
    .eq('tenant_id', tenantId)
    .not('host_user_id', 'is', null)
    .gte('created_at', sinceIso)
    .limit(limit);
}

export async function fetchRoomCategoriesInWindow(supabase: SupabaseClient, tenantId: string, sinceIso: string, limit: number) {
  return supabase.from('live_rooms').select('category, topic_keys').eq('tenant_id', tenantId).gte('created_at', sinceIso).limit(limit);
}

export async function fetchRoomHostIds(supabase: SupabaseClient, tenantId: string, limit: number) {
  return supabase.from('live_rooms').select('host_user_id').eq('tenant_id', tenantId).not('host_user_id', 'is', null).limit(limit);
}

// ==================== app_users ====================

export async function fetchVitanaIdsForUsers(supabase: SupabaseClient, userIds: string[]) {
  return supabase.from('app_users').select('user_id, vitana_id').in('user_id', userIds);
}

// ==================== live_room_attendance ====================

export async function countAttendanceForRooms(supabase: SupabaseClient, roomIds: string[], sinceIso: string) {
  return supabase
    .from('live_room_attendance')
    .select('id', { count: 'exact', head: true })
    .in('live_room_id', roomIds)
    .gte('joined_at', sinceIso);
}

// ==================== service_payments ====================

export async function fetchServicePaymentsForPayee(supabase: SupabaseClient, payeeVitanaId: string, states: string[], sinceIso: string) {
  return supabase
    .from('service_payments')
    .select('amount_cents')
    .eq('payee_vitana_id', payeeVitanaId)
    .in('state', states)
    .gte('created_at', sinceIso);
}
