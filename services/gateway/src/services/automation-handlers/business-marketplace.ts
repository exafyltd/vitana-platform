/**
 * Business Hub & Marketplace Handlers — AP-1100 series
 *
 * VTID: VTID-01250
 * Automations for shop setup, product/service distribution, and Discover personalization.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-1101: Service Listing Publication & Distribution ──────
// Real schema: services_catalog (VTID-01092) was never deployed. live_rooms
// (category text + topic_keys array) is the only live "creator-listed,
// bookable session" table — the same substitute already used for AP-1108/
// AP-1109/business-opportunity.ts. user_topic_profile was never deployed;
// user_interests (interest, confidence_score 0-1 scale) is real. The
// relationship_edges upsert is dropped — its edge_type CHECK constraint
// only allows attendee/member/host/coattendance/organizer/connected/
// suggested, none of which fit "saved a listing", and inventing a new
// enum value needs its own migration decision, not a schema-drift fix.
async function runServiceListingDistribution(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { service_id, user_id } = payload || {};
  if (!service_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: room } = await supabase
    .from('live_rooms')
    .select('title, category, topic_keys, host_user_id')
    .eq('id', service_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!room) return { usersAffected: 0, actionsTaken: 0 };

  const topicKeys = [room.category, ...(room.topic_keys || [])].filter(Boolean).map((t: string) => t.toLowerCase());
  if (!topicKeys.length) return { usersAffected: 0, actionsTaken: 1 };

  const { data: matchingUsers } = await supabase
    .from('user_interests')
    .select('user_id, interest')
    .in('interest', topicKeys)
    .gte('confidence_score', 0.6)
    .order('confidence_score', { ascending: false })
    .limit(50);

  let usersAffected = 0;
  const uniqueUsers = new Set<string>();
  for (const match of matchingUsers || []) {
    if (match.user_id === (user_id || room.host_user_id)) continue; // don't notify creator
    if (uniqueUsers.has(match.user_id)) continue;
    uniqueUsers.add(match.user_id);

    ctx.notify(match.user_id, 'orb_suggestion', {
      title: 'New Listing Matches Your Interests',
      body: `"${room.title}" was just listed — matches your interest in ${match.interest}.`,
      data: { url: `/live/rooms/${service_id}`, service_id },
    });

    usersAffected++;
  }

  await ctx.emitEvent('autopilot.marketplace.service_listed', {
    service_id, matched_users: usersAffected,
  });

  return { usersAffected, actionsTaken: usersAffected + 1 };
}

// ── AP-1102: Product Listing & AI-Picks Matching ────────────
// Real schema: products_catalog (VTID-01092) was never deployed —
// products (title, category, topic_keys array, is_active) is the live
// global catalog. recommendations has category/title/body, not a `pillar`
// column, and category is a single text value, not an array to overlap
// against.
const PRODUCT_MATCH_MAX_USERS = 50;

async function runProductAiPicksMatching(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { product_id, user_id } = payload || {};
  if (!product_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: product } = await supabase
    .from('products')
    .select('title, category, topic_keys')
    .eq('id', product_id)
    .eq('is_active', true)
    .maybeSingle();

  if (!product) return { usersAffected: 0, actionsTaken: 0 };

  const topicKeys = [product.category, ...(product.topic_keys || [])].filter(Boolean);
  if (!topicKeys.length) return { usersAffected: 0, actionsTaken: 1 };

  // Find users whose recent recommendations align with this product's topics
  const { data: matchingRecs } = await supabase
    .from('recommendations')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .in('category', topicKeys)
    .limit(PRODUCT_MATCH_MAX_USERS);

  let usersAffected = 0;
  const uniqueUsers = new Set<string>();
  for (const rec of matchingRecs || []) {
    if (rec.user_id === user_id) continue;
    if (uniqueUsers.has(rec.user_id)) continue;
    uniqueUsers.add(rec.user_id);

    ctx.notify(rec.user_id, 'orb_suggestion', {
      title: 'New Pick For You',
      body: `"${product.title}" matches recommendations your ORB already made for you.`,
      data: { url: '/discover', product_id },
    });

    usersAffected++;
  }

  await ctx.emitEvent('autopilot.marketplace.product_listed', {
    product_id, matched_users: usersAffected,
  });

  return { usersAffected, actionsTaken: usersAffected + 1 };
}

// ── AP-1103: Discover Section Personalization ───────────────
async function runDiscoverPersonalization(ctx: AutomationContext) {
  ctx.log('Running Discover personalization refresh (delegates to offers API)');
  await ctx.emitEvent('autopilot.marketplace.discover_personalized', {});
  return { usersAffected: 0, actionsTaken: 1 };
}

// ── AP-1104: Client-Service Matching ────────────────────────
// Real schema: services_catalog (VTID-01092) was never deployed —
// live_rooms.category is the closest live analog to a "service type".
// user_offers_memory (interest-tracking) was never deployed either; no
// substitute exists for that specific "viewed" tracking, so it's dropped
// rather than invented — the notification itself is the real behavior.
async function runClientServiceMatching(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, service_type } = payload || {};
  if (!user_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: rooms } = await supabase
    .from('live_rooms')
    .select('id, title, category, host_user_id')
    .eq('tenant_id', tenantId)
    .eq('category', service_type || 'coach')
    .eq('status', 'scheduled')
    .limit(3);

  if (!rooms?.length) return { usersAffected: 0, actionsTaken: 0 };

  ctx.notify(user_id, 'orb_suggestion', {
    title: 'Matches Found',
    body: `Found ${rooms.length} ${service_type || 'coach'} session${rooms.length === 1 ? '' : 's'} that might fit what you're looking for.`,
    data: { url: '/discover', filter: service_type || 'coach' },
  });

  await ctx.emitEvent('autopilot.marketplace.client_matched', { user_id, matches: rooms.length });
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1105: Post-Service Outcome Tracking ──────────────────
// Real schema: user_offers_memory/usage_outcomes (VTID-01092) were never
// deployed. live_room_attendance (a row's existence IS the attendance
// signal, per AP-1203/1204/1205's fix earlier this session) is the real
// "did this user use a service" table. Cooldown for "already asked" uses
// the same user_notifications contains-data pattern used throughout this
// session rather than a nonexistent usage_outcomes table.
const OUTCOME_TRACKING_MAX_PER_RUN = 50;

async function runPostServiceOutcomeTracking(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recentAttendance } = await supabase
    .from('live_room_attendance')
    .select('user_id, live_room_id')
    .gte('joined_at', eightDaysAgo)
    .lte('joined_at', sevenDaysAgo)
    .limit(OUTCOME_TRACKING_MAX_PER_RUN);

  for (const attendance of recentAttendance || []) {
    const { data: alreadyAsked } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', attendance.user_id)
      .contains('data', { automation_id: 'AP-1105', live_room_id: attendance.live_room_id })
      .limit(1);
    if (alreadyAsked && alreadyAsked.length > 0) continue;

    ctx.notify(attendance.user_id, 'orb_proactive_message', {
      title: 'How Was Your Experience?',
      body: 'Tell us about your recent session — your feedback helps others.',
      data: { url: '/discover', live_room_id: attendance.live_room_id, automation_id: 'AP-1105' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1106: Shop Setup Wizard ──────────────────────────────
async function runShopSetupWizard(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  ctx.notify(userId, 'orb_proactive_message', {
    title: 'Welcome to Vitana Business!',
    body: 'Let\'s get your shop set up. Start by creating your first service or product listing.',
    data: { url: '/business/setup' },
  });

  await ctx.emitEvent('autopilot.marketplace.shop_setup_started', { user_id: userId });
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1107: Product Review Follow-Up ───────────────────────
// Real schema: user_offers_memory/products_catalog (VTID-01092) were never
// deployed. product_orders (purchased_at, real user_id/tenant_id) + products
// (title) are the live tables for "did this user buy a product".
const REVIEW_FOLLOWUP_MAX_PER_RUN = 50;

async function runProductReviewFollowUp(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

  const { data: orders } = await supabase
    .from('product_orders')
    .select('user_id, product_id')
    .eq('tenant_id', tenantId)
    .eq('state', 'completed')
    .gte('purchased_at', fifteenDaysAgo)
    .lte('purchased_at', fourteenDaysAgo)
    .limit(REVIEW_FOLLOWUP_MAX_PER_RUN);

  for (const order of orders || []) {
    const { data: product } = await supabase
      .from('products')
      .select('title')
      .eq('id', order.product_id)
      .maybeSingle();

    ctx.notify(order.user_id, 'orb_proactive_message', {
      title: 'How Is It Working?',
      body: `How is ${product?.title || 'your product'} working for you? A review helps other members.`,
      data: { url: '/discover', product_id: order.product_id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1110: Cross-Sell Service to Product Buyers ───────────
// Real schema: products_catalog/services_catalog (VTID-01092) were never
// deployed. products (topic_keys array) and live_rooms (topic_keys array)
// are the live substitutes.
async function runCrossSellServiceToProductBuyers(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, product_id } = payload || {};
  if (!user_id || !product_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: product } = await supabase
    .from('products')
    .select('topic_keys')
    .eq('id', product_id)
    .maybeSingle();

  if (!product?.topic_keys?.length) return { usersAffected: 0, actionsTaken: 0 };

  const { data: room } = await supabase
    .from('live_rooms')
    .select('id, category')
    .eq('tenant_id', tenantId)
    .overlaps('topic_keys', product.topic_keys)
    .limit(1)
    .maybeSingle();

  if (!room) return { usersAffected: 0, actionsTaken: 0 };

  // Don't suggest immediately — wait 3 days (tracked by heartbeat)
  ctx.notify(user_id, 'orb_suggestion', {
    title: 'Get More From Your Purchase',
    body: `A ${room.category || 'session'} can help you optimize your results. Check Discover.`,
    data: { url: '/discover', filter: room.category },
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1108: Creator Analytics & Growth Tips ────────────────
// Real schema: services_catalog/products_catalog (VTID-01092) were never
// deployed — there is no live "creator listing" table (AP-1101/1102/1104/
// 1105/1107/1110 above were fixed against the live_rooms/products/
// product_orders/live_room_attendance substitutes instead). The only live
// signal for creator performance here is live_rooms (host_user_id,
// price_cents, capacity) + live_room_attendance (live_room_id — a row's
// existence IS attendance, no separate boolean) + service_payments
// (payee_vitana_id is TEXT, joins app_users.vitana_id, NOT a uuid user_id).
const CREATOR_ANALYTICS_WINDOW_DAYS = 7;

async function runCreatorAnalyticsGrowthTips(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const windowStart = new Date(Date.now() - CREATOR_ANALYTICS_WINDOW_DAYS * 86_400_000).toISOString();

  const { data: rooms } = await supabase
    .from('live_rooms')
    .select('id, host_user_id, price_cents, capacity, created_at')
    .eq('tenant_id', tenantId)
    .not('host_user_id', 'is', null)
    .gte('created_at', windowStart)
    .limit(1000);

  const roomsByHost = new Map<string, Array<{ id: string; price_cents: number | null; capacity: number | null }>>();
  for (const room of rooms || []) {
    const list = roomsByHost.get(room.host_user_id) || [];
    list.push({ id: room.id, price_cents: room.price_cents, capacity: room.capacity });
    roomsByHost.set(room.host_user_id, list);
  }
  if (roomsByHost.size === 0) return { usersAffected: 0, actionsTaken: 0 };

  const { data: hostUsers } = await supabase
    .from('app_users')
    .select('user_id, vitana_id')
    .in('user_id', [...roomsByHost.keys()]);
  const vitanaIdByHost = new Map((hostUsers || []).map((u: any) => [u.user_id, u.vitana_id]));

  for (const [hostId, hostRooms] of roomsByHost) {
    const roomIds = hostRooms.map((r) => r.id);

    const { count: attendeeCount } = await supabase
      .from('live_room_attendance')
      .select('id', { count: 'exact', head: true })
      .in('live_room_id', roomIds)
      .gte('joined_at', windowStart);

    const vitanaId = vitanaIdByHost.get(hostId);
    let revenueCents = 0;
    if (vitanaId) {
      const { data: payments } = await supabase
        .from('service_payments')
        .select('amount_cents')
        .eq('payee_vitana_id', vitanaId)
        .in('state', ['captured', 'released'])
        .gte('created_at', windowStart);
      revenueCents = (payments || []).reduce((sum: number, p: any) => sum + (p.amount_cents || 0), 0);
    }

    const avgCapacity = hostRooms.reduce((s, r) => s + (r.capacity || 0), 0) / hostRooms.length;
    const fillRate = avgCapacity > 0 ? (attendeeCount || 0) / (hostRooms.length * avgCapacity) : null;

    let tip = 'Post a session recap to keep momentum going.';
    if (fillRate !== null && fillRate < 0.3) {
      tip = 'Fill rate is low — try sharing your session in a group chat 24h before it starts.';
    } else if (fillRate !== null && fillRate >= 0.8) {
      tip = "You're consistently near capacity — consider adding a second weekly slot.";
    }

    ctx.notify(hostId, 'orb_proactive_message', {
      title: 'Your Weekly Creator Report',
      body: `${hostRooms.length} session${hostRooms.length === 1 ? '' : 's'}, ${attendeeCount || 0} attendee${(attendeeCount || 0) === 1 ? '' : 's'}${revenueCents > 0 ? `, €${(revenueCents / 100).toFixed(2)} earned` : ''}. ${tip}`,
      data: { url: '/business/analytics', automation_id: 'AP-1108' },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.marketplace.creator_analytics_sent', { creators: usersAffected });
  return { usersAffected, actionsTaken };
}

// ── AP-1109: Seasonal & Trending Recommendations for Creators ──
// live_rooms.category/topic_keys are the only live categorical signals for
// creator content (both currently near-100% NULL in prod — no fix needed,
// just data-thin until rooms carry that data).
const TRENDING_WINDOW_DAYS = 30;
const TRENDING_MIN_SESSIONS = 3;
const TRENDING_MAX_CREATORS_NOTIFIED = 200;

async function runSeasonalTrendingRecommendations(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const windowStart = new Date(Date.now() - TRENDING_WINDOW_DAYS * 86_400_000).toISOString();

  const { data: rooms } = await supabase
    .from('live_rooms')
    .select('category, topic_keys')
    .eq('tenant_id', tenantId)
    .gte('created_at', windowStart)
    .limit(5000);

  const countByTopic = new Map<string, number>();
  for (const room of rooms || []) {
    const keys = [room.category, ...(room.topic_keys || [])].filter(Boolean);
    for (const key of keys) {
      countByTopic.set(key, (countByTopic.get(key) || 0) + 1);
    }
  }

  const trending = [...countByTopic.entries()]
    .filter(([, count]) => count >= TRENDING_MIN_SESSIONS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([topic]) => topic);
  if (trending.length === 0) return { usersAffected: 0, actionsTaken: 0 };

  const { data: hostRows } = await supabase
    .from('live_rooms')
    .select('host_user_id')
    .eq('tenant_id', tenantId)
    .not('host_user_id', 'is', null)
    .limit(5000);
  const hostIds: string[] = [...new Set<string>((hostRows || []).map((r: any) => r.host_user_id))].slice(0, TRENDING_MAX_CREATORS_NOTIFIED);

  const trendingLabel = trending.map((t) => t.replace(/-/g, ' ')).join(', ');
  for (const hostId of hostIds) {
    ctx.notify(hostId, 'orb_suggestion', {
      title: 'Trending This Month',
      body: `Members are booking ${trendingLabel} sessions. Consider offering one.`,
      data: { url: '/business/setup', automation_id: 'AP-1109' },
    });
    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.marketplace.trending_recommendations_sent', { trending, creators_notified: usersAffected });
  return { usersAffected, actionsTaken };
}

export function registerBusinessMarketplaceHandlers(): void {
  registerHandler('runServiceListingDistribution', runServiceListingDistribution);
  registerHandler('runProductAiPicksMatching', runProductAiPicksMatching);
  registerHandler('runDiscoverPersonalization', runDiscoverPersonalization);
  registerHandler('runClientServiceMatching', runClientServiceMatching);
  registerHandler('runPostServiceOutcomeTracking', runPostServiceOutcomeTracking);
  registerHandler('runShopSetupWizard', runShopSetupWizard);
  registerHandler('runProductReviewFollowUp', runProductReviewFollowUp);
  registerHandler('runCrossSellServiceToProductBuyers', runCrossSellServiceToProductBuyers);
  registerHandler('runCreatorAnalyticsGrowthTips', runCreatorAnalyticsGrowthTips);
  registerHandler('runSeasonalTrendingRecommendations', runSeasonalTrendingRecommendations);
}
