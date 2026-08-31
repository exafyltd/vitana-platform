/**
 * guide/morning-brief-scheduler.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/morning-brief-scheduler.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters, same return shapes —
 * no behavior change today. Client-agnostic (takes `supabase` as a param),
 * same convention as every other *-repository.ts in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== oasis_events ====================

export async function fetchRecentOrbSessionStartedEvents(supabase: SupabaseClient, sinceIso: string, limit: number) {
  return supabase
    .from('oasis_events')
    .select('metadata')
    .eq('topic', 'orb.session.started')
    .gte('created_at', sinceIso)
    .limit(limit);
}

// ==================== user_proactive_touches ====================

export async function fetchUsersAlreadySentMorningBriefToday(supabase: SupabaseClient, todayStartIso: string) {
  return supabase
    .from('user_proactive_touches')
    .select('user_id')
    .eq('surface', 'morning_brief')
    .gte('sent_at', todayStartIso);
}

// ==================== app_users ====================

export async function fetchUsersForMorningBrief(supabase: SupabaseClient, userIds: string[]) {
  return supabase
    .from('app_users')
    .select('user_id, tenant_id, display_name')
    .in('user_id', userIds);
}
