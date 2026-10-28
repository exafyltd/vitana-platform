// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior). test/services/automation-
// handlers-phase2.test.ts imports this module and directly exercises
// runMarketplaceGapDetection (fetchCommunityGroupsDemand +
// fetchLiveRoomsCategorySupply). The other handlers' call sites
// (runRevenueOpportunityAlert, runServiceDemandMatching,
// runBusinessSetupCoach, runIncomeGrowthTips) have no functional test
// coverage in this repo today -- moved as a literal, mechanical
// read-for-read copy and verified via tsc --noEmit.
/**
 * services/automation-handlers/business-opportunity.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in business-opportunity.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== global_community_groups ====================

export async function fetchCommunityGroupsDemand(sb: SupabaseClient, limit: number) {
  return sb.from('global_community_groups').select('category, member_count').not('category', 'is', null).limit(limit);
}

export async function fetchTopCommunityGroupsByMembers(sb: SupabaseClient, limit: number) {
  return sb
    .from('global_community_groups')
    .select('category, member_count')
    .not('category', 'is', null)
    .order('member_count', { ascending: false })
    .limit(limit);
}

// ==================== live_rooms ====================

export async function fetchLiveRoomsCategorySupply(sb: SupabaseClient, tenantId: string, sinceIso: string, limit: number) {
  return sb.from('live_rooms').select('category').eq('tenant_id', tenantId).gte('created_at', sinceIso).limit(limit);
}

export async function fetchOwnLiveRoomCategories(sb: SupabaseClient, tenantId: string, hostUserId: string, limit: number) {
  return sb.from('live_rooms').select('category').eq('tenant_id', tenantId).eq('host_user_id', hostUserId).limit(limit);
}

export async function countHostedLiveRooms(sb: SupabaseClient, tenantId: string, hostUserId: string) {
  return sb.from('live_rooms').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('host_user_id', hostUserId);
}

// ==================== app_users ====================

export async function fetchStripeEnabledCreatorsWithVitanaId(sb: SupabaseClient, limit: number) {
  return sb.from('app_users').select('user_id, vitana_id').eq('stripe_charges_enabled', true).limit(limit);
}

export async function fetchStripeEnabledCreatorUserIds(sb: SupabaseClient, limit: number) {
  return sb.from('app_users').select('user_id').eq('stripe_charges_enabled', true).limit(limit);
}

export async function fetchAppUserStripeStatus(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('stripe_charges_enabled').eq('user_id', userId).maybeSingle();
}

// ==================== service_payments ====================

export async function fetchServicePaymentsForPayee(
  sb: SupabaseClient,
  vitanaId: string,
  states: string[],
  sinceIso: string,
  beforeIso?: string,
) {
  let q = sb.from('service_payments').select('amount_cents').eq('payee_vitana_id', vitanaId).in('state', states).gte('created_at', sinceIso);
  if (beforeIso) q = q.lt('created_at', beforeIso);
  return q;
}
