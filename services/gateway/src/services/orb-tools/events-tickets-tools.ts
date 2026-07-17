/**
 * Events & Tickets voice tools (plan_domain "A10 Events & Tickets",
 * VTID-03300 — used only as a local traceability tag on nav directives,
 * same convention groups-events-tools.ts uses for VTID_GROUPS/VTID_EVENTS).
 *
 * Real tables backing these tools (grepped from vitana-v1's
 * useCommunityEvents / useEventTickets / useEventInvites hooks and the
 * matching supabase/migrations there — this domain's schema lives in the
 * vitana-v1 repo, not vitana-platform):
 *
 *  - global_community_events — the SAME table groups-events-tools.ts's
 *    rsvp_event/cancel_rsvp/list_upcoming_meetups already read. Columns:
 *    id, title, description, event_type ('event' | 'meetup' | 'community' |
 *    'personal'), location, virtual_link, start_time, end_time,
 *    max_participants, participant_count, created_by, image_url, metadata,
 *    resellable, resale_scope. "Meetups" are NOT a separate table — they
 *    are rows with event_type='meetup' (confirmed via CreateMeetupPopup.tsx
 *    vs CreateEventPopup.tsx, both calling the same useCommunityEvents
 *    createEvent()). Editing/cancelling checks created_by === caller,
 *    mirroring EventKebabMenu.tsx's isCreator/canEdit/canDelete gates
 *    (canEdit additionally requires start_time still in the future).
 *  - event_ticket_types / event_ticket_purchases — real tables (migration
 *    20251204115920_97af8073…sql). Ticket purchase in the app goes through
 *    the `stripe-create-ticket-checkout` Supabase edge function (Stripe
 *    Checkout redirect) — there is no gateway route or RPC that completes a
 *    purchase, and this domain's payment policy forbids voice tools from
 *    charging a card anyway. So buy_event_ticket only *validates* against
 *    the real event_ticket_types row (availability, sale window) and then
 *    returns a navigate directive to the event's ticket selector — it does
 *    NOT insert an event_ticket_purchases row itself (a purchase row with no
 *    real qr_code_token/stripe_session_id would just be dead data; only the
 *    edge function can mint those correctly).
 *  - event_attendees / invite_analytics — real tables (migration
 *    20251006190211_a4029964…sql), the ones useEventInvites.ts writes on
 *    "invite contacts to this event" (NOT the same as
 *    global_event_participants, which is the RSVP/"I'm attending" table
 *    groups-events-tools.ts's rsvp_event uses).
 *
 * get_event_attendees reads global_event_participants (status='attending')
 * joined against app_users for display names — the same
 * resolve-then-join-app_users shape groups-events-tools.ts uses for group
 * members — restricted to events the caller created (organizer view).
 *
 * None of these tables carry a tenant_id column (confirmed by grepping both
 * the CommunityEvent hook interface and the migrations' RLS policies), so
 * unlike groups-events-tools.ts there is no resolveTenantId() tenant
 * backfill needed here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const VTID_EVENTS_TICKETS = 'VTID-03300';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** ok:false when there is no authenticated user — these tools touch user data. */
function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

/** "Tue, Jul 8, 6:00 PM" — English; the LLM translates when speaking DE. */
function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return 'time to be announced';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'time to be announced';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The event drawer overlay for a specific event/meetup — matches
 * navigation-catalog.ts's OVERLAY.EVENT_DRAWER entry (route
 * '/comm/events-meetups', overlay query_marker 'event', needs_param
 * 'event_id'), which the frontend's EventsAndMeetups.tsx page reads via
 * useSearchParams().get('event') to open MeetupDetailsDrawer.
 */
function eventDrawerRoute(eventId: string): string {
  return `/comm/events-meetups?event=${encodeURIComponent(eventId)}`;
}

function navDirective(route: string, title: string, reason: string): Record<string, unknown> {
  return {
    type: 'orb_directive',
    directive: 'navigate',
    screen_id: 'OVERLAY.EVENT_DRAWER',
    route,
    title,
    reason,
    vtid: VTID_EVENTS_TICKETS,
  };
}

// ---------------------------------------------------------------------------
// Event resolution — owner-scoped (create_event/update/cancel/attendees) and
// any-event (invite/buy/share, which don't require the caller to own it).
// ---------------------------------------------------------------------------

interface MyEventRow {
  id: string;
  title: string;
  description: string | null;
  event_type: string;
  location: string | null;
  virtual_link: string | null;
  start_time: string;
  end_time: string | null;
  max_participants: number | null;
  image_url: string | null;
  created_by: string;
}

const MY_EVENT_COLS =
  'id, title, description, event_type, location, virtual_link, start_time, end_time, max_participants, image_url, created_by';

type MyEventResolution =
  | { kind: 'one'; event: MyEventRow }
  | { kind: 'many'; events: MyEventRow[] }
  | { kind: 'none'; query: string }
  | { kind: 'error'; message: string };

