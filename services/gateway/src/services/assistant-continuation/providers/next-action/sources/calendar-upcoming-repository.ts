// Genuine coverage: test/services/assistant-continuation/providers/next-action/calendar-upcoming.test.ts
// passes a hand-built functional fake client directly (no jest.mock())
// — real coverage, not a mock.
/**
 * services/assistant-continuation/providers/next-action/sources/calendar-upcoming.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md
 * Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in calendar-upcoming.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchNearestUpcomingCalendarEvent(
  sb: SupabaseClient,
  userId: string,
  nowIso: string,
  horizonIso: string,
) {
  return sb
    .from('calendar_events')
    .select('id, title, start_time, end_time, status, event_type')
    .eq('user_id', userId)
    .eq('status', 'scheduled')
    .gte('start_time', nowIso)
    .lte('start_time', horizonIso)
    .order('start_time', { ascending: true })
    .limit(1);
}
