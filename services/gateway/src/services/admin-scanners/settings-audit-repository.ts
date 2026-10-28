// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/settings-audit.ts — zero
// coverage today.
/**
 * services/admin-scanners/settings-audit.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in settings-audit.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantSettings(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('tenant_settings')
    .select('profile, branding, feature_flags, integrations, domains')
    .eq('tenant_id', tenantId)
    .maybeSingle();
}

export async function countTenantAdminAuditLogSince(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb
    .from('tenant_admin_audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceIso);
}

export async function fetchDestructiveTenantAdminActionsSince(
  sb: SupabaseClient,
  tenantId: string,
  actions: string[],
  sinceIso: string,
) {
  return sb
    .from('tenant_admin_audit_log')
    .select('id, action, actor_user_id, created_at')
    .eq('tenant_id', tenantId)
    .in('action', actions)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50);
}
