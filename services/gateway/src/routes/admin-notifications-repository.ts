// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/admin-notifications.ts's existing test suite
// (test/routes/admin-notifications.test.ts), which covers every call site
// here.
/**
 * routes/admin-notifications.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-notifications.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_tenants ====================

export async function fetchTenantUserIdsByRole(sb: SupabaseClient, tenantId: string, role: string) {
  return sb.from('user_tenants').select('user_id').eq('tenant_id', tenantId).eq('active_role', role);
}

export async function fetchTenantUserIds(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('tenant_id', tenantId);
}

// ==================== user_notifications ====================

export async function fetchSentNotifications(
  sb: SupabaseClient,
  filters: { sinceIso: string; offset: number; limit: number; type?: string; userId?: string; search?: string },
) {
  let q = sb
    .from('user_notifications')
    .select('*', { count: 'exact' })
    .gte('created_at', filters.sinceIso)
    .order('created_at', { ascending: false })
    .range(filters.offset, filters.offset + filters.limit - 1);

  if (filters.type) q = q.eq('type', filters.type);
  if (filters.userId) q = q.eq('user_id', filters.userId);
  if (filters.search) q = q.or(`title.ilike.%${filters.search}%,body.ilike.%${filters.search}%`);

  return q;
}

export async function countNotificationsSince(sb: SupabaseClient, sinceIso: string) {
  return sb.from('user_notifications').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
}

export async function countReadNotificationsSince(sb: SupabaseClient, sinceIso: string) {
  return sb.from('user_notifications').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso).not('read_at', 'is', null);
}

// ==================== user_notification_preferences ====================

export async function fetchNotificationPreferences(sb: SupabaseClient, tenantId?: string) {
  let q = sb.from('user_notification_preferences').select('*');
  if (tenantId) q = q.eq('tenant_id', tenantId);
  return q;
}
