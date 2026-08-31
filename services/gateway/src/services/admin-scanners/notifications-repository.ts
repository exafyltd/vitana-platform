// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/notifications.ts — zero coverage
// today.
/**
 * services/admin-scanners/notifications.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/notifications.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes, same call
 * order — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countUnreadNotificationsOlderThan(sb: SupabaseClient, tenantId: string, beforeIso: string) {
  return sb
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .is('read_at', null)
    .lt('created_at', beforeIso);
}

export async function countNotificationPreferencesTotal(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_notification_preferences').select('user_id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function countNotificationPreferencesPushEnabled(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('user_notification_preferences')
    .select('user_id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('push_enabled', true);
}

export async function countUserTenants(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function countNotificationsSince(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb.from('user_notifications').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', sinceIso);
}
