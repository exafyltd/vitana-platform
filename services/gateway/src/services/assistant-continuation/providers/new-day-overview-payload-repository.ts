// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// all 9 referencing test files import only types or the pure
// buildGuidedJourneyStandingInstruction function, or wholesale
// jest.mock the module — zero genuine coverage of these queries today.
/**
 * services/assistant-continuation/providers/new-day-overview-payload.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in new-day-overview-payload.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Data-access only —
 * this module "only assembles"; the prompt layer (elsewhere) renders
 * the spoken content, and this seam does not touch that. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countInactiveLifeCompassRows(sb: SupabaseClient, userId: string) {
  return sb.from('life_compass').select('id', { head: true, count: 'exact' }).eq('user_id', userId).eq('is_active', false);
}

export async function fetchCalendarEventsToday(sb: SupabaseClient, userId: string, nowIso: string, endOfTodayIso: string) {
  return sb
    .from('calendar_events')
    .select('title, start_time')
    .eq('user_id', userId)
    .gte('start_time', nowIso)
    .lte('start_time', endOfTodayIso)
    .order('start_time', { ascending: true })
    .limit(10);
}

export async function fetchCalendarEventsPassed(sb: SupabaseClient, userId: string, lookbackIso: string, nowIso: string) {
  return sb
    .from('calendar_events')
    .select('title, start_time')
    .eq('user_id', userId)
    .gte('start_time', lookbackIso)
    .lt('start_time', nowIso)
    .order('start_time', { ascending: false })
    .limit(5);
}

export async function fetchActiveAutopilotRecommendations(sb: SupabaseClient, userId: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id, title, summary, domain, impact_score')
    .eq('user_id', userId)
    .eq('status', 'new')
    .order('impact_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(10);
}

export async function countAutopilotRecommendationsForUser(sb: SupabaseClient, userId: string) {
  return sb.from('autopilot_recommendations').select('id', { head: true, count: 'exact' }).eq('user_id', userId);
}

export async function fetchUserIntentIdsForVoice(sb: SupabaseClient, userId: string) {
  return sb.from('user_intents').select('intent_id').eq('requester_user_id', userId).limit(200);
}

export async function countLiveIntentMatches(sb: SupabaseClient, idList: string) {
  return sb
    .from('intent_matches')
    .select('match_id', { head: true, count: 'exact' })
    .or(`intent_a_id.in.(${idList}),intent_b_id.in.(${idList})`)
    .in('state', ['new', 'responded_by_a', 'responded_by_b', 'mutual_interest']);
}

export async function countUnreadChatMessages(sb: SupabaseClient, userId: string) {
  return sb.from('chat_messages').select('*', { head: true, count: 'exact' }).eq('receiver_id', userId).is('read_at', null);
}

export async function fetchRemindersDueToday(sb: SupabaseClient, userId: string, startUtc: string, endUtc: string) {
  return sb
    .from('reminders')
    .select('action_text, next_fire_at, status')
    .eq('user_id', userId)
    .gte('next_fire_at', startUtc)
    .lte('next_fire_at', endUtc)
    .in('status', ['scheduled', 'pending', 'queued'])
    .order('next_fire_at', { ascending: true })
    .limit(5);
}

export async function countDiaryEntriesSince(sb: SupabaseClient, userId: string, sinceIso: string) {
  return sb.from('diary_entries').select('id', { head: true, count: 'exact' }).eq('user_id', userId).gte('created_at', sinceIso);
}
