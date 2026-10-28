// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/compliance.ts — zero coverage
// today.
/**
 * services/admin-scanners/compliance.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/compliance.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPrivilegedGrantAuditRows(sb: SupabaseClient, tenantId: string, actions: string[], sinceIso: string) {
  return sb
    .from('tenant_admin_audit_log')
    .select('id, action, actor_user_id, target_resource, after_state, created_at')
    .eq('tenant_id', tenantId)
    .in('action', actions)
    .gte('created_at', sinceIso);
}

export async function fetchAgedFlaggedMediaUploads(sb: SupabaseClient, tenantId: string, beforeIso: string) {
  return sb
    .from('media_uploads')
    .select('id, created_at, media_type')
    .eq('tenant_id', tenantId)
    .eq('status', 'flagged')
    .lt('updated_at', beforeIso)
    .order('updated_at', { ascending: true })
    .limit(20);
}

export async function fetchGdprErasureRequests(sb: SupabaseClient, tenantId: string, beforeIso: string) {
  return sb
    .from('tenant_admin_audit_log')
    .select('id, target_resource, created_at')
    .eq('tenant_id', tenantId)
    .eq('action', 'user.delete_request')
    .lt('created_at', beforeIso);
}

export async function fetchGdprErasureCompletions(sb: SupabaseClient, tenantId: string, targets: string[]) {
  return sb.from('tenant_admin_audit_log').select('target_resource').eq('tenant_id', tenantId).eq('action', 'user.deleted').in('target_resource', targets);
}
