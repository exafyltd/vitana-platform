// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/intent-templates.ts — zero coverage
// today.
/**
 * routes/intent-templates.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-templates.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `fetchIntentScopeTemplatesByCategory` resolves the terminal await
 * inside an async function (rather than returning a partial builder)
 * so the source's optional `category` conditional `.in()` step still
 * runs before the query executes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchIntentScopeTemplatesByCategory(sb: SupabaseClient, intentKind: string, category: string | null) {
  let query = sb
    .from('intent_scope_templates')
    .select('template_title, template_scope, payload_hint, category_key')
    .eq('intent_kind', intentKind)
    .order('sort_order', { ascending: true });

  if (category) query = query.in('category_key', [category]);

  return query;
}

export async function fetchIntentScopeTemplatesNoCategoryFallback(sb: SupabaseClient, intentKind: string) {
  return sb
    .from('intent_scope_templates')
    .select('template_title, template_scope, payload_hint, category_key')
    .eq('intent_kind', intentKind)
    .is('category_key', null)
    .order('sort_order', { ascending: true });
}
