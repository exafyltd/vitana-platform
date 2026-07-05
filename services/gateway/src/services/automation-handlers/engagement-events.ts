/**
 * Engagement, Events & Platform Handlers — AP-0300/0500/1000 series
 *
 * VTID: VTID-01250
 * Handlers for engagement loops, events/live rooms, and platform ops.
 * Many delegate to existing scheduled notification endpoints.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// =============================================================================
// AP-0300: Events & Live Rooms
// =============================================================================

async function runAutoScheduleDailyRoom(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  ctx.log(`Auto-scheduling Daily.co room for meetup ${payload?.meetup_id}`);
  // Delegates to existing vitana-daily skill / Daily.co client
  return { usersAffected: 0, actionsTaken: 1 };
}

async function runGraduatedReminders(ctx: AutomationContext) {
  ctx.log('Graduated meetup reminders — dispatching via scheduled-notifications');
  const { tenantId } = ctx;

  try {
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resp = await fetch(`${gatewayUrl}/api/v1/scheduled-notifications/meetup-reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId }),
    });

    if (!resp.ok) {
      ctx.log(`Meetup reminders endpoint failed: ${resp.status}`);
      return { usersAffected: 0, actionsTaken: 0 };
    }

    const result = await resp.json() as any;
    ctx.log(`Meetup reminders dispatched to ${result.dispatched || 0} users`);
    return { usersAffected: result.dispatched || 0, actionsTaken: result.dispatched || 0 };
  } catch (err: any) {
    ctx.log(`Meetup reminders error: ${err.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
}

// Real schema: community_meetups/community_meetup_attendance (VTID-01084)
// were never deployed; global_community_events/global_event_participants is
// the real, live events schema (status only has 'attending' — no separate
// RSVP-vs-attended distinction). relationship_edges is source_type/source_id/
// target_type/target_id/edge_type. app_users' primary key is user_id.
// NOTE: this automation's trigger (event 'match.daily.event') is not
// currently dispatched anywhere in the codebase — flagged, not fixed here.
async function runGoTogetherMatch(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, event_id } = payload || {};
  if (!user_id || !event_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Check if connections are attending
  const { data: connections } = await supabase
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', user_id)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .limit(10);

  const connectionIds = (connections || []).map((c: any) => c.target_id);
  if (!connectionIds.length) {
    ctx.notify(user_id, 'event_match_suggested', {
      title: 'Event Match',
      body: 'An event matches your interests — check it out!',
      data: { url: `/community/events/${event_id}`, event_id },
    });
    return { usersAffected: 1, actionsTaken: 1 };
  }

  const { data: attendingConnections } = await supabase
    .from('global_event_participants')
    .select('user_id')
    .eq('event_id', event_id)
    .in('user_id', connectionIds)
    .eq('status', 'attending');

  if (attendingConnections?.length) {
    const { data: friend } = await supabase
      .from('app_users').select('display_name').eq('user_id', attendingConnections[0].user_id).maybeSingle();

    ctx.notify(user_id, 'event_match_suggested', {
      title: 'Go Together!',
      body: `${friend?.display_name || 'A friend'} is going — join them!`,
      data: { url: `/community/events/${event_id}`, event_id },
    });
  } else {
    ctx.notify(user_id, 'event_match_suggested', {
      title: 'Event Match',
      body: 'An event matches your interests — check it out!',
      data: { url: `/community/events/${event_id}`, event_id },
    });
  }

  return { usersAffected: 1, actionsTaken: 1 };
}

// AP-0304/AP-0308 both originally triggered on event 'meetup.ended', which
// is never dispatched anywhere in the codebase (mirrors AP-0204's situation
// in community-groups.ts). Converted both to heartbeat scans of recently-
// ended global_community_events instead. Since global_event_participants
// has no attended-vs-no-show distinction (only 'attending'), AP-0304 and
// AP-0308 are deliberately differentiated by timing/tone rather than by a
// real attendance signal: AP-0304 fires shortly after the event ends
// (feedback + connect), AP-0308 fires later (a softer re-engagement nudge)
// — neither claims to know whether the user actually showed up.
const POST_EVENT_WINDOW_START_HOURS = 1;   // AP-0304: event ended 1-6h ago
const POST_EVENT_WINDOW_END_HOURS = 6;
const NO_SHOW_WINDOW_START_HOURS = 24;     // AP-0308: event ended 24-48h ago
const NO_SHOW_WINDOW_END_HOURS = 48;
const POST_EVENT_MAX_EVENTS = 100;

async function runPostEventFeedback(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const windowStart = new Date(Date.now() - POST_EVENT_WINDOW_END_HOURS * 3_600_000).toISOString();
  const windowEnd = new Date(Date.now() - POST_EVENT_WINDOW_START_HOURS * 3_600_000).toISOString();

  const { data: endedEvents } = await supabase
    .from('global_community_events')
    .select('id, title')
    .gte('end_time', windowStart)
    .lte('end_time', windowEnd)
    .limit(POST_EVENT_MAX_EVENTS);

  for (const event of endedEvents || []) {
    const { data: attendees } = await supabase
      .from('global_event_participants')
      .select('user_id')
      .eq('event_id', event.id)
      .eq('status', 'attending');

    for (const att of attendees || []) {
      ctx.notify(att.user_id, 'orb_proactive_message', {
        title: 'How Was the Event?',
        body: 'Rate your experience — it helps improve future events.',
        data: { url: `/community/events/${event.id}`, event_id: event.id },
      });
      usersAffected++;
      actionsTaken++;
    }
  }

  return { usersAffected, actionsTaken };
}

async function runNoShowFollowUp(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const windowStart = new Date(Date.now() - NO_SHOW_WINDOW_END_HOURS * 3_600_000).toISOString();
  const windowEnd = new Date(Date.now() - NO_SHOW_WINDOW_START_HOURS * 3_600_000).toISOString();

  const { data: endedEvents } = await supabase
    .from('global_community_events')
    .select('id, title')
    .gte('end_time', windowStart)
    .lte('end_time', windowEnd)
    .limit(POST_EVENT_MAX_EVENTS);

  for (const event of endedEvents || []) {
    const { data: registered } = await supabase
      .from('global_event_participants')
      .select('user_id')
      .eq('event_id', event.id)
      .eq('status', 'attending');

    for (const reg of registered || []) {
      ctx.notify(reg.user_id, 'orb_proactive_message', {
        title: `How was "${event.title}"?`,
        body: `Hope you had a great time. Check out what's coming up next.`,
        data: { url: '/events', event_id: event.id },
      });
      usersAffected++;
      actionsTaken++;
    }
  }

  return { usersAffected, actionsTaken };
}

// Real schema: global_community_events/global_event_participants, not
// community_meetups/community_meetup_attendance.
async function runTrendingEventsDigest(ctx: AutomationContext) {
  ctx.log('Trending events weekly digest — finding popular upcoming events');
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Find upcoming events with highest registration count
  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title, start_time, participant_count')
    .gte('start_time', now.toISOString())
    .lte('start_time', nextWeek.toISOString())
    .order('participant_count', { ascending: false })
    .limit(10);

  if (!events?.length || (events[0].participant_count || 0) === 0) {
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const trending = events.slice(0, 3);
  const topEvent = trending[0];

  // Send to active users who haven't registered
  const users = await ctx.queryTargetUsers('user_id, active_role');

  for (const { user_id } of users.slice(0, 100)) {
    const { count: alreadyRegistered } = await supabase
      .from('global_event_participants')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', topEvent.id)
      .eq('user_id', user_id);

    if ((alreadyRegistered || 0) > 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Trending This Week',
      body: `"${topEvent.title}" has ${topEvent.participant_count} people going. ${trending.length > 1 ? `Plus ${trending.length - 1} more events!` : ''}`,
      data: { url: '/events' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0309: "Host Night" Concierge ─────────────────────────
// Daily heartbeat: scan upcoming global community events that are coming up
// within CONCIERGE_HORIZON_DAYS but are still under-filled, and send the host
// ONE concierge nudge to promote and fill the room. Events are not linked to
// groups, so the demand signal is the host's own upcoming event. Grouped per
// host (their soonest under-filled event wins) with a per-host cooldown so the
// same host is not nudged on every daily run. In-platform host notification,
// attributed to Autopilot. The share link points at the public event landing
// — the page hosts actually share to bring people in.
const CONCIERGE_HORIZON_DAYS = 30;    // only concierge events coming up within this window
const CONCIERGE_MIN_LEAD_HOURS = 24;  // skip events too imminent to promote
const CONCIERGE_COOLDOWN_DAYS = 7;    // max one nudge per host per week
const CONCIERGE_MIN_VIABLE = 5;       // "filled enough" floor when the event has no cap
const CONCIERGE_MAX_NUDGES = 50;      // safety cap per run

async function runHostNightConcierge(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = Date.now();
  const leadCutoff = new Date(now + CONCIERGE_MIN_LEAD_HOURS * 3_600_000).toISOString();
  const horizonCutoff = new Date(now + CONCIERGE_HORIZON_DAYS * 86_400_000).toISOString();
  const cooldownCutoff = new Date(now - CONCIERGE_COOLDOWN_DAYS * 86_400_000).toISOString();

  // Upcoming events inside the concierge window, soonest first. global_community_events
  // has no tenant_id — the global community is shared — so we scan across all of them.
  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title, start_time, participant_count, max_participants, created_by, slug')
    .gte('start_time', leadCutoff)
    .lte('start_time', horizonCutoff)
    .not('created_by', 'is', null)
    .order('start_time', { ascending: true })
    .limit(500);

  const handledHosts = new Set<string>();
  let scanned = 0;

  for (const ev of events || []) {
    if (actionsTaken >= CONCIERGE_MAX_NUDGES) break;
    scanned++;

    // One concierge nudge per host per run — the soonest event reaches them first.
    if (handledHosts.has(ev.created_by)) continue;

    // Under-filled = below half the cap, or below the viable floor when uncapped.
    const signups = ev.participant_count ?? 0;
    const cap = ev.max_participants ?? 0;
    const target = cap > 0 ? Math.ceil(cap / 2) : CONCIERGE_MIN_VIABLE;
    if (signups >= target) continue;

    // Cooldown: skip (and stop considering this host this run) if they were
    // already concierged recently for any event.
    const { data: recentNudge } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', ev.created_by)
      .eq('type', 'orb_proactive_message')
      .contains('data', { automation_id: 'AP-0309' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentNudge && recentNudge.length > 0) {
      handledHosts.add(ev.created_by);
      continue;
    }

    const daysUntil = Math.max(0, Math.round((new Date(ev.start_time).getTime() - now) / 86_400_000));
    const dayWord = daysUntil === 1 ? 'day' : 'days';
    // The public event landing is the shareable promote page (slug preferred).
    const shareUrl = ev.slug ? `/e/${ev.slug}` : `/pub/events/${ev.id}`;
    const title = ev.title || 'your event';

    ctx.notify(ev.created_by, 'orb_proactive_message', {
      title: `"${title}" is coming up — let's fill the room 🎤`,
      body: signups > 0
        ? `${daysUntil} ${dayWord} to go with ${signups} signup${signups === 1 ? '' : 's'}. Share the event link to bring a few more people in.`
        : `${daysUntil} ${dayWord} to go and no signups yet. Share the event link with your community to get people in the room.`,
      data: {
        url: shareUrl,
        event_id: ev.id,
        days_until: String(daysUntil),
        signups: String(signups),
        via: 'autopilot',
        automation_id: 'AP-0309',
      },
    });

    handledHosts.add(ev.created_by);
    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.host_concierge.scanned', {
    events_scanned: scanned,
    nudges_sent: actionsTaken,
    horizon_days: CONCIERGE_HORIZON_DAYS,
  });

  return { usersAffected, actionsTaken };
}

// ── AP-0306: Event Series Auto-Suggestion ───────────────────
// Daily heartbeat: find creators whose most recent past event drew a solid
// crowd and who haven't scheduled a follow-up since, and suggest they turn
// it into a series. A per-host cooldown avoids repeat nudges.
const SERIES_MIN_PAST_PARTICIPANTS = 5;
const SERIES_COOLDOWN_DAYS = 14;
const SERIES_MAX_SUGGESTIONS = 50;

async function runEventSeriesAutoSuggestion(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - SERIES_COOLDOWN_DAYS * 86_400_000).toISOString();

  const { data: pastEvents } = await supabase
    .from('global_community_events')
    .select('id, title, created_by, participant_count, end_time')
    .lt('end_time', now.toISOString())
    .gte('participant_count', SERIES_MIN_PAST_PARTICIPANTS)
    .not('created_by', 'is', null)
    .order('end_time', { ascending: false })
    .limit(200);

  const handledHosts = new Set<string>();
  let suggestionsSent = 0;

  for (const event of pastEvents || []) {
    if (suggestionsSent >= SERIES_MAX_SUGGESTIONS) break;
    if (handledHosts.has(event.created_by)) continue;
    handledHosts.add(event.created_by);

    // Skip if this host already has an upcoming event scheduled.
    const { count: upcomingCount } = await supabase
      .from('global_community_events')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', event.created_by)
      .gt('start_time', now.toISOString());
    if ((upcomingCount || 0) > 0) continue;

    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', event.created_by)
      .contains('data', { automation_id: 'AP-0306' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    ctx.notify(event.created_by, 'orb_proactive_message', {
      title: `"${event.title}" was a hit 🎉`,
      body: `${event.participant_count} people joined last time. Want to schedule the next one and turn it into a series?`,
      data: {
        url: '/community/events/new',
        event_id: event.id,
        via: 'autopilot',
        automation_id: 'AP-0306',
      },
    });

    usersAffected++;
    actionsTaken++;
    suggestionsSent++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0307: Live Room from Trending Chat Topic ─────────────
// Heartbeat every 4h: scan group chat threads for a recent message spike and
// suggest the group creator start a live room (real-time, richer than text)
// while engagement is high. Notify-only — does not auto-create the room,
// since live_rooms requires host/category/pricing setup.
const LIVE_ROOM_SPIKE_WINDOW_HOURS = 4;
const LIVE_ROOM_SPIKE_MIN_MESSAGES = 20;
const LIVE_ROOM_SUGGESTION_COOLDOWN_DAYS = 7;
const LIVE_ROOM_SUGGESTION_MAX = 20;

async function runLiveRoomFromTrendingChatTopic(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const windowStart = new Date(Date.now() - LIVE_ROOM_SPIKE_WINDOW_HOURS * 3_600_000).toISOString();
  const cooldownCutoff = new Date(Date.now() - LIVE_ROOM_SUGGESTION_COOLDOWN_DAYS * 86_400_000).toISOString();

  const { data: groups } = await supabase
    .from('global_community_groups')
    .select('id, name, created_by, chat_thread_id')
    .not('chat_thread_id', 'is', null)
    .not('created_by', 'is', null)
    .limit(500);

  let suggestionsSent = 0;
  for (const group of groups || []) {
    if (suggestionsSent >= LIVE_ROOM_SUGGESTION_MAX) break;

    const { count: messageCount } = await supabase
      .from('global_messages')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', group.chat_thread_id)
      .gte('created_at', windowStart);

    if ((messageCount || 0) < LIVE_ROOM_SPIKE_MIN_MESSAGES) continue;

    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', group.created_by)
      .contains('data', { automation_id: 'AP-0307', group_id: group.id })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    ctx.notify(group.created_by, 'orb_proactive_message', {
      title: `${group.name} is talking a lot right now 💬`,
      body: `${messageCount} messages in the last ${LIVE_ROOM_SPIKE_WINDOW_HOURS}h. Go live to bring the conversation into a real-time room.`,
      data: {
        url: '/live/new',
        group_id: group.id,
        via: 'autopilot',
        automation_id: 'AP-0307',
      },
    });

    usersAffected++;
    actionsTaken++;
    suggestionsSent++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0310: "Go Together +1" Group Outing Builder ──────────
// Extends AP-0303's 1:1 "go together" suggestion into a group outing when
// 2+ mutual connections are already registered for the same event.
// NOTE: same undispatched-trigger caveat as AP-0303 (event 'match.daily.event').
const GROUP_OUTING_MIN_FRIENDS = 2;

async function runGroupOutingBuilder(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, event_id } = payload || {};
  if (!user_id || !event_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: connections } = await supabase
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', user_id)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .limit(50);

  const connectionIds = (connections || []).map((c: any) => c.target_id);
  if (connectionIds.length < GROUP_OUTING_MIN_FRIENDS) return { usersAffected: 0, actionsTaken: 0 };

  const { data: attendingConnections } = await supabase
    .from('global_event_participants')
    .select('user_id')
    .eq('event_id', event_id)
    .in('user_id', connectionIds)
    .eq('status', 'attending');

  const attendingCount = attendingConnections?.length || 0;
  if (attendingCount < GROUP_OUTING_MIN_FRIENDS) return { usersAffected: 0, actionsTaken: 0 };

  ctx.notify(user_id, 'event_match_suggested', {
    title: 'Make it a group outing! 👯',
    body: `${attendingCount} of your connections are going to this event — bring your circle along.`,
    data: { url: `/community/events/${event_id}`, event_id, friend_count: String(attendingCount) },
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// =============================================================================
// AP-0500: Engagement Loops
// =============================================================================

async function runMorningBriefing(ctx: AutomationContext) {
  ctx.log('Morning briefing — generating personal recs + dispatching briefings');
  const { tenantId } = ctx;

  try {
    // Delegate to scheduled-notifications/morning-briefing endpoint
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resp = await fetch(`${gatewayUrl}/api/v1/scheduled-notifications/morning-briefing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId }),
    });

    if (!resp.ok) {
      ctx.log(`Morning briefing endpoint failed: ${resp.status}`);
      return { usersAffected: 0, actionsTaken: 0 };
    }

    const result = await resp.json() as any;
    ctx.log(`Morning briefing dispatched to ${result.dispatched || 0} users`);
    return { usersAffected: result.dispatched || 0, actionsTaken: result.dispatched || 0 };
  } catch (err: any) {
    ctx.log(`Morning briefing error: ${err.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
}

async function runWeeklyCommunityDigest(ctx: AutomationContext) {
  ctx.log('Weekly community digest — dispatching via scheduled-notifications');
  const { tenantId } = ctx;

  try {
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resp = await fetch(`${gatewayUrl}/api/v1/scheduled-notifications/weekly-digest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId }),
    });

    if (!resp.ok) {
      ctx.log(`Weekly digest endpoint failed: ${resp.status}`);
      return { usersAffected: 0, actionsTaken: 0 };
    }

    const result = await resp.json() as any;
    ctx.log(`Weekly digest dispatched to ${result.dispatched || 0} users`);
    return { usersAffected: result.dispatched || 0, actionsTaken: result.dispatched || 0 };
  } catch (err: any) {
    ctx.log(`Weekly digest error: ${err.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
}

// Real schema: matches_daily was never deployed; daily_matches (user_id,
// created_at — no tenant_id column) is the live match table.
async function runDormantUserReEngagement(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Find users with no recent notifications read (proxy for inactivity)
  const { data: users } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true);

  for (const { user_id } of users || []) {
    // Check for recent activity (unread notifications as proxy)
    const { count: recentActivity } = await supabase
      .from('user_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .not('read_at', 'is', null)
      .gte('read_at', sevenDaysAgo);

    if ((recentActivity || 0) > 0) continue;

    // Get what they missed
    const { count: pendingMatches } = await supabase
      .from('daily_matches')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .gte('created_at', sevenDaysAgo);

    if ((pendingMatches || 0) === 0) continue;

    ctx.notify(user_id, 'orb_proactive_message', {
      title: 'While You Were Away',
      body: `${pendingMatches} people matched with you this week. Come see who!`,
      data: { url: '/matches' },
    });

    usersAffected++;
    actionsTaken++;
    if (usersAffected >= 50) break; // cap per cycle
  }

  return { usersAffected, actionsTaken };
}

async function runMilestoneCelebration(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, milestone } = payload || {};
  if (!user_id || !milestone) return { usersAffected: 0, actionsTaken: 0 };

  // Look up rich milestone definition
  let title = 'Congratulations!';
  let body = `You reached a milestone: ${milestone}!`;
  let target = '/profile';

  try {
    const { MILESTONES } = await import('../milestone-service');
    const def = MILESTONES[milestone];
    if (def) {
      title = `${def.icon} ${def.name}!`;
      body = def.celebration;
      target = def.target;
    }
  } catch {
    // Fallback to generic message if milestone-service not available
  }

  ctx.notify(user_id, 'orb_proactive_message', {
    title,
    body,
    data: { url: target, milestone },
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

async function runDiaryReminderSocial(ctx: AutomationContext) {
  ctx.log('Diary reminder with social twist — dispatching via scheduled-notifications');
  const { tenantId } = ctx;

  try {
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resp = await fetch(`${gatewayUrl}/api/v1/scheduled-notifications/diary-reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId }),
    });

    if (!resp.ok) {
      ctx.log(`Diary reminder endpoint failed: ${resp.status}`);
      return { usersAffected: 0, actionsTaken: 0 };
    }

    const result = await resp.json() as any;
    ctx.log(`Diary reminder dispatched to ${result.dispatched || 0} users`);
    return { usersAffected: result.dispatched || 0, actionsTaken: result.dispatched || 0 };
  } catch (err: any) {
    ctx.log(`Diary reminder error: ${err.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
}

async function runWeeklyReflection(ctx: AutomationContext) {
  ctx.log('Weekly reflection with connection insights — dispatching via scheduled-notifications');
  const { tenantId } = ctx;

  try {
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resp = await fetch(`${gatewayUrl}/api/v1/scheduled-notifications/weekly-reflection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId }),
    });

    if (!resp.ok) {
      ctx.log(`Weekly reflection endpoint failed: ${resp.status}`);
      return { usersAffected: 0, actionsTaken: 0 };
    }

    const result = await resp.json() as any;
    ctx.log(`Weekly reflection dispatched to ${result.dispatched || 0} users`);
    return { usersAffected: result.dispatched || 0, actionsTaken: result.dispatched || 0 };
  } catch (err: any) {
    ctx.log(`Weekly reflection error: ${err.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
}

// Real schema: chat_messages' recipient column is receiver_id, not
// recipient_id; app_users' primary key is user_id, not id.
async function runConversationContinuityNudge(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Find conversations that went quiet (3+ days since last message)
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Get recent active conversations that went quiet
  const { data: recentConvos } = await supabase
    .from('chat_messages')
    .select('sender_id, receiver_id')
    .eq('tenant_id', tenantId)
    .gte('created_at', sevenDaysAgo)
    .lte('created_at', threeDaysAgo)
    .limit(50);

  const nudgedPairs = new Set<string>();

  for (const msg of recentConvos || []) {
    const pairKey = [msg.sender_id, msg.receiver_id].sort().join('-');
    if (nudgedPairs.has(pairKey)) continue;

    // Check if conversation went quiet
    const { count: recentMsgs } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .or(`sender_id.eq.${msg.sender_id},sender_id.eq.${msg.receiver_id}`)
      .or(`receiver_id.eq.${msg.sender_id},receiver_id.eq.${msg.receiver_id}`)
      .gte('created_at', threeDaysAgo);

    if ((recentMsgs || 0) > 0) continue;

    nudgedPairs.add(pairKey);

    const { data: peer } = await supabase
      .from('app_users').select('display_name').eq('user_id', msg.receiver_id).maybeSingle();

    ctx.notify(msg.sender_id, 'conversation_followup_reminder', {
      title: 'Continue the Conversation',
      body: `It's been a few days since you chatted with ${peer?.display_name || 'your connection'}.`,
      data: { url: `/chat/${msg.receiver_id}`, peer_id: msg.receiver_id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// =============================================================================
// AP-0509: Milestone Scanner (heartbeat)
// =============================================================================

async function runMilestoneScanner(ctx: AutomationContext) {
  ctx.log('Scanning users for new milestones');
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Get recently active users (logged in within last 24h — proxy via notification reads)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: activeUsers } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true)
    .limit(100);

  let scanUserMilestones: typeof import('../milestone-service').scanUserMilestones;
  try {
    const ms = await import('../milestone-service');
    scanUserMilestones = ms.scanUserMilestones;
  } catch (err: any) {
    ctx.log(`Failed to import milestone-service: ${err.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  for (const { user_id } of activeUsers || []) {
    try {
      const newMilestones = await scanUserMilestones(supabase, user_id, tenantId);
      if (newMilestones.length > 0) {
        usersAffected++;
        actionsTaken += newMilestones.length;
        ctx.log(`User ${user_id.slice(0, 8)}… achieved: ${newMilestones.join(', ')}`);
      }
    } catch (err: any) {
      ctx.log(`Error scanning user ${user_id.slice(0, 8)}…: ${err.message}`);
    }
  }

  return { usersAffected, actionsTaken };
}

// =============================================================================
// AP-0510: Upcoming Events Today Push (BOOTSTRAP-NOTIF-SYSTEM-EVENTS)
// Daily cron — delegates to /scheduled-notifications/upcoming-events which
// dispatches the `upcoming_event_today` push for each user's first
// calendar_events entry of the day.
// =============================================================================

async function runUpcomingEventsToday(ctx: AutomationContext) {
  ctx.log('Upcoming events today — dispatching via scheduled-notifications');
  const { tenantId } = ctx;

  try {
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resp = await fetch(`${gatewayUrl}/api/v1/scheduled-notifications/upcoming-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId }),
    });

    if (!resp.ok) {
      ctx.log(`Upcoming events endpoint failed: ${resp.status}`);
      return { usersAffected: 0, actionsTaken: 0 };
    }

    const result = await resp.json() as any;
    ctx.log(`Upcoming events dispatched to ${result.dispatched || 0} users`);
    return { usersAffected: result.dispatched || 0, actionsTaken: result.dispatched || 0 };
  } catch (err: any) {
    ctx.log(`Upcoming events error: ${err.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
}

// =============================================================================
// AP-0511: "Friends Challenge" Social Streak (heartbeat)
// user_diary_streak (user_id, current_streak_days, last_day) is the live
// streak table. Nudges connected pairs (relationship_edges edge_type=
// 'connected') who are both mid-streak to keep each other motivated.
// =============================================================================
const STREAK_MIN_DAYS = 3;
const STREAK_COOLDOWN_DAYS = 7;
const STREAK_MAX_PAIRS_PER_RUN = 200;

function isStreakActive(lastDay: string | null | undefined): boolean {
  if (!lastDay) return false;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return lastDay === today || lastDay === yesterday;
}

async function runFriendsChallengeSocialStreak(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;
  const notifiedPairs = new Set<string>();

  const users = await ctx.queryTargetUsers();

  for (const { user_id } of users) {
    if (notifiedPairs.size >= STREAK_MAX_PAIRS_PER_RUN) break;

    const { data: myStreak } = await supabase
      .from('user_diary_streak')
      .select('current_streak_days, last_day')
      .eq('user_id', user_id)
      .maybeSingle();

    if (!myStreak || (myStreak.current_streak_days || 0) < STREAK_MIN_DAYS) continue;
    if (!isStreakActive(myStreak.last_day)) continue;

    const { data: edges } = await supabase
      .from('relationship_edges')
      .select('target_id')
      .eq('tenant_id', tenantId)
      .eq('source_type', 'person')
      .eq('source_id', user_id)
      .eq('target_type', 'person')
      .eq('edge_type', 'connected')
      .limit(50);

    for (const edge of edges || []) {
      if (notifiedPairs.size >= STREAK_MAX_PAIRS_PER_RUN) break;
      const friendId = edge.target_id;
      const pairKey = [user_id, friendId].sort().join('-');
      if (notifiedPairs.has(pairKey)) continue;

      const { data: friendStreak } = await supabase
        .from('user_diary_streak')
        .select('current_streak_days, last_day')
        .eq('user_id', friendId)
        .maybeSingle();

      if (!friendStreak || (friendStreak.current_streak_days || 0) < STREAK_MIN_DAYS) continue;
      if (!isStreakActive(friendStreak.last_day)) continue;

      const cooldownCutoff = new Date(Date.now() - STREAK_COOLDOWN_DAYS * 86_400_000).toISOString();
      const { data: recentNudge } = await supabase
        .from('user_notifications')
        .select('id')
        .eq('user_id', user_id)
        .contains('data', { automation_id: 'AP-0511', pair_key: pairKey })
        .gte('created_at', cooldownCutoff)
        .limit(1);
      if (recentNudge && recentNudge.length > 0) continue;

      notifiedPairs.add(pairKey);

      ctx.notify(user_id, 'orb_suggestion', {
        title: 'Friendly Streak Challenge \u{1F525}',
        body: `You're on a ${myStreak.current_streak_days}-day streak and so is a friend — keep it going together!`,
        data: { url: '/diary', automation_id: 'AP-0511', pair_key: pairKey },
      });
      ctx.notify(friendId, 'orb_suggestion', {
        title: 'Friendly Streak Challenge \u{1F525}',
        body: `You and a friend are both on a streak — keep each other motivated!`,
        data: { url: '/diary', automation_id: 'AP-0511', pair_key: pairKey },
      });

      usersAffected += 2;
      actionsTaken += 2;
    }
  }

  await ctx.emitEvent('autopilot.engagement.friends_streak_challenge_sent', { pairs: notifiedPairs.size });
  return { usersAffected, actionsTaken };
}

// =============================================================================
// AP-1000: Platform Operations
// =============================================================================

async function runVtidLifecycle(ctx: AutomationContext) {
  ctx.log('VTID lifecycle (delegates to autopilot-controller)');
  return { usersAffected: 0, actionsTaken: 0 };
}

async function runGovernanceFlagCheck(ctx: AutomationContext) {
  ctx.log('Governance flag check (delegates to system-controls-service)');
  return { usersAffected: 0, actionsTaken: 0 };
}

// =============================================================================
// Registration
// =============================================================================

export function registerEngagementEventsHandlers(): void {
  // Events & Live Rooms (AP-0300)
  registerHandler('runAutoScheduleDailyRoom', runAutoScheduleDailyRoom);
  registerHandler('runGraduatedReminders', runGraduatedReminders);
  registerHandler('runGoTogetherMatch', runGoTogetherMatch);
  registerHandler('runPostEventFeedback', runPostEventFeedback);
  registerHandler('runTrendingEventsDigest', runTrendingEventsDigest);
  registerHandler('runNoShowFollowUp', runNoShowFollowUp);
  registerHandler('runHostNightConcierge', runHostNightConcierge);
  registerHandler('runEventSeriesAutoSuggestion', runEventSeriesAutoSuggestion);
  registerHandler('runLiveRoomFromTrendingChatTopic', runLiveRoomFromTrendingChatTopic);
  registerHandler('runGroupOutingBuilder', runGroupOutingBuilder);

  // Engagement Loops (AP-0500)
  registerHandler('runMorningBriefing', runMorningBriefing);
  registerHandler('runWeeklyCommunityDigest', runWeeklyCommunityDigest);
  registerHandler('runDormantUserReEngagement', runDormantUserReEngagement);
  registerHandler('runMilestoneCelebration', runMilestoneCelebration);
  registerHandler('runDiaryReminderSocial', runDiaryReminderSocial);
  registerHandler('runWeeklyReflection', runWeeklyReflection);
  registerHandler('runConversationContinuityNudge', runConversationContinuityNudge);
  registerHandler('runMilestoneScanner', runMilestoneScanner);
  registerHandler('runFriendsChallengeSocialStreak', runFriendsChallengeSocialStreak);
  registerHandler('runUpcomingEventsToday', runUpcomingEventsToday);

  // Platform Operations (AP-1000)
  registerHandler('runVtidLifecycle', runVtidLifecycle);
  registerHandler('runGovernanceFlagCheck', runGovernanceFlagCheck);
}