/** Resolve one of MY OWN events/meetups by id or fuzzy title. */
async function resolveMyEvent(
  sb: SupabaseClient,
  userId: string,
  rawId: unknown,
  rawQuery: unknown,
  eventTypeFilter?: string,
): Promise<MyEventResolution> {
  const eventId = String(rawId ?? '').trim();
  const query = String(rawQuery ?? '').trim();

  if (UUID_RE.test(eventId)) {
    let q = sb.from('global_community_events').select(MY_EVENT_COLS).eq('id', eventId).eq('created_by', userId);
    if (eventTypeFilter) q = q.eq('event_type', eventTypeFilter);
    const { data, error } = await q.maybeSingle();
    if (error) return { kind: 'error', message: error.message };
    if (!data) return { kind: 'none', query: eventId };
    return { kind: 'one', event: data as MyEventRow };
  }

  let q = sb
    .from('global_community_events')
    .select(MY_EVENT_COLS)
    .eq('created_by', userId)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(10);
  if (eventTypeFilter) q = q.eq('event_type', eventTypeFilter);
  if (query) q = q.ilike('title', `%${query}%`);
  const { data, error } = await q;
  if (error) return { kind: 'error', message: error.message };
  const events = (data as MyEventRow[]) ?? [];
  if (events.length === 0) return { kind: 'none', query };
  if (events.length === 1) return { kind: 'one', event: events[0] };
  const exact = events.find((e) => e.title.toLowerCase() === query.toLowerCase());
  if (exact) return { kind: 'one', event: exact };
  return { kind: 'many', events };
}

interface AnyEventRow {
  id: string;
  title: string;
  start_time: string;
  location: string | null;
}

const ANY_EVENT_COLS = 'id, title, start_time, location';

type AnyEventResolution =
  | { kind: 'one'; event: AnyEventRow }
  | { kind: 'many'; events: AnyEventRow[] }
  | { kind: 'none'; query: string }
  | { kind: 'error'; message: string };

/** Resolve any upcoming event/meetup (not restricted to the caller's own). */
async function resolveAnyUpcomingEvent(sb: SupabaseClient, rawId: unknown, rawQuery: unknown): Promise<AnyEventResolution> {
  const eventId = String(rawId ?? '').trim();
  const query = String(rawQuery ?? '').trim();

  if (UUID_RE.test(eventId)) {
    const { data, error } = await sb.from('global_community_events').select(ANY_EVENT_COLS).eq('id', eventId).maybeSingle();
    if (error) return { kind: 'error', message: error.message };
    if (!data) return { kind: 'none', query: eventId };
    return { kind: 'one', event: data as AnyEventRow };
  }

  if (!query) return { kind: 'none', query: '' };

  const { data, error } = await sb
    .from('global_community_events')
    .select(ANY_EVENT_COLS)
    .gte('start_time', new Date().toISOString())
    .ilike('title', `%${query}%`)
    .order('start_time', { ascending: true })
    .limit(5);
  if (error) return { kind: 'error', message: error.message };
  const events = (data as AnyEventRow[]) ?? [];
  if (events.length === 0) return { kind: 'none', query };
  if (events.length === 1) return { kind: 'one', event: events[0] };
  const exact = events.find((e) => e.title.toLowerCase() === query.toLowerCase());
  if (exact) return { kind: 'one', event: exact };
  return { kind: 'many', events };
}

function speakEventLine(e: { title: string; start_time: string; location?: string | null }): string {
  return `"${e.title}" on ${fmtWhen(e.start_time)}${e.location ? ` at ${e.location}` : ''}`;
}

/**
 * Resolve a spoken member name to a user_id via the platform's canonical
 * resolver RPC (same as groups-events-tools.ts's resolveMember /
 * tool_send_chat_message / tool_resolve_recipient).
 */
async function resolveMember(
  sb: SupabaseClient,
  actorUserId: string,
  spoken: string,
): Promise<
  | { kind: 'one'; user_id: string; display_name: string }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
> {
  const { data, error } = await sb.rpc('resolve_recipient_candidates', {
    p_actor: actorUserId,
    p_token: spoken,
    p_limit: 3,
    p_global: true,
  });
  if (error) return { kind: 'error', message: error.message };
  const candidates = (data || []) as Array<{
    user_id: string;
    vitana_id: string | null;
    display_name: string | null;
    score: number;
  }>;
  if (candidates.length === 0) return { kind: 'none' };
  const top = candidates[0];
  const topScore = Number(top.score) || 0;
  const second = candidates[1] ? Number(candidates[1].score) || 0 : 0;
  const ambiguous = topScore < 0.85 || (candidates.length > 1 && second / Math.max(topScore, 0.0001) > 0.85);
  if (ambiguous) {
    return {
      kind: 'ambiguous',
      names: candidates.slice(0, 3).map((c) => c.display_name || c.vitana_id || c.user_id),
    };
  }
  return { kind: 'one', user_id: top.user_id, display_name: top.display_name || top.vitana_id || 'that member' };
}

// ---------------------------------------------------------------------------
// create_event / create_meetup — same underlying insert, different event_type
// ---------------------------------------------------------------------------

