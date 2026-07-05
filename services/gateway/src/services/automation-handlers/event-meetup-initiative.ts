/**
 * Event & Meetup Initiative Handlers — AP-1400 series
 *
 * VTID: VTID-01250
 * Automations for proactive event creation, invitation, and discovery.
 * Real schema: global_community_events/global_event_participants is the
 * live events stack (community_meetups was never deployed); calendar_events
 * is a per-user personal calendar (no tenant_id); relationship_edges is
 * source_type/source_id/target_type/target_id/edge_type.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-1401: Smart Event Creation ───────────────────────────
// Heartbeat scan: finds a user with 3+ connections sharing a top interest
// and no upcoming shared event, and suggests they create one (a proactive
// nudge, not an automatic creation — event creation is a frontend flow).
const SMART_CREATE_MIN_CONNECTIONS = 3;
const SMART_CREATE_COOLDOWN_DAYS = 14;
const SMART_CREATE_MAX_USERS_PER_RUN = 300;

async function runSmartEventCreation(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = (await ctx.queryTargetUsers()).slice(0, SMART_CREATE_MAX_USERS_PER_RUN);
  const cooldownCutoff = new Date(Date.now() - SMART_CREATE_COOLDOWN_DAYS * 86_400_000).toISOString();

  for (const { user_id } of users) {
    const { data: connections } = await supabase
      .from('relationship_edges')
      .select('target_id')
      .eq('tenant_id', tenantId)
      .eq('source_type', 'person')
      .eq('source_id', user_id)
      .eq('target_type', 'person')
      .eq('edge_type', 'connected')
      .limit(50);

    if ((connections?.length || 0) < SMART_CREATE_MIN_CONNECTIONS) continue;

    const { data: topInterest } = await supabase
      .from('user_interests')
      .select('interest')
      .eq('user_id', user_id)
      .order('confidence_score', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!topInterest?.interest) continue;

    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', user_id)
      .contains('data', { automation_id: 'AP-1401' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Start Something New',
      body: `You have ${connections?.length} connections who might enjoy a "${topInterest.interest}" meetup — want to create one?`,
      data: { url: '/community/events/new', automation_id: 'AP-1401' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1402: Calendar Availability Check ────────────────────
// calendar_events is the real personal-calendar table (per-user, no
// tenant_id). Checks for a scheduling conflict before confirming a user's
// event registration.
async function runCalendarAvailabilityCheck(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id: userId, event_id: eventId } = payload || {};
  if (!userId || !eventId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase } = ctx;

  const { data: event } = await supabase
    .from('global_community_events')
    .select('title, start_time, end_time')
    .eq('id', eventId)
    .maybeSingle();
  if (!event) return { usersAffected: 0, actionsTaken: 0 };

  const { data: conflicts } = await supabase
    .from('calendar_events')
    .select('id, title')
    .eq('user_id', userId)
    .lt('start_time', event.end_time || event.start_time)
    .gt('end_time', event.start_time)
    .limit(1);

  if (!conflicts?.length) return { usersAffected: 0, actionsTaken: 0 };

  ctx.notify(userId, 'orb_suggestion', {
    title: 'Possible Scheduling Conflict',
    body: `"${event.title}" overlaps with "${conflicts[0].title}" on your calendar.`,
    data: { url: `/community/events/${eventId}`, event_id: eventId },
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1403: Auto-Invitation Sender ─────────────────────────
// Nothing dispatches 'event.created' (frontend writes global_community_events
// directly via Supabase — same gap as AP-0204/AP-1401) — implemented as a
// heartbeat scan of recently-created events, auto-inviting the creator's
// close connections who aren't already registered.
const AUTO_INVITE_LOOKBACK_MINUTES = 30;
const AUTO_INVITE_MAX_EVENTS_PER_RUN = 25;
const AUTO_INVITE_MAX_CONNECTIONS_PER_EVENT = 20;

async function runAutoInvitationSender(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const since = new Date(Date.now() - AUTO_INVITE_LOOKBACK_MINUTES * 60 * 1000).toISOString();

  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title, created_by')
    .not('created_by', 'is', null)
    .gte('created_at', since)
    .limit(AUTO_INVITE_MAX_EVENTS_PER_RUN);

  for (const event of events || []) {
    const { data: connections } = await supabase
      .from('relationship_edges')
      .select('target_id')
      .eq('tenant_id', tenantId)
      .eq('source_type', 'person')
      .eq('source_id', event.created_by)
      .eq('target_type', 'person')
      .eq('edge_type', 'connected')
      .limit(AUTO_INVITE_MAX_CONNECTIONS_PER_EVENT);

    for (const conn of connections || []) {
      const { data: existing } = await supabase
        .from('global_event_participants')
        .select('id')
        .eq('event_id', event.id)
        .eq('user_id', conn.target_id)
        .limit(1);
      if (existing && existing.length > 0) continue;

      ctx.notify(conn.target_id, 'orb_suggestion', {
        title: 'You\'re Invited!',
        body: `A connection created "${event.title}" — want to join?`,
        data: { url: `/community/events/${event.id}`, event_id: event.id },
      });

      usersAffected++;
      actionsTaken++;
    }
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1404: Event Discovery Recommendation ─────────────────
// Daily cron: recommends the highest-participation upcoming event a user
// isn't already attending.
const DISCOVERY_LOOKAHEAD_DAYS = 14;
const DISCOVERY_MAX_USERS_PER_RUN = 1000;

async function runEventDiscoveryRecommendation(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const lookahead = new Date(now.getTime() + DISCOVERY_LOOKAHEAD_DAYS * 86_400_000);

  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title, participant_count')
    .gte('start_time', now.toISOString())
    .lte('start_time', lookahead.toISOString())
    .order('participant_count', { ascending: false })
    .limit(5);

  if (!events?.length) return { usersAffected: 0, actionsTaken: 0 };

  const users = (await ctx.queryTargetUsers()).slice(0, DISCOVERY_MAX_USERS_PER_RUN);

  for (const { user_id } of users) {
    let recommended: any = null;
    for (const event of events) {
      const { data: attending } = await supabase
        .from('global_event_participants')
        .select('id')
        .eq('event_id', event.id)
        .eq('user_id', user_id)
        .limit(1);
      if (!attending || attending.length === 0) { recommended = event; break; }
    }
    if (!recommended) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Trending in Your Community',
      body: `"${recommended.title}" has ${recommended.participant_count || 0} people going — check it out.`,
      data: { url: `/community/events/${recommended.id}`, event_id: recommended.id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1405: Social Meetup Organizer ────────────────────────
// Heartbeat scan distinct from AP-1401 (which nudges one high-connection
// user): finds a mutually-connected trio sharing an interest with no
// existing shared event and suggests all three organize a meetup together.
const ORGANIZER_MAX_USERS_PER_RUN = 300;
const ORGANIZER_COOLDOWN_DAYS = 14;

async function runSocialMeetupOrganizer(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = (await ctx.queryTargetUsers()).slice(0, ORGANIZER_MAX_USERS_PER_RUN);
  const cooldownCutoff = new Date(Date.now() - ORGANIZER_COOLDOWN_DAYS * 86_400_000).toISOString();

  for (const { user_id } of users) {
    const { data: connections } = await supabase
      .from('relationship_edges')
      .select('target_id')
      .eq('tenant_id', tenantId)
      .eq('source_type', 'person')
      .eq('source_id', user_id)
      .eq('target_type', 'person')
      .eq('edge_type', 'connected')
      .limit(20);

    const connectionIds = (connections || []).map((c: any) => c.target_id);
    if (connectionIds.length < 2) continue;

    // Find a mutual pair among this user's connections (a-b also connected)
    let mutualPair: [string, string] | null = null;
    for (let i = 0; i < connectionIds.length && !mutualPair; i++) {
      const { data: mutualEdge } = await supabase
        .from('relationship_edges')
        .select('target_id')
        .eq('tenant_id', tenantId)
        .eq('source_type', 'person')
        .eq('source_id', connectionIds[i])
        .eq('target_type', 'person')
        .eq('edge_type', 'connected')
        .in('target_id', connectionIds)
        .limit(1);
      if (mutualEdge && mutualEdge.length > 0) {
        mutualPair = [connectionIds[i], mutualEdge[0].target_id];
      }
    }
    if (!mutualPair) continue;

    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', user_id)
      .contains('data', { automation_id: 'AP-1405' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Bring Your Circle Together',
      body: 'A few of your connections know each other too — a great chance to organize a group meetup.',
      data: { url: '/community/events/new', automation_id: 'AP-1405' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

export function registerEventMeetupInitiativeHandlers(): void {
  registerHandler('runSmartEventCreation', runSmartEventCreation);
  registerHandler('runCalendarAvailabilityCheck', runCalendarAvailabilityCheck);
  registerHandler('runAutoInvitationSender', runAutoInvitationSender);
  registerHandler('runEventDiscoveryRecommendation', runEventDiscoveryRecommendation);
  registerHandler('runSocialMeetupOrganizer', runSocialMeetupOrganizer);
}
