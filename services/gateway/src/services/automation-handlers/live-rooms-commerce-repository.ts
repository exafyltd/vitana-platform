/**
 * automation-handlers/live-rooms-commerce.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * automation-handlers/live-rooms-commerce.ts now goes through here instead
 * of being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no behavior
 * change today. Client-agnostic (takes `supabase` as a param), same
 * convention as the sibling repositories in this directory. Deliberately
 * self-contained (not sharing functions with business-marketplace-repository.ts
 * even where a query looks similar) — several near-identical-looking calls
 * differ in an easy-to-miss way (column list, or an extra filter), and a
 * pure move must preserve each call site's own shape exactly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== live_rooms ====================

export async function fetchRoomTitleAndStart(supabase: SupabaseClient, roomId: string) {
  return supabase.from('live_rooms').select('title, starts_at').eq('id', roomId).maybeSingle();
}

export async function fetchRoomTitleAndTopics(supabase: SupabaseClient, roomId: string) {
  return supabase.from('live_rooms').select('title, topic_keys').eq('id', roomId).maybeSingle();
}

export async function fetchRoomTitle(supabase: SupabaseClient, roomId: string) {
  return supabase.from('live_rooms').select('title').eq('id', roomId).maybeSingle();
}

export async function fetchEndedRoomsSince(supabase: SupabaseClient, tenantId: string, sinceIso: string) {
  return supabase
    .from('live_rooms')
    .select('host_user_id, topic_keys')
    .eq('tenant_id', tenantId)
    .eq('status', 'ended')
    .gte('created_at', sinceIso);
}

export async function fetchRoomTitleAndHost(supabase: SupabaseClient, roomId: string) {
  return supabase.from('live_rooms').select('title, host_user_id').eq('id', roomId).maybeSingle();
}

export async function fetchRecentHostedRoomsWithPricing(supabase: SupabaseClient, tenantId: string, sinceIso: string, limit: number) {
  return supabase
    .from('live_rooms')
    .select('id, host_user_id, price_cents, capacity')
    .eq('tenant_id', tenantId)
    .not('host_user_id', 'is', null)
    .gte('created_at', sinceIso)
    .limit(limit);
}

// ==================== live_room_sessions ====================

export async function fetchScheduledSessionsInWindow(supabase: SupabaseClient, tenantId: string, fromIso: string, toIso: string) {
  return supabase
    .from('live_room_sessions')
    .select('id, room_id, max_participants, topic_keys')
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled')
    .gte('starts_at', fromIso)
    .lte('starts_at', toIso);
}

// ==================== live_room_attendance ====================

export async function fetchRecentAttendeeUserIds(supabase: SupabaseClient, tenantId: string, sinceIso: string) {
  return supabase.from('live_room_attendance').select('user_id').eq('tenant_id', tenantId).gte('joined_at', sinceIso);
}

export async function countAttendanceForRoom(supabase: SupabaseClient, roomId: string) {
  return supabase.from('live_room_attendance').select('id', { count: 'exact', head: true }).eq('live_room_id', roomId);
}

export async function countAttendanceForRoomIds(supabase: SupabaseClient, roomIds: string[]) {
  return supabase.from('live_room_attendance').select('id', { count: 'exact', head: true }).in('live_room_id', roomIds);
}

// ==================== services_catalog ====================

export async function fetchAnyTenantService(supabase: SupabaseClient, tenantId: string, limit: number) {
  return supabase.from('services_catalog').select('id, name, service_type').eq('tenant_id', tenantId).limit(limit).maybeSingle();
}

export async function fetchServicesByTypeWithProvider(supabase: SupabaseClient, tenantId: string, serviceType: string, limit: number) {
  return supabase
    .from('services_catalog')
    .select('id, name, service_type, provider_name')
    .eq('tenant_id', tenantId)
    .eq('service_type', serviceType)
    .limit(limit);
}

// ==================== user_interests ====================

export async function fetchInterestedUsers(supabase: SupabaseClient, topics: string[], minConfidence: number, limit: number) {
  return supabase.from('user_interests').select('user_id').in('interest', topics).gte('confidence_score', minConfidence).limit(limit);
}

// ==================== app_users ====================

export async function fetchOnboardedCreators(supabase: SupabaseClient, onboardedBeforeIso: string) {
  return supabase.from('app_users').select('user_id, display_name').eq('stripe_charges_enabled', true).lte('stripe_onboarded_at', onboardedBeforeIso);
}

export async function fetchVitanaIdsForUsers(supabase: SupabaseClient, userIds: string[]) {
  return supabase.from('app_users').select('user_id, vitana_id').in('user_id', userIds);
}

export async function countRoomsByHost(supabase: SupabaseClient, hostUserId: string) {
  return supabase.from('live_rooms').select('id', { count: 'exact', head: true }).eq('host_user_id', hostUserId);
}

// ==================== live_highlights ====================

export async function fetchRecentHighlights(supabase: SupabaseClient, tenantId: string, roomId: string, limit: number) {
  return supabase
    .from('live_highlights')
    .select('highlight_type, text')
    .eq('tenant_id', tenantId)
    .eq('live_room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(limit);
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
