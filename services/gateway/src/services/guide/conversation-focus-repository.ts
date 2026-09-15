/**
 * guide/conversation-focus.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/conversation-focus.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== calendar_events ====================

export async function fetchOverdueOrUpcomingAutopilotEvent(
  supabase: SupabaseClient,
  userId: string,
  which: 'overdue' | 'upcoming',
) {
  const nowIso = new Date().toISOString();
  let query = supabase
    .from('calendar_events')
    .select('id, title, start_time, duration_minutes')
    .eq('user_id', userId)
    .eq('event_type', 'autopilot')
    .eq('status', 'scheduled');
  if (which === 'overdue') {
    query = query.lt('start_time', nowIso).order('start_time', { ascending: false });
  } else {
    const in24hIso = new Date(Date.now() + 86_400_000).toISOString();
    query = query
      .gt('start_time', nowIso)
      .lt('start_time', in24hIso)
      .order('start_time', { ascending: true });
  }
  return query.limit(1);
}

// ==================== autopilot_recommendations ====================

export async function fetchTopNewAutopilotRecommendation(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('autopilot_recommendations')
    .select('id, title, summary, priority')
    .eq('user_id', userId)
    .eq('status', 'new')
    .order('priority', { ascending: false })
    .limit(1);
}
