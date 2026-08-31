/**
 * guide/presence-pacer.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/presence-pacer.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_proactive_touches ====================

export async function fetchTodaysTouches(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('user_proactive_touches')
    .select('surface, dismissed_at, sent_at')
    .eq('user_id', userId)
    .gte('sent_at', sinceIso);
}

export async function insertProactiveTouch(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_proactive_touches').insert(row);
}

export async function fetchUnresolvedTouch(
  supabase: SupabaseClient,
  userId: string,
  surface: string,
  sinceIso: string,
  resolutionColumn: string,
  limit: number,
) {
  return supabase
    .from('user_proactive_touches')
    .select('id')
    .eq('user_id', userId)
    .eq('surface', surface)
    .gte('sent_at', sinceIso)
    .is(resolutionColumn, null)
    .order('sent_at', { ascending: false })
    .limit(limit);
}

export async function updateTouchResolution(supabase: SupabaseClient, touchId: string, patch: Record<string, unknown>) {
  return supabase.from('user_proactive_touches').update(patch).eq('id', touchId);
}

// ==================== user_preferences ====================

export async function fetchPresencePreference(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('user_preferences')
    .select('metadata')
    .eq('user_id', userId)
    .eq('preference_type', 'proactive_presence_level')
    .limit(limit);
}
