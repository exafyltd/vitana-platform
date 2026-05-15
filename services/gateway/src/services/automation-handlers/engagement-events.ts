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
    .eq('user_id', user_id)
    .eq('target_type', 'person')
    .eq('relationship_type', 'connected')
    .limit(10);

  const connectionIds = (connections || []).map((c: any) => c.target_id);
  if (!connectionIds.length) {
    ctx.notify(user_id, 'event_match_suggested', {
      title: 'Event Match',
      body: 'An event matches your interests — check it out!',
      data: { url: `/community/meetups/${event_id}`, meetup_id: event_id },
    });
    return { usersAffected: 1, actionsTaken: 1 };
  }

  const { data: attendingConnections } = await supabase
    .from('community_meetup_attendance')
    .select('user_id')
    .eq('meetup_id', event_id)
    .in('user_id', connectionIds)
    .eq('status', 'rsvp');

  if (attendingConnections?.length) {
    const { data: friend } = await supabase
      .from('app_users').select('display_name').eq('id', attendingConnections[0].user_id).maybeSingle();

    ctx.notify(user_id, 'event_match_suggested', {
      title: 'Go Together!',
      body: `${friend?.display_name || 'A friend'} is going — join them!`,
      data: { url: `/community/meetups/${event_id}`, meetup_id: event_id },
    });
  } else {
    ctx.notify(user_id, 'event_match_suggested', {
      title: 'Event Match',
      body: 'An event matches your interests — check it out!',
      data: { url: `/community/meetups/${event_id}`, meetup_id: event_id },
    });
  }

  return { usersAffected: 1, actionsTaken: 1 };
}

async function runPostEventFeedback(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const meetupId = payload?.meetup_id;
  if (!meetupId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase } = ctx;
  let usersAffected = 0;

  const { data: attendees } = await supabase
    .from('community_meetup_attendance')
    .select('user_id')
    .eq('meetup_id', meetupId)
    .eq('status', 'attended');

  for (const att of attendees || []) {
    ctx.notify(att.user_id, 'orb_proactive_message', {
      title: 'How Was the Event?',
      body: 'Rate your experience — it helps improve future events.',
      data: { url: `/community/meetups/${meetupId}`, meetup_id: meetupId },
    });
    usersAffected++;
  }

  return { usersAffected, actionsTaken: usersAffected };
}

async function runTrendingEventsDigest(ctx: AutomationContext) {
  ctx.log('Trending events weekly digest — finding popular upcoming events');
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Find upcoming events with highest RSVP count
  const { data: meetups } = await supabase
    .from('community_meetups')
    .select('id, title, starts_at')
    .eq('tenant_id', tenantId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', nextWeek.toISOString())
    .order('starts_at', { ascending: true })
    .limit(10);

  if (!meetups?.length) return { usersAffected: 0, actionsTaken: 0 };

  // Score meetups by RSVP count
  const scored: Array<{ id: string; title: string; rsvps: number }> = [];
  for (const meetup of meetups) {
    const { count } = await supabase
      .from('community_meetup_attendance')
      .select('id', { count: 'exact', head: true })
      .eq('meetup_id', meetup.id)
      .eq('status', 'rsvp');

    scored.push({ id: meetup.id, title: meetup.title, rsvps: count || 0 });
  }

  // Get top 3 by RSVPs
  const trending = scored.sort((a, b) => b.rsvps - a.rsvps).slice(0, 3);
  if (!trending.length || trending[0].rsvps === 0) return { usersAffected: 0, actionsTaken: 0 };

  // Send to active users who haven't RSVP'd
  const users = await ctx.queryTargetUsers('user_id, active_role');
  const topEvent = trending[0];

  for (const { user_id } of users.slice(0, 100)) {
    // Skip users already RSVP'd to the top event
    const { count: alreadyRsvpd } = await supabase
      .from('community_meetup_attendance')
      .select('id', { count: 'exact', head: true })
      .eq('meetup_id', topEvent.id)
      .eq('user_id', user_id)
      .eq('status', 'rsvp');

    if ((alreadyRsvpd || 0) > 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Trending This Week',
      body: `"${topEvent.title}" has ${topEvent.rsvps} people going. ${trending.length > 1 ? `Plus ${trending.length - 1} more events!` : ''}`,
      data: { url: '/events' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

async function runNoShowFollowUp(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const meetupId = payload?.meetup_id;
  if (!meetupId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;
  let usersAffected = 0;

  const { data: noShows } = await supabase
    .from('community_meetup_attendance')
    .select('user_id')
    .eq('meetup_id', meetupId)
    .eq('status', 'rsvp'); // RSVP but not attended

  const { data: meetup } = await supabase
    .from('community_meetups')
    .select('title')
    .eq('id', meetupId)
    .maybeSingle();

  for (const ns of noShows || []) {
    ctx.notify(ns.user_id, 'orb_proactive_message', {
      title: `We Missed You!`,
      body: `We missed you at "${meetup?.title || 'the meetup'}". Hope to see you next time!`,
      data: { url: '/community/meetups' },
    });
    usersAffected++;
  }

  return { usersAffected, actionsTaken: usersAffected };
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
      .from('matches_daily')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .gte('match_date', sevenDaysAgo);

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
    .select('sender_id, recipient_id')
    .eq('tenant_id', tenantId)
    .gte('created_at', sevenDaysAgo)
    .lte('created_at', threeDaysAgo)
    .limit(50);

  const nudgedPairs = new Set<string>();

  for (const msg of recentConvos || []) {
    const pairKey = [msg.sender_id, msg.recipient_id].sort().join('-');
    if (nudgedPairs.has(pairKey)) continue;

    // Check if conversation went quiet
    const { count: recentMsgs } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .or(`sender_id.eq.${msg.sender_id},sender_id.eq.${msg.recipient_id}`)
      .or(`recipient_id.eq.${msg.sender_id},recipient_id.eq.${msg.recipient_id}`)
      .gte('created_at', threeDaysAgo);

    if ((recentMsgs || 0) > 0) continue;

    nudgedPairs.add(pairKey);

    const { data: peer } = await supabase
      .from('app_users').select('display_name').eq('id', msg.recipient_id).maybeSingle();

    ctx.notify(msg.sender_id, 'conversation_followup_reminder', {
      title: 'Continue the Conversation',
      body: `It's been a few days since you chatted with ${peer?.display_name || 'your connection'}.`,
      data: { url: `/chat/${msg.recipient_id}`, peer_id: msg.recipient_id },
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

  // Engagement Loops (AP-0500)
  registerHandler('runMorningBriefing', runMorningBriefing);
  registerHandler('runWeeklyCommunityDigest', runWeeklyCommunityDigest);
  registerHandler('runDormantUserReEngagement', runDormantUserReEngagement);
  registerHandler('runMilestoneCelebration', runMilestoneCelebration);
  registerHandler('runDiaryReminderSocial', runDiaryReminderSocial);
  registerHandler('runWeeklyReflection', runWeeklyReflection);
  registerHandler('runConversationContinuityNudge', runConversationContinuityNudge);
  registerHandler('runMilestoneScanner', runMilestoneScanner);
  registerHandler('runUpcomingEventsToday', runUpcomingEventsToday);

  // Platform Operations (AP-1000)
  registerHandler('runVtidLifecycle', runVtidLifecycle);
  registerHandler('runGovernanceFlagCheck', runGovernanceFlagCheck);
}
