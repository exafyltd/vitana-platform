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

  // live_room_attendance has no "attended" boolean — a row's existence IS
  // the attendance signal (VTID-01250 schema-drift cleanup).
  const { data: frequentAttendees } = await supabase
    .from('live_room_attendance')
    .select('user_id')
    .eq('tenant_id', tenantId)
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
      .eq('live_room_id', session.room_id);

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

    // user_topic_profile doesn't exist; user_interests is the real table.
    const { data: matchingUsers } = await supabase
      .from('user_interests')
      .select('user_id')
      .in('interest', topics)
      .gte('confidence_score', 50)
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
    .eq('live_room_id', room_id);

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

  // Find creators who onboarded 7+ days ago but have 0 sessions.
  // app_users' primary key is user_id, not id.
  const { data: creators } = await supabase
    .from('app_users')
    .select('user_id, display_name')
    .eq('stripe_charges_enabled', true)
    .lte('stripe_onboarded_at', sevenDaysAgo);

  for (const creator of creators || []) {
    const { count: sessionCount } = await supabase
      .from('live_rooms')
      .select('id', { count: 'exact', head: true })
      .eq('host_user_id', creator.user_id);

    if ((sessionCount || 0) > 0) continue;

    ctx.notify(creator.user_id, 'orb_suggestion', {
      title: 'Start With a Free Session',
      body: 'A free intro session is the fastest way to get reviews and build trust on Vitana.',
      data: { url: '/live-rooms/create' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1206: Session Highlight Clips for Marketing ──────────
// GAP: nothing in the gateway dispatches 'live_room.highlights.ready' (no
// emitter anywhere), and there is no video-clip-rendering pipeline in this
// codebase at all (no clip_url/video_url column, no render service). The
// only live table in this neighborhood is live_highlights (VTID-01090):
// id, tenant_id, live_room_id, created_by_user_id, highlight_type
// ['quote'|'moment'|'action_item'|'insight'], text, metadata — TEXT
// moments, not video clips (0 rows live today). Implemented as a
// best-effort text-highlights digest so this does *something* useful;
// this is NOT the video "clip" feature the name implies. Registry status
// stays PLANNED — wiring a handler to a never-fired event doesn't make the
// automation actually run.
async function runSessionHighlightClipsForMarketing(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const roomId = payload?.room_id || payload?.live_room_id;
  if (!roomId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: room } = await supabase
    .from('live_rooms')
    .select('title, host_user_id')
    .eq('id', roomId)
    .maybeSingle();
  if (!room?.host_user_id) return { usersAffected: 0, actionsTaken: 0 };

  const { data: highlights } = await supabase
    .from('live_highlights')
    .select('highlight_type, text')
    .eq('tenant_id', tenantId)
    .eq('live_room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (!highlights?.length) return { usersAffected: 0, actionsTaken: 0 };

  const preview = highlights.map((h: any) => h.text).slice(0, 2).join(' · ');
  const clipUrl = payload?.clip_url;

  ctx.notify(room.host_user_id, 'orb_proactive_message', {
    title: `Highlights ready for "${room.title || 'your session'}"`,
    body: clipUrl
      ? 'Your session highlight clip is ready to share.'
      : `${highlights.length} highlight${highlights.length === 1 ? '' : 's'} captured: ${preview}. Share them to promote your next session.`,
    data: {
      url: `/business/live-rooms/${roomId}`,
      room_id: roomId,
      clip_url: clipUrl || '',
      automation_id: 'AP-1206',
    },
  });

  await ctx.emitEvent('autopilot.liverooms.highlights_marketing_sent', {
    room_id: roomId,
    host_id: room.host_user_id,
    highlight_count: highlights.length,
    has_clip: Boolean(clipUrl),
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1210: Live Room Revenue Optimization Tips ────────────
// service_payments revenue is keyed by payee_vitana_id (TEXT, joins
// app_users.vitana_id), not a uuid user_id.
const REVENUE_TIP_WINDOW_DAYS = 30;
const REVENUE_TIP_MIN_SESSIONS = 2;

async function runLiveRoomRevenueOptimizationTips(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const windowStart = new Date(Date.now() - REVENUE_TIP_WINDOW_DAYS * 86_400_000).toISOString();

  const { data: rooms } = await supabase
    .from('live_rooms')
    .select('id, host_user_id, price_cents, capacity')
    .eq('tenant_id', tenantId)
    .not('host_user_id', 'is', null)
    .gte('created_at', windowStart)
    .limit(2000);

  const roomsByHost = new Map<string, any[]>();
  for (const room of rooms || []) {
    const list = roomsByHost.get(room.host_user_id) || [];
    list.push(room);
    roomsByHost.set(room.host_user_id, list);
  }

  const { data: hostUsers } = await supabase
    .from('app_users')
    .select('user_id, vitana_id')
    .in('user_id', [...roomsByHost.keys()]);
  const vitanaIdByHost = new Map((hostUsers || []).map((u: any) => [u.user_id, u.vitana_id]));

  for (const [hostId, hostRooms] of roomsByHost) {
    if (hostRooms.length < REVENUE_TIP_MIN_SESSIONS) continue;

    const roomIds = hostRooms.map((r: any) => r.id);
    const { count: attendeeCount } = await supabase
      .from('live_room_attendance')
      .select('id', { count: 'exact', head: true })
      .in('live_room_id', roomIds);

    const totalCapacity = hostRooms.reduce((s: number, r: any) => s + (r.capacity || 0), 0);
    const fillRate = totalCapacity > 0 ? (attendeeCount || 0) / totalCapacity : null;

    const vitanaId = vitanaIdByHost.get(hostId);
    let revenueCents = 0;
    if (vitanaId) {
      const { data: payments } = await supabase
        .from('service_payments')
        .select('amount_cents')
        .eq('payee_vitana_id', vitanaId)
        .in('state', ['captured', 'released'])
        .gte('created_at', windowStart);
      revenueCents = (payments || []).reduce((s: number, p: any) => s + (p.amount_cents || 0), 0);
    }

    const pricedRooms = hostRooms.filter((r: any) => r.price_cents != null);
    let tip: string;
    if (pricedRooms.length === 0) {
      tip = 'None of your sessions have a price set — add one to start earning from live rooms.';
    } else if (fillRate !== null && fillRate >= 0.85) {
      tip = "You're consistently selling out — try raising your price by 10-15% for the next session.";
    } else if (fillRate !== null && fillRate < 0.25) {
      tip = 'Low fill rate — try a lower price or a more convenient time slot.';
    } else {
      tip = 'Your pricing looks balanced for current demand.';
    }

    ctx.notify(hostId, 'orb_suggestion', {
      title: 'Revenue Optimization Tip',
      body: revenueCents > 0
        ? `You earned €${(revenueCents / 100).toFixed(2)} from live rooms this month. ${tip}`
        : tip,
      data: { url: '/business/earnings', automation_id: 'AP-1210' },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.liverooms.revenue_tips_sent', { creators: usersAffected });
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
  registerHandler('runSessionHighlightClipsForMarketing', runSessionHighlightClipsForMarketing);
  registerHandler('runLiveRoomRevenueOptimizationTips', runLiveRoomRevenueOptimizationTips);
}
