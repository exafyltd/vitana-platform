// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior); exercised
// indirectly by daily-pace-service.ts's existing test suite
// (test/daily-pace-service.test.ts), which covers every SkipReason and
// the happy path via a hand-rolled mock SupabaseClient (not a whole-module
// mock).
/**
 * services/daily-pace-service.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in daily-pace-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAppUserTimezone(sb: SupabaseClient<any, any, any>, userId: string, tenantId?: string) {
  let q = sb.from('app_users').select('timezone').eq('user_id', userId);
  if (tenantId) q = q.eq('tenant_id', tenantId);
  return q.maybeSingle();
}

export async function fetchUserPreferencesTimezone(sb: SupabaseClient<any, any, any>, userId: string) {
  return sb.from('user_preferences').select('timezone').eq('user_id', userId).maybeSingle();
}

export async function fetchTimezoneMemoryFact(sb: SupabaseClient<any, any, any>, userId: string, tenantId?: string) {
  let q = sb.from('memory_facts').select('fact_value').eq('user_id', userId).eq('fact_key', 'timezone');
  if (tenantId) q = q.eq('tenant_id', tenantId);
  return q.order('updated_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
}

export async function fetchRecentDailyPaceNotifications(
  sb: SupabaseClient<any, any, any>,
  userId: string,
  tenantId: string,
  windowStart: string,
) {
  return sb
    .from('user_notifications')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .eq('type', 'daily_pace_check')
    .gte('created_at', windowStart)
    .order('created_at', { ascending: false })
    .limit(10);
}

export async function fetchActiveLifeCompassGoalId(sb: SupabaseClient<any, any, any>, userId: string) {
  return sb.from('life_compass').select('id').eq('user_id', userId).eq('is_active', true).maybeSingle();
}

export async function fetchNotificationPushEnabled(sb: SupabaseClient<any, any, any>, userId: string, tenantId: string) {
  return sb.from('user_notification_preferences').select('push_enabled').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle();
}

/**
 * Reused for both surfaced_7d (no status filter) and activated_7d
 * (status='activated') — same table/window shape, `status` optionally
 * narrows it, matching the original two near-identical inline calls.
 */
export async function countAutopilotRecommendationsInWindow(
  sb: SupabaseClient<any, any, any>,
  userId: string,
  windowStart: string,
  status?: string,
) {
  let q = sb.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (status) q = q.eq('status', status);
  return q.gte('created_at', windowStart);
}
