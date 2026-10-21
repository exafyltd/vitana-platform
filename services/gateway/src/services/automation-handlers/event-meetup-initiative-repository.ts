// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior). test/services/automation-
// handlers-phase2.test.ts imports this module and directly exercises
// runCalendarAvailabilityCheck (fetchEventForAvailabilityCheck +
// fetchConflictingCalendarEvents). The other handlers' call sites
// (runSmartEventCreation, runAutoInvitationSender,
// runEventDiscoveryRecommendation, runSocialMeetupOrganizer) have no
// functional test coverage in this repo today -- moved as a literal,
// mechanical read-for-read copy and verified via tsc --noEmit.
/**
 * services/automation-handlers/event-meetup-initiative.ts — Aurora migration
 * B1 data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in event-meetup-initiative.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== relationship_edges ====================

export async function fetchConnectedRelationshipTargets(sb: SupabaseClient, tenantId: string, sourceId: string, limit: number) {
  return sb
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', sourceId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .limit(limit);
}

export async function fetchMutualConnectedTargetsIn(
  sb: SupabaseClient,
  tenantId: string,
  sourceId: string,
  targetIdsIn: string[],
  limit: number,
) {
  return sb
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', sourceId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .in('target_id', targetIdsIn)
    .limit(limit);
}

// ==================== user_interests ====================

export async function fetchTopUserInterest(sb: SupabaseClient, userId: string) {
  return sb.from('user_interests').select('interest').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(1).maybeSingle();
}

// ==================== user_notifications ====================

export async function fetchRecentAutomationSuggestion(sb: SupabaseClient, userId: string, automationId: string, sinceIso: string) {
  return sb
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: automationId })
    .gte('created_at', sinceIso)
    .limit(1);
}

// ==================== global_community_events ====================

export async function fetchEventForAvailabilityCheck(sb: SupabaseClient, eventId: string) {
  return sb.from('global_community_events').select('title, start_time, end_time').eq('id', eventId).maybeSingle();
}

export async function fetchRecentlyCreatedEvents(sb: SupabaseClient, sinceIso: string, limit: number) {
  return sb.from('global_community_events').select('id, title, created_by').not('created_by', 'is', null).gte('created_at', sinceIso).limit(limit);
}

export async function fetchUpcomingEventsByParticipation(sb: SupabaseClient, nowIso: string, lookaheadIso: string, limit: number) {
  return sb
    .from('global_community_events')
    .select('id, title, participant_count')
    .gte('start_time', nowIso)
    .lte('start_time', lookaheadIso)
    .order('participant_count', { ascending: false })
    .limit(limit);
}

// ==================== calendar_events ====================

export async function fetchConflictingCalendarEvents(sb: SupabaseClient, userId: string, beforeIso: string, afterIso: string) {
  return sb.from('calendar_events').select('id, title').eq('user_id', userId).lt('start_time', beforeIso).gt('end_time', afterIso).limit(1);
}

// ==================== global_event_participants ====================

export async function fetchEventParticipant(sb: SupabaseClient, eventId: string, userId: string) {
  return sb.from('global_event_participants').select('id').eq('event_id', eventId).eq('user_id', userId).limit(1);
}