async function createOwnedEvent(
  toolName: string,
  eventType: string,
  kindLabel: string,
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate(toolName, id);
  if (gate) return gate;

  const title = String(args.title ?? '').trim();
  const description = String(args.description ?? '').trim();
  const location = String(args.location ?? '').trim();
  const virtualLink = String(args.virtual_link ?? '').trim();
  const startTime = String(args.start_time ?? '').trim();
  const endTime = String(args.end_time ?? '').trim();
  const imageUrl = String(args.image_url ?? '').trim();
  const maxParticipantsRaw = args.max_participants;
  const maxParticipants =
    maxParticipantsRaw != null && Number.isFinite(Number(maxParticipantsRaw)) ? Number(maxParticipantsRaw) : null;

  if (!title) {
    return { ok: false, error: `${toolName} requires a title. Ask the user what to call the ${kindLabel}.` };
  }
  if (!startTime || !Number.isFinite(new Date(startTime).getTime())) {
    return { ok: false, error: `${toolName} requires a valid start_time (date/time). Ask the user when the ${kindLabel} starts.` };
  }
  if (endTime && !Number.isFinite(new Date(endTime).getTime())) {
    return { ok: false, error: `${toolName} was given an end_time that isn't a valid date/time.` };
  }

  if (args.confirm !== true) {
    return {
      ok: true,
      result: { needs_confirmation: true, title, start_time: startTime, location: location || null },
      text: `Confirm with the user: create the ${kindLabel} "${title}" on ${fmtWhen(startTime)}${location ? ` at ${location}` : ''}? When they say yes, call ${toolName} again with confirm:true.`,
    };
  }

  try {
    const { data: event, error } = await sb
      .from('global_community_events')
      .insert({
        title,
        description: description || null,
        event_type: eventType,
        location: location || null,
        virtual_link: virtualLink || null,
        start_time: startTime,
        end_time: endTime || null,
        max_participants: maxParticipants,
        image_url: imageUrl || null,
        metadata: {},
        created_by: id.user_id,
        participant_count: 0,
      })
      .select('id, title, start_time')
      .single();
    if (error || !event) {
      return { ok: false, error: error?.message ?? `${kindLabel} insert failed` };
    }
    const e = event as { id: string; title: string; start_time: string };
    const route = eventDrawerRoute(e.id);
    return {
      ok: true,
      result: {
        event_id: e.id,
        title: e.title,
        start_time: e.start_time,
        decision: 'auto_nav',
        directive: navDirective(route, e.title, `${toolName} created`),
        redirect: { route },
      },
      text: `Done — I created the ${kindLabel} "${e.title}" for ${fmtWhen(e.start_time)}. Opening it now.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : `${toolName} failed` };
  }
}

export async function tool_create_event(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  return createOwnedEvent('create_event', 'event', 'event', args, id, sb);
}

export async function tool_create_meetup(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  return createOwnedEvent('create_meetup', 'meetup', 'meetup', args, id, sb);
}

// ---------------------------------------------------------------------------
// update_my_event / update_my_meetup — same underlying update, event_type
// filter distinguishes which of the caller's rows a fuzzy title can match.
// ---------------------------------------------------------------------------

async function updateOwnedEvent(
  toolName: string,
  kindLabel: string,
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
  eventTypeFilter?: string,
): Promise<OrbToolResult> {
  const gate = authGate(toolName, id);
  if (gate) return gate;
  const queryLabel = String(args.query ?? args.title ?? '').trim();
  try {
    const resolved = await resolveMyEvent(sb, id.user_id, args.event_id, queryLabel, eventTypeFilter);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { updated: false },
        text: queryLabel
          ? `I couldn't find an upcoming ${kindLabel} of yours matching "${queryLabel}".`
          : `Which ${kindLabel} would you like to update? Tell me its name.`,
      };
    }
    if (resolved.kind === 'many') {
      const names = resolved.events.map((e) => e.title).join(', ');
      return {
        ok: true,
        result: { updated: false, candidates: resolved.events.map((e) => ({ event_id: e.id, title: e.title })) },
        text: `You have ${resolved.events.length} upcoming ${kindLabel}s matching that: ${names}. Which one should I update?`,
      };
    }

    const event = resolved.event;
    if (new Date(event.start_time).getTime() <= Date.now()) {
      return {
        ok: true,
        result: { updated: false, event_id: event.id, title: event.title },
        text: `"${event.title}" has already started or passed, so it can't be edited anymore.`,
      };
    }

    const patch: Record<string, unknown> = {};
    if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
    if (typeof args.description === 'string') patch.description = args.description.trim() || null;
    if (typeof args.location === 'string') patch.location = args.location.trim() || null;
    if (typeof args.virtual_link === 'string') patch.virtual_link = args.virtual_link.trim() || null;
    if (typeof args.start_time === 'string' && args.start_time.trim()) {
      const d = new Date(args.start_time);
      if (!Number.isFinite(d.getTime())) {
        return { ok: false, error: `${toolName} was given a start_time that isn't a valid date/time.` };
      }
      patch.start_time = args.start_time.trim();
    }
    if (typeof args.end_time === 'string') {
      if (args.end_time.trim() && !Number.isFinite(new Date(args.end_time).getTime())) {
        return { ok: false, error: `${toolName} was given an end_time that isn't a valid date/time.` };
      }
      patch.end_time = args.end_time.trim() || null;
    }
    if (args.max_participants != null && Number.isFinite(Number(args.max_participants))) {
      patch.max_participants = Number(args.max_participants);
    }
    if (typeof args.image_url === 'string') patch.image_url = args.image_url.trim() || null;

    if (Object.keys(patch).length === 0) {
      return {
        ok: true,
        result: { updated: false, event_id: event.id, title: event.title },
        text: `What would you like to change about "${event.title}"?`,
      };
    }

    const { error: updErr } = await sb
      .from('global_community_events')
      .update(patch)
      .eq('id', event.id)
      .eq('created_by', id.user_id);
    if (updErr) return { ok: false, error: updErr.message };

    const newTitle = (patch.title as string | undefined) ?? event.title;
    const route = eventDrawerRoute(event.id);
    return {
      ok: true,
      result: {
        updated: true,
        event_id: event.id,
        title: newTitle,
        decision: 'auto_nav',
        directive: navDirective(route, newTitle, `${toolName} updated`),
        redirect: { route },
      },
      text: `Done — I've updated "${newTitle}".`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : `${toolName} failed` };
  }
}

