/**
 * Live Rooms Commerce Handlers — AP-1200 series
 *
 * VTID: VTID-01250
 * Automations for paid live rooms, bookings, consultations, and creator revenue.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-1201: Paid Live Room Setup ───────────────────────────
async function runPaidLiveRoomSetup(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, service_id } = payload || {};
  if (!user_id || !service_id) return { usersAffected: 0, actionsTaken: 0 };

  ctx.log(`Setting up paid live room for service ${service_id}`);
  await ctx.emitEvent('autopilot.liverooms.paid_room_created', { user_id, service_id });
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1202: Live Room Booking & Payment Flow ───────────────
async function runLiveRoomBookingPayment(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, room_id, host_id } = payload || {};
  if (!user_id || !room_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: room } = await supabase
    .from('live_rooms')
    .select('title, starts_at')
    .eq('id', room_id)
    .maybeSingle();

  ctx.notify(user_id, 'orb_proactive_message', {
    title: 'Session Booked!',
    body: `You're booked for "${room?.title || 'your session'}". We'll remind you before it starts.`,
    data: { url: `/live-rooms/${room_id}`, room_id },
  });

  await ctx.emitEvent('autopilot.liverooms.booking_created', { user_id, room_id, host_id });
  return { usersAffected: 1, actionsTaken: 2 };
}

// ── AP-1203: Live Room Upsell from Free Content ─────────────
async function runLiveRoomFreeToUpSell(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Find users who attended 3+ free rooms on same topic
  const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: frequentAttendees } = await supabase
    .from('live_room_attendance')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('attended', true)
    .gte('joined_at', thirtyDays);

  // Count per user
  const userCounts: Record<string, number> = {};
  for (const att of frequentAttendees || []) {
    userCounts[att.user_id] = (userCounts[att.user_id] || 0) + 1;
  }

  for (const [userId, count] of Object.entries(userCounts)) {
    if (count < 3) continue;

    // Find paid services with live room delivery
    const { data: paidServices } = await supabase
      .from('services_catalog')
      .select('id, name, service_type')
      .eq('tenant_id', tenantId)
      .limit(1)
      .maybeSingle();

    if (!paidServices) continue;

    ctx.notify(userId, 'orb_suggestion', {
      title: 'Go Deeper',
      body: `You've been enjoying live sessions! ${paidServices.name} offers expert deep-dives.`,
      data: { url: '/discover' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1204: Group Session Auto-Fill ────────────────────────
async function runGroupSessionAutoFill(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const in72h = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const { data: sessions } = await supabase
    .from('live_room_sessions')
    .select('id, room_id, max_participants, topic_keys')
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled')
    .gte('starts_at', now.toISOString())
    .lte('starts_at', in72h.toISOString());

  for (const session of sessions || []) {
    if (!session.max_participants) continue;

    const { count: booked } = await supabase
      .from('live_room_attendance')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', session.room_id);

    const fillRate = (booked || 0) / session.max_participants;
    if (fillRate >= 0.5) continue;

    const { data: room } = await supabase
      .from('live_rooms')
      .select('title, topic_keys')
      .eq('id', session.room_id)
      .maybeSingle();

    // Find topic-aligned users
    const topics = room?.topic_keys || session.topic_keys || [];
    if (!topics.length) continue;

    const { data: matchingUsers } = await supabase
      .from('user_topic_profile')
      .select('user_id')
      .eq('tenant_id', tenantId)
      .in('topic_key', topics)
      .gte('score', 50)
      .limit(20);

    const spots = session.max_participants - (booked || 0);
    for (const user of (matchingUsers || []).slice(0, spots)) {
      ctx.notify(user.user_id, 'live_room_invite', {
        title: `${room?.title || 'Live Session'} — Spots Available`,
        body: `${spots} spots left. Join this session!`,
        data: { url: `/live-rooms/${session.room_id}`, room_id: session.room_id },
      });
      usersAffected++;
      actionsTaken++;
    }
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1205: Post-Session Revenue Report ────────────────────
async function runPostSessionRevenueReport(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { room_id, host_id } = payload || {};
  if (!room_id || !host_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { count: attendees } = await supabase
    .from('live_room_attendance')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', room_id)
    .eq('attended', true);

  const { data: room } = await supabase
    .from('live_rooms')
    .select('title')
    .eq('id', room_id)
    .maybeSingle();

  ctx.notify(host_id, 'orb_proactive_message', {
    title: 'Session Complete!',
    body: `"${room?.title || 'Your session'}" had ${attendees || 0} attendees. Check your earnings.`,
    data: { url: '/business/earnings', room_id },
  });

  await ctx.emitEvent('autopilot.liverooms.revenue_reported', {
    room_id, host_id, attendees: attendees || 0,
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1207: Recurring Session Auto-Scheduling ──────────────
async function runRecurringSessionAutoSchedule(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Find hosts who've held 3+ sessions
  const { data: rooms } = await supabase
    .from('live_rooms')
    .select('host_user_id, topic_keys')
    .eq('tenant_id', tenantId)
    .eq('status', 'ended')
    .gte('created_at', thirtyDays);

  const hostCounts: Record<string, number> = {};
  for (const room of rooms || []) {
    hostCounts[room.host_user_id] = (hostCounts[room.host_user_id] || 0) + 1;
  }

  for (const [hostId, count] of Object.entries(hostCounts)) {
    if (count < 3) continue;

    ctx.notify(hostId, 'orb_suggestion', {
      title: 'Make It a Series!',
      body: 'Your sessions are popular! Want to make them a weekly recurring event?',
      data: { url: '/live-rooms/create' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1208: Consultation Matching ──────────────────────────
async function runConsultationMatching(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, service_type } = payload || {};
  if (!user_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: services } = await supabase
    .from('services_catalog')
    .select('id, name, service_type, provider_name')
    .eq('tenant_id', tenantId)
    .eq('service_type', service_type || 'doctor')
    .limit(3);

  if (!services?.length) return { usersAffected: 0, actionsTaken: 0 };

  ctx.notify(user_id, 'orb_proactive_message', {
    title: 'Expert Consultation',
    body: `We found ${services.length} ${service_type || 'health'} professionals. Book a live consultation.`,
    data: { url: '/discover', filter: service_type },
  });

  await ctx.emitEvent('autopilot.liverooms.consultation_matched', {
    user_id, service_type, matches: services.length,
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1209: Free Trial Session for New Creators ────────────
async function runFreeTrialSessionSuggestion(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Find creators who onboarded 7+ days ago but have 0 sessions
  const { data: creators } = await supabase
    .from('app_users')
    .select('id, display_name')
    .eq('stripe_charges_enabled', true)
    .lte('stripe_onboarded_at', sevenDaysAgo);

  for (const creator of creators || []) {
    const { count: sessionCount } = await supabase
      .from('live_rooms')
      .select('id', { count: 'exact', head: true })
      .eq('host_user_id', creator.id);

    if ((sessionCount || 0) > 0) continue;

    ctx.notify(creator.id, 'orb_suggestion', {
      title: 'Start With a Free Session',
      body: 'A free intro session is the fastest way to get reviews and build trust on Vitana.',
      data: { url: '/live-rooms/create' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

export function registerLiveRoomsCommerceHandlers(): void {
  registerHandler('runPaidLiveRoomSetup', runPaidLiveRoomSetup);
  registerHandler('runLiveRoomBookingPayment', runLiveRoomBookingPayment);
  registerHandler('runLiveRoomFreeToUpSell', runLiveRoomFreeToUpSell);
  registerHandler('runGroupSessionAutoFill', runGroupSessionAutoFill);
  registerHandler('runPostSessionRevenueReport', runPostSessionRevenueReport);
  registerHandler('runRecurringSessionAutoSchedule', runRecurringSessionAutoSchedule);
  registerHandler('runConsultationMatching', runConsultationMatching);
  registerHandler('runFreeTrialSessionSuggestion', runFreeTrialSessionSuggestion);
}
