// Genuinely tested via test/orb-tools/calendar-management-tools.test.ts,
// which drives a real functional fake SupabaseClient (query-chain
// builder), not a wholesale module mock.
/**
 * orb-tools/calendar-management-tools.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * orb-tools/calendar-management-tools.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param) — tools
 * receive their client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const EVENT_FIELDS =
  'id, title, description, location, start_time, end_time, event_type, status, ' +
  'completion_status, completed_at, completion_notes, reschedule_count, ' +
  'original_start_time, priority_score, wellness_tags, source_type, role_context';

export async function fetchCalendarEventById(sb: SupabaseClient, userId: string, eventId: string) {
  return sb.from('calendar_events').select(EVENT_FIELDS).eq('user_id', userId).eq('id', eventId).limit(1);
}

export async function searchCalendarEventsByTitle(sb: SupabaseClient, userId: string, titleQuery: string) {
  return sb
    .from('calendar_events')
    .select(EVENT_FIELDS)
    .eq('user_id', userId)
    .neq('status', 'cancelled')
    .ilike('title', `%${titleQuery}%`)
    .order('start_time', { ascending: false })
    .limit(20);
}

export async function fetchBusyCalendarIntervals(sb: SupabaseClient, userId: string, fromIso: string, toIso: string) {
  return sb
    .from('calendar_events')
    .select('id, title, start_time, end_time, status')
    .eq('user_id', userId)
    .neq('status', 'cancelled')
    .lt('start_time', toIso)
    .gt('end_time', fromIso)
    .order('start_time', { ascending: true })
    .limit(500);
}
