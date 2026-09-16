/**
 * guide/adaptation-applier.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/adaptation-applier.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 *
 * Note: `adaptation_plans` is confirmed absent from live Supabase (see
 * docs/AURORA-B3-DEAD-RPC-CALLSITE-AUDIT.md's D43 section) — this move
 * does not change or judge that; the caller's own graceful "no_plans_table"
 * handling is preserved exactly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== adaptation_plans ====================

export async function fetchPendingAdaptationPlans(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('adaptation_plans')
    .select('id, user_id, plan_type, plan_payload, approved_at, applied_at')
    .eq('user_id', userId)
    .not('approved_at', 'is', null)
    .is('applied_at', null)
    .limit(limit);
}

export async function markAdaptationPlanApplied(supabase: SupabaseClient, planId: string, appliedAtIso: string) {
  return supabase.from('adaptation_plans').update({ applied_at: appliedAtIso }).eq('id', planId);
}

export async function countPendingAdaptationPlans(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('adaptation_plans')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('approved_at', 'is', null)
    .is('applied_at', null);
}

export async function fetchMostRecentAppliedPlan(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('adaptation_plans')
    .select('id, applied_at', { count: 'exact' })
    .eq('user_id', userId)
    .not('applied_at', 'is', null)
    .order('applied_at', { ascending: false })
    .limit(limit);
}

// ==================== user_journey_overrides ====================

export async function upsertJourneyOverride(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_journey_overrides').upsert(row, { onConflict: 'user_id,wave_id' });
}
