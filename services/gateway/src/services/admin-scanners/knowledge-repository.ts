// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/knowledge.ts — zero coverage
// today.
/**
 * services/admin-scanners/knowledge.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/knowledge.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes, same call
 * order — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countPendingKbDocuments(sb: SupabaseClient, tenantId: string) {
  return sb.from('kb_documents').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'pending');
}

export async function fetchFailedKbDocuments(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('kb_documents')
    .select('id, title, updated_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'failed')
    .order('updated_at', { ascending: false })
    .limit(20);
}

export async function countTenantKbDocuments(sb: SupabaseClient, tenantId: string) {
  return sb.from('kb_documents').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function countTenantKbBaselineOptouts(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_kb_baseline_optouts').select('document_id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function countGlobalKbBaselineDocuments(sb: SupabaseClient) {
  return sb.from('kb_documents').select('id', { count: 'exact', head: true }).is('tenant_id', null);
}
