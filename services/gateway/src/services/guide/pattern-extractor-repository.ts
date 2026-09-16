/**
 * guide/pattern-extractor.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/pattern-extractor.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_routines ====================

export async function fetchUserRoutines(supabase: SupabaseClient, userId: string, minConfidence: number, limit: number) {
  return supabase
    .from('user_routines')
    .select('routine_kind, routine_key, title, summary, evidence_count, confidence, metadata, first_observed, last_observed')
    .eq('user_id', userId)
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false })
    .limit(limit);
}

export async function upsertUserRoutine(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_routines').upsert(row, { onConflict: 'user_id,routine_kind,routine_key' });
}

// ==================== calendar_events ====================

export async function fetchCalendarEventsSince(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('calendar_events')
    .select('id, start_time, completion_status, status, event_type, wellness_tags')
    .eq('user_id', userId)
    .gte('start_time', sinceIso);
}
