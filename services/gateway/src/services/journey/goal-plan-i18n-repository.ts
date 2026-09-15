/**
 * journey/goal-plan-i18n.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in journey/goal-plan-i18n.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param, matching the original file's own `client` naming at call
 * sites), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== goal_plan_step_i18n ====================

export async function fetchCachedStepTranslations(supabase: SupabaseClient, locale: string, stepIds: string[]) {
  return supabase.from('goal_plan_step_i18n').select('step_id, title, description').eq('locale', locale).in('step_id', stepIds);
}

export async function upsertStepTranslations(supabase: SupabaseClient, rows: Array<Record<string, unknown>>) {
  return supabase.from('goal_plan_step_i18n').upsert(rows, { onConflict: 'step_id,locale' });
}

// ==================== goal_plan_i18n ====================

export async function fetchCachedPlanTranslation(supabase: SupabaseClient, locale: string, planId: string) {
  return supabase.from('goal_plan_i18n').select('goal_text, plan_summary').eq('locale', locale).eq('plan_id', planId).maybeSingle();
}

export async function upsertPlanTranslation(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('goal_plan_i18n').upsert(row, { onConflict: 'plan_id,locale' });
}
