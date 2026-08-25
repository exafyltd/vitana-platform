// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/lib/nav-query-expansion.test.ts and test/nav-catalog-platform-reach.test.ts
// only import the pure helper functions from this module
// (searchCatalogEntries, selectPlatformEntries), not
// refreshNavCatalogCache, which owns these two call sites — zero
// genuine coverage today.
/**
 * lib/nav-catalog-db.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in nav-catalog-db.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveNavCatalogRows(sb: SupabaseClient) {
  return sb
    .from('nav_catalog')
    .select(
      'id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, platform, related_kb_topics, context_rules, override_triggers, is_active, created_at, updated_at, updated_by'
    )
    .eq('is_active', true);
}

export async function fetchNavCatalogI18nRowsForCatalogIds(sb: SupabaseClient, catalogIds: string[]) {
  return sb.from('nav_catalog_i18n').select('catalog_id, lang, title, description, when_to_visit, updated_at').in('catalog_id', catalogIds);
}