export async function tool_update_my_event(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  return updateOwnedEvent('update_my_event', 'event', args, id, sb);
}

export async function tool_update_my_meetup(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  return updateOwnedEvent('update_my_meetup', 'meetup', args, id, sb, 'meetup');
}

// ---------------------------------------------------------------------------
// cancel_my_event — creator-only DELETE, same action EventKebabMenu.tsx's
// "Delete Event" performs (there is no separate cancelled/status flag).
// ---------------------------------------------------------------------------

export async function tool_cancel_my_event(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('cancel_my_event', id);
  if (gate) return gate;
  const queryLabel = String(args.query ?? args.title ?? '').trim();
  try {
    const resolved = await resolveMyEvent(sb, id.user_id, args.event_id, queryLabel);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { cancelled: false },
        text: queryLabel
          ? `I couldn't find an upcoming event of yours matching "${queryLabel}".`
          : 'Which event would you like to cancel? Tell me its name.',
      };
    }
    if (resolved.kind === 'many') {
      const lines = resolved.events.map(speakEventLine).join('; ');
      return {
        ok: true,
        result: { cancelled: false, candidates: resolved.events.map((e) => ({ event_id: e.id, title: e.title })) },
        text: `You have ${resolved.events.length} upcoming events matching that: ${lines}. Which one should I cancel?`,
      };
    }

    const event = resolved.event;
    if (args.confirm !== true) {
      return {
        ok: true,
        result: { needs_confirmation: true, event_id: event.id, title: event.title },
        text: `Confirm with the user: cancel "${event.title}" (${fmtWhen(event.start_time)})? This removes it for everyone who RSVP'd. When they say yes, call cancel_my_event again with this event_id and confirm:true.`,
      };
    }

    const { error: delErr } = await sb
      .from('global_community_events')
      .delete()
      .eq('id', event.id)
      .eq('created_by', id.user_id);
    if (delErr) return { ok: false, error: delErr.message };

    return {
      ok: true,
      result: { cancelled: true, event_id: event.id, title: event.title },
      text: `Done — I've cancelled "${event.title}".`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'cancel_my_event failed' };
  }
}

// ---------------------------------------------------------------------------
// invite_to_event — event_attendees (response='pending') + invite_analytics
// bump, mirroring vitana-v1's useEventInvites.sendInvites() exactly (it
// upserts the same two tables for its "messenger"/"email" channels; voice
// records channel:'voice').
// ---------------------------------------------------------------------------

