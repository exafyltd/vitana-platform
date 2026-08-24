// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/briefing.ts — zero coverage
// today.
/**
 * services/admin-scanners/briefing.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/briefing.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes, same call
 * order — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchOpenAdminInsights(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('admin_insights')
    .select(
      'id, scanner, natural_key, domain, title, description, severity, confidence_score, recommended_action, snoozed_until',
    )
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .limit(20);
}

export async function fetchTenantAdminUserIds(sb: SupabaseClient, tenantId: string, privilegedRoles: string[]) {
  return sb.from('user_tenants').select('user_id, active_role').eq('tenant_id', tenantId).in('active_role', privilegedRoles);
}

export async function fetchUnnotifiedUrgentAdminInsights(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('admin_insights')
    .select('id, title, description, domain, scanner, natural_key')
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .eq('severity', 'urgent')
    .is('urgent_notified_at', null)
    .limit(20);
}

export function markAdminInsightsUrgentNotified(sb: SupabaseClient, ids: string[]): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('admin_insights').update({ urgent_notified_at: new Date().toISOString() }).in('id', ids);
}
