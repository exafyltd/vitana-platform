// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// personalization-engines.ts itself IS genuinely exercised by
// test/services/automation-handlers-phase2.test.ts (imported directly, not
// jest.mock()'d — a fake stateful `.from()` client is injected via
// ctx.supabase), covering runSocialComfortAwareSuggestions (AP-0801) and
// runOpportunitySurfacingAutomation (AP-0803). runTasteAlignedEventRecommendations
// (AP-0802), runLifeStageAwareCommunication (AP-0804), and
// runOverloadDetectionThrottle (AP-0805) are registered/wiring-checked but
// have no dedicated behavioral test in that file.
/**
 * services/automation-handlers/personalization-engines.ts — Aurora migration
 * B1 data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared shape behind the AP-0801 (line 32) and AP-0802 (line 110) "did we
 * already suggest this to this user recently" checks — identical query,
 * differing only in the runtime `automationId`/`cooldownCutoff` values.
 */
export async function fetchRecentAutomationSuggestion(
  sb: SupabaseClient,
  userId: string,
  automationId: string,
  cooldownCutoff: string,
) {
  return sb
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: automationId })
    .gte('created_at', cooldownCutoff)
    .limit(1);
}

export async function countUserConnections(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected');
}

export async function fetchUpcomingCommunityEventsByType(sb: SupabaseClient, nowIso: string, lookaheadIso: string) {
  return sb
    .from('global_community_events')
    .select('id, title, event_type, start_time')
    .gte('start_time', nowIso)
    .lte('start_time', lookaheadIso)
    .not('event_type', 'is', null)
    .limit(100);
}

export async function fetchTopUserInterests(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_interests')
    .select('interest')
    .eq('user_id', userId)
    .order('confidence_score', { ascending: false })
    .limit(10);
}

export async function fetchExpiringUnengagedOpportunities(
  sb: SupabaseClient,
  tenantId: string,
  nowIso: string,
  soonIso: string,
  limit: number,
) {
  return sb
    .from('contextual_opportunities')
    .select('id, user_id, title, why_now, expires_at')
    .eq('tenant_id', tenantId)
    .is('dismissed_at', null)
    .is('engaged_at', null)
    .not('expires_at', 'is', null)
    .gte('expires_at', nowIso)
    .lte('expires_at', soonIso)
    .limit(limit);
}

export async function fetchUserLifecycleStage(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('app_users')
    .select('lifecycle_stage')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
}

export async function countUserNotificationsSince(sb: SupabaseClient, userId: string, sinceIso: string) {
  return sb
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', sinceIso);
}