export async function tool_invite_to_event(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('invite_to_event', id);
  if (gate) return gate;
  const memberName = String(args.member_name ?? args.member ?? '').trim();
  const memberUserIdArg = String(args.member_user_id ?? '').trim();
  if (!memberName && !UUID_RE.test(memberUserIdArg)) {
    return { ok: false, error: 'invite_to_event requires the name of the person to invite.' };
  }
  try {
    const resolved = await resolveAnyUpcomingEvent(sb, args.event_id, String(args.event ?? args.query ?? '').trim());
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { invited: false },
        text: "I couldn't find an upcoming event matching that. Which event did you want to invite them to?",
      };
    }
    if (resolved.kind === 'many') {
      const lines = resolved.events.map(speakEventLine).join('; ');
      return {
        ok: true,
        result: { invited: false, candidates: resolved.events.map((e) => ({ event_id: e.id, title: e.title })) },
        text: `I found several matching events: ${lines}. Which one should I send the invitation for?`,
      };
    }
    const event = resolved.event;

    let inviteeId = memberUserIdArg;
    let inviteeName = memberName || 'that member';
    if (!UUID_RE.test(inviteeId)) {
      const member = await resolveMember(sb, id.user_id, memberName);
      if (member.kind === 'error') return { ok: false, error: member.message };
      if (member.kind === 'none') {
        return {
          ok: true,
          result: { invited: false },
          text: `I couldn't find anyone named "${memberName}" in the community — they may not have a Vitana account yet.`,
        };
      }
      if (member.kind === 'ambiguous') {
        return {
          ok: true,
          result: { invited: false, candidates: member.names },
          text: `I found a few possible matches: ${member.names.join(', ')}. Which one did you mean?`,
        };
      }
      inviteeId = member.user_id;
      inviteeName = member.display_name;
    }
    if (inviteeId === id.user_id) {
      return { ok: false, error: 'You cannot invite yourself to an event.' };
    }

    const { error: upErr } = await sb.from('event_attendees').upsert(
      {
        event_id: event.id,
        user_id: inviteeId,
        response: 'pending',
        invited_by: id.user_id,
        metadata: { channel: 'voice' },
      },
      { onConflict: 'event_id,user_id', ignoreDuplicates: false },
    );
    if (upErr) return { ok: false, error: upErr.message };

    // Best-effort invite_analytics bump — cosmetic engagement counter, mirrors
    // useEventInvites.ts; never fails the invite itself.
    try {
      const { data: existing } = await sb
        .from('invite_analytics')
        .select('sent_count')
        .eq('event_id', event.id)
        .eq('channel', 'voice')
        .maybeSingle();
      const newCount = (Number((existing as { sent_count?: number } | null)?.sent_count) || 0) + 1;
      await sb
        .from('invite_analytics')
        .upsert({ event_id: event.id, channel: 'voice', sent_count: newCount }, { onConflict: 'event_id,channel' });
    } catch {
      /* analytics is best-effort */
    }

    return {
      ok: true,
      result: { invited: true, event_id: event.id, invited_user_id: inviteeId },
      text: `Invitation sent — ${inviteeName} will see "${event.title}" among their pending invites.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'invite_to_event failed' };
  }
}

// ---------------------------------------------------------------------------
// buy_event_ticket — PAYMENT POLICY: validates against the real
// event_ticket_types row, then hands off to the screen for the actual
// Stripe checkout. Never writes event_ticket_purchases (only the
// stripe-create-ticket-checkout edge function can mint a real
// qr_code_token/stripe_session_id pair) and never charges anything by voice.
// ---------------------------------------------------------------------------

interface TicketTypeRow {
  id: string;
  event_id: string;
  name: string;
  price: number | string;
  currency: string;
  quantity_available: number;
  quantity_sold: number;
  is_active: boolean;
  sale_start_date: string | null;
  sale_end_date: string | null;
}

export async function tool_buy_event_ticket(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('buy_event_ticket', id);
  if (gate) return gate;
  const quantity = Math.max(1, Math.floor(Number(args.quantity) || 1));
  try {
    const resolved = await resolveAnyUpcomingEvent(sb, args.event_id, String(args.event ?? args.query ?? '').trim());
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { available: false },
        text: "I couldn't find an upcoming event matching that. Which event's tickets did you want?",
      };
    }
    if (resolved.kind === 'many') {
      const lines = resolved.events.map(speakEventLine).join('; ');
      return {
        ok: true,
        result: { available: false, candidates: resolved.events.map((e) => ({ event_id: e.id, title: e.title })) },
        text: `I found several matching events: ${lines}. Which one's tickets do you want?`,
      };
    }
    const event = resolved.event;

    const { data: types, error: tErr } = await sb
      .from('event_ticket_types')
      .select('id, event_id, name, price, currency, quantity_available, quantity_sold, is_active, sale_start_date, sale_end_date')
      .eq('event_id', event.id)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (tErr) return { ok: false, error: tErr.message };
    const ticketTypes = (types as TicketTypeRow[]) ?? [];
    if (ticketTypes.length === 0) {
      return {
        ok: true,
        result: { available: false },
        text: `"${event.title}" doesn't have any tickets for sale.`,
      };
    }

    const wantedName = String(args.ticket_name ?? args.ticket_type ?? '').trim().toLowerCase();
    const ticketTypeIdArg = String(args.ticket_type_id ?? '').trim();
    let chosen: TicketTypeRow | undefined;
    if (UUID_RE.test(ticketTypeIdArg)) {
      chosen = ticketTypes.find((t) => t.id === ticketTypeIdArg);
    } else if (wantedName) {
      chosen = ticketTypes.find((t) => t.name.toLowerCase().includes(wantedName));
    } else if (ticketTypes.length === 1) {
      chosen = ticketTypes[0];
    }

    if (!chosen) {
      const names = ticketTypes.map((t) => `${t.name} (${t.currency} ${Number(t.price).toFixed(2)})`).join(', ');
      return {
        ok: true,
        result: {
          available: true,
          event_id: event.id,
          ticket_types: ticketTypes.map((t) => ({ ticket_type_id: t.id, name: t.name, price: Number(t.price), currency: t.currency })),
        },
        text: `"${event.title}" has these ticket types: ${names}. Which one would you like?`,
      };
    }

    const now = new Date();
    if (chosen.sale_start_date && new Date(chosen.sale_start_date) > now) {
      return { ok: true, result: { available: false }, text: `Sales for "${chosen.name}" haven't opened yet.` };
    }
    if (chosen.sale_end_date && new Date(chosen.sale_end_date) < now) {
      return { ok: true, result: { available: false }, text: `Sales for "${chosen.name}" have closed.` };
    }
    const remaining = Number(chosen.quantity_available) - Number(chosen.quantity_sold);
    if (remaining < quantity) {
      return {
        ok: true,
        result: { available: false, remaining },
        text:
          remaining <= 0
            ? `"${chosen.name}" tickets for "${event.title}" are sold out.`
            : `Only ${remaining} "${chosen.name}" ticket${remaining === 1 ? '' : 's'} left for "${event.title}" — you asked for ${quantity}.`,
      };
    }

    const totalAmount = Number(chosen.price) * quantity;

    if (args.confirm !== true) {
      return {
        ok: true,
        result: {
          needs_confirmation: true,
          event_id: event.id,
          ticket_type_id: chosen.id,
          quantity,
          total_amount: totalAmount,
          currency: chosen.currency,
        },
        text: `${quantity} × "${chosen.name}" for "${event.title}" comes to ${chosen.currency} ${totalAmount.toFixed(2)}. Confirm with the user, then call buy_event_ticket again with confirm:true — payment happens on their screen, never by voice.`,
      };
    }

    const route = eventDrawerRoute(event.id);
    return {
      ok: true,
      result: {
        prepared: true,
        event_id: event.id,
        ticket_type_id: chosen.id,
        quantity,
        total_amount: totalAmount,
        currency: chosen.currency,
        decision: 'auto_nav',
        directive: navDirective(route, event.title, 'buy_event_ticket prepared'),
        redirect: { route },
      },
      text: `I've got ${quantity} "${chosen.name}" ticket${quantity === 1 ? '' : 's'} for "${event.title}" ready — confirm payment on your screen to finish.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'buy_event_ticket failed' };
  }
}

// ---------------------------------------------------------------------------
// list_my_event_tickets — completed event_ticket_purchases for the caller,
// same query shape as vitana-v1's useMyTickets() hook.
// ---------------------------------------------------------------------------

interface MyTicketRow {
  id: string;
  event_id: string;
  quantity: number;
  total_amount: number | string;
  currency: string;
  status: string;
  ticket_number: string;
  checked_in_at: string | null;
  ticket_type: { name: string } | null;
  event: { title: string; start_time: string; location: string | null } | null;
}

export async function tool_list_my_event_tickets(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('list_my_event_tickets', id);
  if (gate) return gate;
  try {
    const { data, error } = await sb
      .from('event_ticket_purchases')
      .select(
        'id, event_id, quantity, total_amount, currency, status, ticket_number, checked_in_at, ticket_type:event_ticket_types(name), event:global_community_events(title, start_time, location)',
      )
      .eq('buyer_id', id.user_id)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) return { ok: false, error: error.message };
    const rows = (data as unknown as MyTicketRow[]) ?? [];
    if (rows.length === 0) {
      return { ok: true, result: { tickets: [] }, text: "You don't have any event tickets yet." };
    }
    const lines = rows
      .slice(0, 5)
      .map(
        (r) =>
          `${r.quantity} × ${r.ticket_type?.name ?? 'ticket'} for "${r.event?.title ?? 'an event'}"${
            r.event?.start_time ? ` on ${fmtWhen(r.event.start_time)}` : ''
          }`,
      )
      .join('; ');
    return {
      ok: true,
      result: {
        tickets: rows.map((r) => ({
          ticket_id: r.id,
          event_id: r.event_id,
          event_title: r.event?.title ?? null,
          quantity: r.quantity,
          total_amount: Number(r.total_amount),
          currency: r.currency,
          ticket_number: r.ticket_number,
          checked_in: !!r.checked_in_at,
        })),
      },
      text: `You have ${rows.length} event ticket${rows.length === 1 ? '' : 's'}: ${lines}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'list_my_event_tickets failed' };
  }
}

