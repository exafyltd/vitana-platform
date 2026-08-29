/**
 * guide/awareness-context.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/awareness-context.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== life_compass ====================

export async function fetchActiveLifeCompassGoal(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('life_compass')
    .select('id, primary_goal, category, created_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// ==================== autopilot_recommendations ====================

export async function countRecsByStatus(supabase: SupabaseClient, userId: string, status: string) {
  return supabase
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', status);
}

export async function countRecsByStatusSince(supabase: SupabaseClient, userId: string, status: string, sinceIso: string) {
  return supabase
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', status)
    .gte('updated_at', sinceIso);
}

// ==================== calendar_events ====================

export async function countOverdueAutopilotEvents(supabase: SupabaseClient, userId: string, beforeIso: string) {
  return supabase
    .from('calendar_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('event_type', 'autopilot')
    .eq('status', 'scheduled')
    .lt('start_time', beforeIso);
}

export async function countUpcomingAutopilotEvents(supabase: SupabaseClient, userId: string, fromIso: string, toIso: string) {
  return supabase
    .from('calendar_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('event_type', 'autopilot')
    .eq('status', 'scheduled')
    .gt('start_time', fromIso)
    .lt('start_time', toIso);
}
