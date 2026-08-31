// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references orb-tools/events-tickets-tools.ts — zero
// coverage today.
/**
 * orb-tools/events-tickets-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * orb-tools/events-tickets-tools.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param) — tools
 * receive their client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const MY_EVENT_COLS =
  'id, title, description, event_type, location, virtual_link, start_time, end_time, max_participants, image_url, created_by';
const ANY_EVENT_COLS = 'id, title, start_time, location';

export async function fetchMyEventById(sb: SupabaseClient, eventId: string, userId: string, eventTypeFilter?: string) {
  let q = sb.from('global_community_events').select(MY_EVENT_COLS).eq('id', eventId).eq('created_by', userId);
  if (eventTypeFilter) q = q.eq('event_type', eventTypeFilter);
  return q.maybeSingle();
}

export async function searchMyUpcomingEvents(sb: SupabaseClient, userId: string, query: string, eventTypeFilter?: string) {
  let q = sb
    .from('global_community_events')
    .select(MY_EVENT_COLS)
    .eq('created_by', userId)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(10);
  if (eventTypeFilter) q = q.eq('event_type', eventTypeFilter);
  if (query) q = q.ilike('title', `%${query}%`);
  return q;
}

export async function fetchAnyEventById(sb: SupabaseClient, eventId: string) {
  return sb.from('global_community_events').select(ANY_EVENT_COLS).eq('id', eventId).maybeSingle();
}

export async function searchAnyUpcomingEventsByTitle(sb: SupabaseClient, query: string) {
  return sb
    .from('global_community_events')
    .select(ANY_EVENT_COLS)
    .gte('start_time', new Date().toISOString())
    .ilike('title', `%${query}%`)
    .order('start_time', { ascending: true })
    .limit(5);
}

export async function resolveRecipientCandidatesForEvent(sb: SupabaseClient, actorUserId: string, token: string) {
  return sb.rpc('resolve_recipient_candidates', {
    p_actor: actorUserId,
    p_token: token,
    p_limit: 3,
    p_global: true,
  });
}

export async function insertCommunityEvent(
  sb: SupabaseClient,
  payload: {
    title: string;
    description: string | null;
    event_type: string;
    location: string | null;
    virtual_link: string | null;
    start_time: string;
    end_time: string | null;
    max_participants: number | null;
    image_url: string | null;
    metadata: Record<string, unknown>;
    created_by: string;
    participant_count: number;
  },
) {
  return sb.from('global_community_events').insert(payload).select('id, title, start_time').single();
}

export function updateOwnedEventPatch(
  sb: SupabaseClient,
  eventId: string,
  userId: string,
  patch: Record<string, unknown>,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('global_community_events').update(patch).eq('id', eventId).eq('created_by', userId);
}

export function deleteOwnedEvent(sb: SupabaseClient, eventId: string, userId: string): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('global_community_events').delete().eq('id', eventId).eq('created_by', userId);
}

export function upsertEventAttendeeInvite(
  sb: SupabaseClient,
  payload: { event_id: string; user_id: string; response: string; invited_by: string; metadata: Record<string, unknown> },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('event_attendees').upsert(payload, { onConflict: 'event_id,user_id', ignoreDuplicates: false });
}

export async function fetchInviteAnalyticsSentCount(sb: SupabaseClient, eventId: string, channel: string) {
  return sb.from('invite_analytics').select('sent_count').eq('event_id', eventId).eq('channel', channel).maybeSingle();
}

export function upsertInviteAnalyticsSentCount(
  sb: SupabaseClient,
  eventId: string,
  channel: string,
  sentCount: number,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('invite_analytics').upsert({ event_id: eventId, channel, sent_count: sentCount }, { onConflict: 'event_id,channel' });
}

export async function fetchActiveTicketTypesForEvent(sb: SupabaseClient, eventId: string) {
  return sb
    .from('event_ticket_types')
    .select('id, event_id, name, price, currency, quantity_available, quantity_sold, is_active, sale_start_date, sale_end_date')
    .eq('event_id', eventId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
}

export async function fetchMyCompletedTicketPurchases(sb: SupabaseClient, buyerId: string) {
  return sb
    .from('event_ticket_purchases')
    .select(
      'id, event_id, quantity, total_amount, currency, status, ticket_number, checked_in_at, ticket_type:event_ticket_types(name), event:global_community_events(title, start_time, location)',
    )
    .eq('buyer_id', buyerId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(10);
}

export async function fetchAttendingParticipantIds(sb: SupabaseClient, eventId: string) {
  return sb.from('global_event_participants').select('user_id').eq('event_id', eventId).eq('status', 'attending');
}

export async function fetchAppUsersByIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, display_name, vitana_id').in('user_id', userIds);
}
