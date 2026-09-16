/**
 * routes/admin-notification-categories.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-notification-
 * categories.ts against `notification_categories` now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same
 * `{ data, error }` shapes — no behavior change today. `user_tenants`
 * (POST /:id/test's admin-tenant lookup) stays inline — a shared/general
 * table, not owned by this domain, same as other B1 seams.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CategoriesFilters {
  type?: string;
  tenantId?: string;
  includeInactive: boolean;
}

export async function fetchCategories(supabase: SupabaseClient, f: CategoriesFilters) {
  let query = supabase.from('notification_categories').select('*').order('type').order('sort_order', { ascending: true });

  if (f.type) query = query.eq('type', f.type);
  if (f.tenantId) query = query.or(`tenant_id.eq.${f.tenantId},tenant_id.is.null`);
  else query = query.is('tenant_id', null);
  if (!f.includeInactive) query = query.eq('is_active', true);

  return query;
}

export async function fetchCategoryById(supabase: SupabaseClient, id: string) {
  return supabase.from('notification_categories').select('*').eq('id', id).single();
}

export async function insertCategory(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('notification_categories').insert(row).select().single();
}

export async function updateCategory(supabase: SupabaseClient, id: string, fields: Record<string, unknown>) {
  return supabase.from('notification_categories').update(fields).eq('id', id).select().single();
}