// ---------------------------------------------------------------------------
// share_event — no DB write; returns the public event landing link (the
// same /pub/events/:id route PublicEventLanding.tsx serves, which works for
// recipients who aren't logged in yet, unlike the in-app drawer route).
// ---------------------------------------------------------------------------

export async function tool_share_event(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('share_event', id);
  if (gate) return gate;
  try {
    const resolved = await resolveAnyUpcomingEvent(sb, args.event_id, String(args.query ?? args.title ?? '').trim());
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { shared: false },
        text: "I couldn't find that event to share. Which event did you mean?",
      };
    }
    if (resolved.kind === 'many') {
      const lines = resolved.events.map(speakEventLine).join('; ');
      return {
        ok: true,
        result: { shared: false, candidates: resolved.events.map((e) => ({ event_id: e.id, title: e.title })) },
        text: `I found several matching events: ${lines}. Which one should I get the share link for?`,
      };
    }
    const event = resolved.event;
    const base = process.env.FRONTEND_PUBLIC_URL || 'https://vitanaland.com';
    const shareUrl = `${base}/pub/events/${encodeURIComponent(event.id)}`;
    return {
      ok: true,
      result: { event_id: event.id, title: event.title, share_url: shareUrl },
      text: `Here's the link to share "${event.title}": ${shareUrl}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'share_event failed' };
  }
}

// ---------------------------------------------------------------------------
// get_event_attendees — organizer-only. Reads global_event_participants
// (status='attending', the RSVP table) joined with app_users, the same
// resolve-then-join-app_users shape groups-events-tools.ts's group-member
// lookups use.
// ---------------------------------------------------------------------------

export async function tool_get_event_attendees(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('get_event_attendees', id);
  if (gate) return gate;
  const queryLabel = String(args.query ?? args.title ?? '').trim();
  try {
    const resolved = await resolveMyEvent(sb, id.user_id, args.event_id, queryLabel);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { attendees: [] },
        text: queryLabel
          ? `I couldn't find an upcoming event of yours matching "${queryLabel}" — only the organizer can see attendees.`
          : 'Which of your events do you want the attendee list for?',
      };
    }
    if (resolved.kind === 'many') {
      const names = resolved.events.map((e) => e.title).join(', ');
      return {
        ok: true,
        result: { attendees: [], candidates: resolved.events.map((e) => ({ event_id: e.id, title: e.title })) },
        text: `You have ${resolved.events.length} upcoming events matching that: ${names}. Which one?`,
      };
    }
    const event = resolved.event;

    const { data: parts, error: pErr } = await sb
      .from('global_event_participants')
      .select('user_id')
      .eq('event_id', event.id)
      .eq('status', 'attending');
    if (pErr) return { ok: false, error: pErr.message };
    const userIds = ((parts as Array<{ user_id: string }>) ?? []).map((p) => p.user_id);
    if (userIds.length === 0) {
      return {
        ok: true,
        result: { event_id: event.id, title: event.title, attendee_count: 0, attendees: [] },
        text: `No one has signed up for "${event.title}" yet.`,
      };
    }

    const { data: users, error: uErr } = await sb
      .from('app_users')
      .select('user_id, display_name, vitana_id')
      .in('user_id', userIds);
    if (uErr) return { ok: false, error: uErr.message };
    const names = ((users as Array<{ user_id: string; display_name: string | null; vitana_id: string | null }>) ?? []).map(
      (u) => u.display_name || u.vitana_id || 'a member',
    );
    const shown = names.slice(0, 8).join(', ');
    return {
      ok: true,
      result: { event_id: event.id, title: event.title, attendee_count: userIds.length, attendees: names },
      text: `${userIds.length} ${userIds.length === 1 ? 'person is' : 'people are'} signed up for "${event.title}": ${shown}${
        names.length > 8 ? ', and more' : ''
      }.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_event_attendees failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const EVENTS_TICKETS_TOOL_HANDLERS: Record<string, Handler> = {
  create_event: tool_create_event,
  update_my_event: tool_update_my_event,
  cancel_my_event: tool_cancel_my_event,
  create_meetup: tool_create_meetup,
  update_my_meetup: tool_update_my_meetup,
  invite_to_event: tool_invite_to_event,
  buy_event_ticket: tool_buy_event_ticket,
  list_my_event_tickets: tool_list_my_event_tickets,
  share_event: tool_share_event,
  get_event_attendees: tool_get_event_attendees,
};

export const EVENTS_TICKETS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'create_event',
    description: [
      'Create a new ticketed/community event. Requires a title and start_time.',
      'ALWAYS call once WITHOUT confirm first — the tool returns a',
      'confirmation question; after the user says yes, call again with',
      'confirm:true.',
      'CALL WHEN the user says: "create an event called ...", "schedule a new',
      'event", "erstelle ein Event ...", "plane eine neue Veranstaltung".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The event title.' },
        description: { type: 'string', description: 'Optional short event description.' },
        location: { type: 'string', description: 'Optional physical location.' },
        virtual_link: { type: 'string', description: 'Optional virtual/streaming link.' },
        start_time: { type: 'string', description: 'ISO date/time the event starts. Required.' },
        end_time: { type: 'string', description: 'Optional ISO date/time the event ends.' },
        max_participants: { type: 'number', description: 'Optional capacity cap.' },
        image_url: { type: 'string', description: 'Optional cover image URL.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the creation.' },
      },
      required: ['title', 'start_time'],
    },
  },
  {
    name: 'update_my_event',
    description: [
      "Edit one of the user's own upcoming events (title, description,",
      'location, virtual_link, start_time, end_time, max_participants,',
      'image_url). Only the creator can edit, and only before it starts.',
      'CALL WHEN the user says: "change the time of my event ...", "update my',
      'event description", "ändere mein Event ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Spoken title of the user's event (fuzzy matched)." },
        event_id: { type: 'string', description: 'Exact event UUID when known from a previous tool result.' },
        title: { type: 'string', description: 'New title, if changing it.' },
        description: { type: 'string', description: 'New description, if changing it.' },
        location: { type: 'string', description: 'New location, if changing it.' },
        virtual_link: { type: 'string', description: 'New virtual link, if changing it.' },
        start_time: { type: 'string', description: 'New ISO start_time, if changing it.' },
        end_time: { type: 'string', description: 'New ISO end_time, if changing it.' },
        max_participants: { type: 'number', description: 'New capacity cap, if changing it.' },
        image_url: { type: 'string', description: 'New cover image URL, if changing it.' },
      },
      required: [],
    },
  },
  {
    name: 'cancel_my_event',
    description: [
      "Cancel (delete) one of the user's own upcoming events. ALWAYS call",
      'once WITHOUT confirm first — the tool returns a confirmation question;',
      'after the user says yes, call again with the event_id and confirm:true.',
      'CALL WHEN the user says: "cancel my event", "delete the ... event",',
      '"sage mein Event ... ab".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Spoken title of the user's event (fuzzy matched)." },
        event_id: { type: 'string', description: 'Exact event UUID when known.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the cancellation.' },
      },
      required: [],
    },
  },
  {
    name: 'create_meetup',
    description: [
      'Create a new casual community meetup (lighter-weight than a ticketed',
      'event). Requires a title and start_time. ALWAYS call once WITHOUT',
      'confirm first — the tool returns a confirmation question; after the',
      'user says yes, call again with confirm:true.',
      'CALL WHEN the user says: "create a meetup for ...", "start a walking',
      'meetup", "erstelle ein Meetup für ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The meetup title.' },
        description: { type: 'string', description: 'Optional short meetup description.' },
        location: { type: 'string', description: 'Optional physical location.' },
        virtual_link: { type: 'string', description: 'Optional virtual/streaming link.' },
        start_time: { type: 'string', description: 'ISO date/time the meetup starts. Required.' },
        end_time: { type: 'string', description: 'Optional ISO date/time the meetup ends.' },
        max_participants: { type: 'number', description: 'Optional capacity cap.' },
        image_url: { type: 'string', description: 'Optional cover image URL.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the creation.' },
      },
      required: ['title', 'start_time'],
    },
  },
  {
    name: 'update_my_meetup',
    description: [
      "Edit one of the user's own upcoming meetups (title, description,",
      'location, virtual_link, start_time, end_time, max_participants,',
      'image_url). Only the creator can edit, and only before it starts.',
      'CALL WHEN the user says: "change my meetup time", "update the hiking',
      'meetup details", "ändere mein Meetup ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Spoken title of the user's meetup (fuzzy matched)." },
        event_id: { type: 'string', description: 'Exact meetup UUID when known from a previous tool result.' },
        title: { type: 'string', description: 'New title, if changing it.' },
        description: { type: 'string', description: 'New description, if changing it.' },
        location: { type: 'string', description: 'New location, if changing it.' },
        virtual_link: { type: 'string', description: 'New virtual link, if changing it.' },
        start_time: { type: 'string', description: 'New ISO start_time, if changing it.' },
        end_time: { type: 'string', description: 'New ISO end_time, if changing it.' },
        max_participants: { type: 'number', description: 'New capacity cap, if changing it.' },
        image_url: { type: 'string', description: 'New cover image URL, if changing it.' },
      },
      required: [],
    },
  },
  {
    name: 'invite_to_event',
    description: [
      'Invite a community member to an event or meetup by spoken name. The',
      'member gets a pending invite on the event.',
      'CALL WHEN the user says: "invite Anna to my yoga meetup", "ask Ben to',
      'come to the event", "lade Anna zu meinem Event ... ein".',
      'If the tool lists several event or member candidates, ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Spoken event/meetup title (fuzzy matched against upcoming events).' },
        event_id: { type: 'string', description: 'Exact event UUID when known.' },
        member_name: { type: 'string', description: 'Spoken name of the member to invite.' },
        member_user_id: { type: 'string', description: 'Exact user UUID when known from a previous tool result.' },
      },
      required: [],
    },
  },
  {
    name: 'buy_event_ticket',
    description: [
      'Buy a ticket for an event. Checks ticket availability and price, then',
      'ALWAYS call once WITHOUT confirm first — the tool returns a price',
      'confirmation question; after the user says yes, call again with',
      'confirm:true. Even after confirming, payment is completed on the',
      "user's screen — this tool never charges a card by voice; it prepares",
      'the purchase and opens the ticket screen.',
      'CALL WHEN the user says: "buy a ticket for ...", "I want two tickets to',
      'the gala", "kauf mir ein Ticket für ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Spoken event title (fuzzy matched against upcoming events).' },
        event_id: { type: 'string', description: 'Exact event UUID when known.' },
        ticket_name: { type: 'string', description: 'Spoken ticket tier name (e.g. "VIP", "General Admission").' },
        ticket_type_id: { type: 'string', description: 'Exact ticket type UUID when known.' },
        quantity: { type: 'number', description: 'How many tickets to buy. Defaults to 1.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the price and purchase.' },
      },
      required: [],
    },
  },
  {
    name: 'list_my_event_tickets',
    description: [
      "List the user's own purchased (completed) event tickets.",
      'CALL WHEN the user asks: "what tickets do I have?", "show my event',
      'tickets", "welche Tickets habe ich?".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'share_event',
    description: [
      'Get a shareable public link for an event or meetup (works even for',
      "people who aren't logged in). Does not send anything itself — just",
      'returns the link for the user to share however they like.',
      'CALL WHEN the user says: "share the yoga meetup", "get me a link for',
      'that event", "gib mir einen Link für das Event ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Spoken event/meetup title (fuzzy matched).' },
        event_id: { type: 'string', description: 'Exact event UUID when known.' },
      },
      required: [],
    },
  },
  {
    name: 'get_event_attendees',
    description: [
      "List who has RSVP'd to one of the user's OWN events (organizer view",
      'only — the user must be the creator).',
      'CALL WHEN the user asks: "who\'s coming to my event?", "how many people',
      'signed up for my meetup?", "wer kommt zu meinem Event?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Spoken title of the user's event (fuzzy matched)." },
        event_id: { type: 'string', description: 'Exact event UUID when known.' },
      },
      required: [],
    },
  },
];
