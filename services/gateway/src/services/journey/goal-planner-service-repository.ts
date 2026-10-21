// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in goal-planner-service.ts has any test coverage today —
// test/services/journey/goal-planner-service.test.ts only exercises the
// pure helpers (addDaysIso, calendarDaysBetween, mapPlanToSteps), and no
// other test file in this repo references this module or its route
// (src/routes/goal-planner.ts has no test file). This is a pure mechanical
// move, verified by tsc — flagged here rather than silently presented as
// covered.
/**
 * services/journey/goal-planner-service.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in goal-planner-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveLifeCompassGoalForPlanning(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('id, primary_goal, category, target_date, target_value, target_unit, created_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
}

export async function supersedeActiveGoalPlans(sb: SupabaseClient, userId: string) {
  return sb.from('goal_plans').update({ status: 'superseded' }).eq('user_id', userId).eq('status', 'active');
}

export async function insertGoalPlan(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('goal_plans').insert(row).select('id').single();
}

export async function insertGoalPlanSteps(sb: SupabaseClient, rows: Record<string, unknown>[]) {
  return sb.from('goal_plan_steps').insert(rows).select('id, kind, title, description, scheduled_date');
}

export async function fetchActiveGoalPlan(sb: SupabaseClient, userId: string) {
  return sb
    .from('goal_plans')
    .select('id, goal_text, plan_summary, start_date, target_date, total_days, status, source_lang')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('generated_at', { ascending: false })
    .limit(1);
}

export async function fetchGoalPlanSteps(sb: SupabaseClient, planId: string) {
  return sb
    .from('goal_plan_steps')
    .select('id, kind, title, description, day_offset, scheduled_date, status, sort_order')
    .eq('plan_id', planId)
    .order('sort_order', { ascending: true });
}

export async function updateGoalPlanStepStatus(
  sb: SupabaseClient,
  stepId: string,
  userId: string,
  patch: { status: 'done' | 'pending'; completed_at: string | null },
) {
  return sb.from('goal_plan_steps').update(patch).eq('id', stepId).eq('user_id', userId);
}
