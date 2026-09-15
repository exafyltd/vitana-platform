// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/nav-catalog-role.test.ts only imports normalizeRole/VALID_ROLES
// (pure helpers) from admin-navigator.ts — none of the DB call sites
// here have test coverage today.
/**
 * routes/admin-navigator.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function insertNavCatalogAudit(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: { message?: string } | null }> {
  return sb.from('nav_catalog_audit').insert(row);
}

/** GET /catalog — dynamic platform/role/is_active/category/tenant_id filters. */
export async function fetchNavCatalogList(
  sb: SupabaseClient,
  filters: { platform: 'mobile' | 'desktop'; role: string; includeInactive: boolean; category: string | null; tenantId: string | null },
) {
  let query = sb
    .from('nav_catalog')
    .select('id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, platform, role, related_kb_topics, context_rules, override_triggers, is_active, created_at, updated_at, updated_by');

  query = query.eq('platform', filters.platform);
  query = query.eq('role', filters.role);
  if (!filters.includeInactive) query = query.eq('is_active', true);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.tenantId != null) {
    if (filters.tenantId === '__shared__' || filters.tenantId === 'null') {
      query = query.is('tenant_id', null);
    } else {
      query = query.eq('tenant_id', filters.tenantId);
    }
  }

  return query.order('category').order('screen_id');
}

export async function fetchNavCatalogI18nForCatalogIds(sb: SupabaseClient, catalogIds: string[]) {
  return sb.from('nav_catalog_i18n').select('catalog_id, lang, title, description, when_to_visit, updated_at').in('catalog_id', catalogIds);
}

/** Reused everywhere a full nav_catalog row is fetched by id (GET detail, patch/delete/restore existing-row lookups). */
export async function fetchNavCatalogEntryById(sb: SupabaseClient, id: string) {
  return sb.from('nav_catalog').select('*').eq('id', id).maybeSingle();
}

/** Reused for both the GET-detail i18n fetch and the patch existing/refresh i18n fetches. */
export async function fetchNavCatalogI18nRows(sb: SupabaseClient, catalogId: string) {
  return sb.from('nav_catalog_i18n').select('*').eq('catalog_id', catalogId);
}

export async function fetchNavCatalogAuditHistory(sb: SupabaseClient, catalogId: string, limit: number) {
  return sb.from('nav_catalog_audit').select('*').eq('catalog_id', catalogId).order('created_at', { ascending: false }).limit(limit);
}

export async function insertNavCatalogEntry(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('nav_catalog').insert(row).select('*').single();
}

export function insertNavCatalogI18nRows(sb: SupabaseClient, rows: Record<string, unknown>[]): PromiseLike<{ error: { message?: string } | null }> {
  return sb.from('nav_catalog_i18n').insert(rows);
}

/** Reused for every nav_catalog update-by-id (patch, soft-delete, restore) — the patch payload differs per caller. */
export async function updateNavCatalogEntry(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('nav_catalog').update(patch).eq('id', id).select('*').single();
}

/** Reused for the patch and restore i18n upserts. */
export function upsertNavCatalogI18nRows(sb: SupabaseClient, rows: Record<string, unknown>[]): PromiseLike<{ error: { message?: string } | null }> {
  return sb.from('nav_catalog_i18n').upsert(rows, { onConflict: 'catalog_id,lang' });
}

export async function fetchNavCatalogAuditById(sb: SupabaseClient, auditId: string, catalogId: string) {
  return sb.from('nav_catalog_audit').select('*').eq('id', auditId).eq('catalog_id', catalogId).maybeSingle();
}

export async function fetchNavigatorEventsSince(sb: SupabaseClient, since: string, limit: number) {
  return sb.from('oasis_events_v1').select('payload, type, created_at').like('type', 'orb.navigator.%').gte('created_at', since).limit(limit);
}

export async function fetchNavigatorTelemetryEvents(sb: SupabaseClient, since: string, limit: number) {
  return sb
    .from('oasis_events_v1')
    .select('type, payload, created_at')
    .like('type', 'orb.navigator.%')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
}
