// Genuinely tested via test/journey-foundation.test.ts, which drives a
// real functional fake SupabaseClient (table-keyed, chain-method
// agnostic — any filter method is a no-op returning `this`), not a
// wholesale module mock.
/**
 * services/journey-foundation/journey-foundation-verifier.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase
 * 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * journey-foundation-verifier.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 *
 * `checkRowExists` is the generic table-agnostic "does a matching row
 * exist" helper the source file already used across several tables
 * (memory_diary_entries, calendar_events, autopilot_recommendations,
 * user_connections) — kept generic here rather than split into one
 * function per table, matching its original shape exactly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function checkRowExists(sb: SupabaseClient, table: string, build: (q: any) => any): Promise<boolean> {
  try {
    let q = sb.from(table).select('user_id', { count: 'exact', head: true });
    q = build(q);
    const { count, error } = await q;
    if (error) return false;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function fetchActiveLifeCompassGoalWithText(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('primary_goal')
    .eq('user_id', userId)
    .eq('is_active', true)
    .not('primary_goal', 'is', null)
    .limit(1)
    .maybeSingle();
}

export async function fetchReminderStatuses(sb: SupabaseClient, userId: string) {
  return sb.from('reminders').select('status').eq('user_id', userId).limit(50);
}

export async function fetchCompletedBaselineSurvey(sb: SupabaseClient, userId: string) {
  return sb
    .from('vitana_index_baseline_survey')
    .select('completed_at')
    .eq('user_id', userId)
    .not('completed_at', 'is', null)
    .limit(1)
    .maybeSingle();
}

export async function fetchProfileBasics(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('full_name, display_name, date_of_birth').eq('user_id', userId).maybeSingle();
}
