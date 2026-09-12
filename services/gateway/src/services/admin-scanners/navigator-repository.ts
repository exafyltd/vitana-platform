// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/navigator.ts — zero coverage
// today.
/**
 * services/admin-scanners/navigator.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/navigator.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchInactiveNavCatalogEntries(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('nav_catalog')
    .select('id, screen_id, category, tenant_id')
    .eq('is_active', false)
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    .limit(50);
}

export async function fetchActiveNavCatalogEntries(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('nav_catalog')
    .select('id, screen_id')
    .eq('is_active', true)
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    .limit(500);
}

export async function fetchNavCatalogI18nLangsForIds(sb: SupabaseClient, catalogIds: string[]) {
  return sb.from('nav_catalog_i18n').select('catalog_id, lang').in('catalog_id', catalogIds);
}

export async function countNavCatalogAuditRowsSince(sb: SupabaseClient, sinceIso: string) {
  return sb.from('nav_catalog_audit').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
}

export async function countNavCatalogTotal(sb: SupabaseClient, tenantId: string) {
  return sb.from('nav_catalog').select('id', { count: 'exact', head: true }).or(`tenant_id.is.null,tenant_id.eq.${tenantId}`);
}
