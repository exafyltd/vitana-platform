/**
 * guide/opener-mvp.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/opener-mvp.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== life_compass ====================

export async function fetchActiveGoalForOpener(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('life_compass')
    .select('id, primary_goal, category')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function insertDefaultLifeCompassGoal(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('life_compass').insert(row).select('id, primary_goal, category').single();
}

// ==================== calendar_events ====================

export async function fetchOverdueCalendarEvent(supabase: SupabaseClient, userId: string, beforeIso: string, limit: number) {
  return supabase
    .from('calendar_events')
    .select('id, title, start_time, duration_minutes, event_type, status, source_ref')
    .eq('user_id', userId)
    .eq('event_type', 'autopilot')
    .eq('status', 'scheduled')
    .lt('start_time', beforeIso)
    .order('start_time', { ascending: false })
    .limit(limit);
}

export async function fetchUpcomingCalendarEvent(
  supabase: SupabaseClient,
  userId: string,
  fromIso: string,
  toIso: string,
  limit: number,
) {
  return supabase
    .from('calendar_events')
    .select('id, title, start_time, duration_minutes, event_type, status, source_ref')
    .eq('user_id', userId)
    .eq('event_type', 'autopilot')
    .eq('status', 'scheduled')
    .gt('start_time', fromIso)
    .lt('start_time', toIso)
    .order('start_time', { ascending: true })
    .limit(limit);
}

// ==================== autopilot_recommendations ====================

export async function fetchTopNewRecommendation(supabase: SupabaseClient, userId: string, roleScopes: string[], limit: number) {
  return supabase
    .from('autopilot_recommendations')
    .select('id, title, summary, domain, role_scope, status, user_id, created_at')
    .eq('user_id', userId)
    .eq('status', 'new')
    .in('role_scope', roleScopes)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// ==================== app_users ====================

export async function fetchUserRegisteredAt(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase.from('app_users').select('created_at').eq('id', userId).limit(limit);
}

// ==================== user_nudge_state ====================

export async function fetchNudgeSilencedUntil(supabase: SupabaseClient, userId: string, nudgeKey: string, limit: number) {
  return supabase
    .from('user_nudge_state')
    .select('silenced_until')
    .eq('user_id', userId)
    .eq('nudge_key', nudgeKey)
    .limit(limit);
}
