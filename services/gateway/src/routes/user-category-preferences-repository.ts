// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references user-category-preferences.ts — zero coverage
// today.
/**
 * routes/user-category-preferences.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in user-category-preferences.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveNotificationCategories(sb: SupabaseClient, tenantId: string | null) {
  return sb
    .from('notification_categories')
    .select('id, type, slug, display_name, description, icon, sort_order, default_enabled')
    .eq('is_active', true)
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
    .order('type')
    .order('sort_order', { ascending: true });
}

export async function fetchUserCategoryPreferences(sb: SupabaseClient, userId: string, tenantId: string | null) {
  return sb
    .from('user_category_preferences')
    .select('category_id, enabled')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId);
}

export async function fetchActiveNotificationCategoryById(sb: SupabaseClient, categoryId: string) {
  return sb.from('notification_categories').select('id').eq('id', categoryId).eq('is_active', true).single();
}

export async function upsertUserCategoryPreference(
  sb: SupabaseClient,
  row: { user_id: string; tenant_id: string | null; category_id: string; enabled: boolean; updated_at: string },
) {
  return sb
    .from('user_category_preferences')
    .upsert(row, { onConflict: 'user_id,category_id' })
    .select()
    .single();
}
