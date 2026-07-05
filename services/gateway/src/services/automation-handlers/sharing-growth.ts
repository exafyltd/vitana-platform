/**
 * Sharing & Growth Handlers — AP-0400 series
 *
 * VTID: VTID-01250
 * Automations for viral sharing, WhatsApp distribution, referral tracking.
 */

import { randomUUID } from 'crypto';
import { AutomationContext, REWARD_TABLE } from '../../types/automations';
import { registerHandler } from '../automation-executor';

const APP_URL = process.env.APP_URL || 'https://vitana.app';
const VITANA_BOT_USER_ID = process.env.VITANA_BOT_USER_ID || '00000000-0000-0000-0000-000000000000';

// ── Short code generator ────────────────────────────────────
function generateShortCode(): string {
  return randomUUID().replace(/-/g, '').substring(0, 8);
}

// ── AP-0401: WhatsApp Event Share Link ──────────────────────
// Real schema: community_meetups/community_meetup_attendance were never
// deployed; global_community_events/global_event_participants is the real
// live events schema (start_time not starts_at, event_id not meetup_id,
// status='attending' not 'rsvp').
async function generateWhatsAppEventLink(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, event_id } = payload || {};
  if (!user_id || !event_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: event } = await supabase
    .from('global_community_events')
    .select('title, start_time')
    .eq('id', event_id)
    .maybeSingle();

  if (!event) return { usersAffected: 0, actionsTaken: 0 };

  const { count: rsvpCount } = await supabase
    .from('global_event_participants')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', event_id)
    .eq('status', 'attending');

  const shortCode = generateShortCode();
  await supabase.from('sharing_links').insert({
    tenant_id: tenantId,
    user_id,
    target_type: 'event',
    target_id: event_id,
    short_code: shortCode,
    utm_source: 'whatsapp',
    utm_medium: 'share',
    utm_campaign: 'event_share',
  });

  const deepLink = `${APP_URL}/event/${event_id}?utm_source=whatsapp&utm_medium=share&utm_campaign=event_share&ref=${user_id}&sc=${shortCode}`;
  const date = new Date(event.start_time).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const message = `Hey! Join me at "${event.title}" on ${date}\n${rsvpCount || 0} people are already going.\n\nJoin here: ${deepLink}`;
  const whatsappUri = `whatsapp://send?text=${encodeURIComponent(message)}`;

  await ctx.emitEvent('autopilot.sharing.whatsapp_event_shared', {
    user_id, event_id, short_code: shortCode,
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0402: WhatsApp Group Invite ──────────────────────────
// Real schema: community_groups/community_memberships were never deployed;
// global_community_groups/global_community_group_members is the real live
// (tenant-less) groups schema. category is a single text column, not an
// array of topic_keys.
async function generateWhatsAppGroupInvite(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, group_id } = payload || {};
  if (!user_id || !group_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: group } = await supabase
    .from('global_community_groups')
    .select('name, category')
    .eq('id', group_id)
    .maybeSingle();

  if (!group) return { usersAffected: 0, actionsTaken: 0 };

  const { count: memberCount } = await supabase
    .from('global_community_group_members')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', group_id);

  const shortCode = generateShortCode();
  await supabase.from('sharing_links').insert({
    tenant_id: tenantId,
    user_id,
    target_type: 'group',
    target_id: group_id,
    short_code: shortCode,
    utm_source: 'whatsapp',
    utm_medium: 'share',
    utm_campaign: 'group_invite',
  });

  const topic = (group.category || 'wellness').replace(/-/g, ' ');
  const deepLink = `${APP_URL}/group/${group_id}/join?ref=${user_id}&sc=${shortCode}&utm_source=whatsapp`;
  const message = `Join our "${group.name}" group on Vitana!\nWe discuss ${topic} — ${memberCount || 0} members and growing.\n\nJoin here: ${deepLink}`;

  await ctx.emitEvent('autopilot.sharing.whatsapp_group_invited', {
    user_id, group_id, short_code: shortCode,
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0404: "Invite a Friend" After Positive Experience ────
async function runInviteAfterPositive(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Generate referral link
  const shortCode = generateShortCode();
  await supabase.from('sharing_links').insert({
    tenant_id: tenantId,
    user_id: userId,
    target_type: 'profile',
    target_id: userId,
    short_code: shortCode,
    utm_source: 'vitana',
    utm_medium: 'referral',
    utm_campaign: 'invite_after_positive',
  });

  // Create referral record
  await supabase.from('referrals').insert({
    tenant_id: tenantId,
    referrer_id: userId,
    source: 'direct',
    utm_campaign: 'invite_after_positive',
    sharing_link_id: null, // will be linked when used
    status: 'created',
  });

  // Delay 30 min is handled by heartbeat interval; send immediately here
  ctx.notify(userId, 'orb_suggestion', {
    title: 'Enjoying Vitana?',
    body: 'Know someone who\'d love it? Invite them and earn 200 credits!',
    data: { url: '/invite', short_code: shortCode },
  });

  await ctx.emitEvent('autopilot.sharing.invite_prompted', { user_id: userId });
  return { usersAffected: 1, actionsTaken: 2 };
}

// ── AP-0405: Referral Tracking & Reward ─────────────────────
// Real schema: app_users' primary key is user_id, not id. credit_wallet()
// RPC does not exist live — increment_wallet_balance(p_user_id, p_currency_type,
// p_amount) does (writes to user_wallets, currency_type uppercased). It has
// no idempotency key, so this self-guards by only crediting when the
// referrals status-transition update actually affected a row (i.e. this is
// the first time this referral has been marked signed_up).
async function runReferralReward(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { referrer_id, referred_id, source } = payload || {};
  if (!referrer_id || !referred_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: updatedReferrals } = await supabase.from('referrals')
    .update({ referred_id, status: 'signed_up' })
    .eq('tenant_id', tenantId)
    .eq('referrer_id', referrer_id)
    .eq('status', 'created')
    .order('created_at', { ascending: false })
    .limit(1)
    .select('id');

  if (!updatedReferrals?.length) {
    // Already processed (or no matching referral) — don't double-credit.
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const { data: referred } = await supabase
    .from('app_users').select('display_name').eq('user_id', referred_id).maybeSingle();

  ctx.notify(referrer_id, 'orb_proactive_message', {
    title: 'Your Friend Joined!',
    body: `${referred?.display_name || 'Your friend'} just joined Vitana through your invite!`,
    data: { url: '/wallet' },
  });

  const rewardConfig = REWARD_TABLE['referral_completed'];

  await supabase.rpc('increment_wallet_balance', {
    p_user_id: referrer_id,
    p_currency_type: 'CREDITS',
    p_amount: rewardConfig.amount,
  });

  await ctx.emitEvent('autopilot.sharing.referral_completed', {
    referrer_id, referred_id, reward: rewardConfig.amount,
  });

  return { usersAffected: 2, actionsTaken: 3 };
}

// ── AP-0408: Event Countdown Share Prompt ───────────────────
// Real schema: global_community_events (no tenant_id — global across
// tenants) / global_event_participants (event_id, status='attending').
async function runEventCountdownSharePrompt(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const in46h = new Date(now.getTime() + 46 * 60 * 60 * 1000);

  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title')
    .gte('start_time', in46h.toISOString())
    .lte('start_time', in48h.toISOString());

  for (const event of events || []) {
    const { data: attendees, count } = await supabase
      .from('global_event_participants')
      .select('user_id', { count: 'exact' })
      .eq('event_id', event.id)
      .eq('status', 'attending');

    if ((count || 0) < 5) continue;

    for (const attendee of attendees || []) {
      ctx.notify(attendee.user_id, 'orb_suggestion', {
        title: `${event.title} is in 2 days!`,
        body: 'Help spread the word — share with friends who might enjoy it.',
        data: { url: `/community/events/${event.id}`, event_id: event.id },
      });
      usersAffected++;
      actionsTaken++;
    }
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0410: Viral Loop — Shared Link → New User Onboarding ─
// Real schema: relationship_edges is source_type/source_id/target_type/
// target_id/edge_type/metadata (jsonb, not stringified), unique key
// (tenant_id, source_type, source_id, target_type, target_id, edge_type).
// global_community_events/global_event_participants, not community_meetups.
async function runViralLoopOnboarding(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { referred_id, referrer_id, target_type, target_id } = payload || {};
  if (!referred_id || !referrer_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Auto-connect referrer and referred
  await supabase.from('relationship_edges').upsert({
    tenant_id: tenantId,
    source_type: 'person',
    source_id: referred_id,
    target_type: 'person',
    target_id: referrer_id,
    edge_type: 'connected',
    strength: 30,
    metadata: { origin: 'referral' },
  }, { onConflict: 'tenant_id,source_type,source_id,target_type,target_id,edge_type' });

  // If target is an event, auto-register.
  if (target_type === 'event' && target_id) {
    await supabase.from('global_event_participants').upsert({
      event_id: target_id,
      user_id: referred_id,
      status: 'attending',
    }, { onConflict: 'event_id,user_id' });
  }

  // Notify referrer
  ctx.notify(referrer_id, 'orb_proactive_message', {
    title: 'Someone Joined Through Your Share!',
    body: 'A new member joined Vitana through your shared link.',
    data: { url: '/wallet' },
  });

  await ctx.emitEvent('autopilot.sharing.viral_signup', {
    referrer_id, referred_id, target_type, target_id,
  });

  return { usersAffected: 2, actionsTaken: 3 };
}

// ── AP-0403: Social Media Event Card Generator ──────────────
// Registry originally specified an event trigger (meetup.created), but
// nothing in the gateway creates global_community_events — the frontend
// writes them directly via Supabase (same situation as AP-0204/AP-1403).
// Implemented as a heartbeat scan of recently-created events instead.
const EVENT_CARD_LOOKBACK_MINUTES = 30;
const EVENT_CARD_MAX_PER_RUN = 25;

async function runSocialMediaEventCardGenerator(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const since = new Date(Date.now() - EVENT_CARD_LOOKBACK_MINUTES * 60 * 1000).toISOString();

  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title, start_time, created_by, participant_count, slug')
    .not('created_by', 'is', null)
    .gte('created_at', since)
    .limit(200);

  let cardsGenerated = 0;
  for (const event of events || []) {
    if (cardsGenerated >= EVENT_CARD_MAX_PER_RUN) break;

    const { data: existingCard } = await supabase
      .from('sharing_links')
      .select('id')
      .eq('target_type', 'event')
      .eq('target_id', event.id)
      .eq('utm_campaign', 'event_social_card')
      .limit(1);
    if (existingCard && existingCard.length > 0) continue;

    const shortCode = generateShortCode();
    await supabase.from('sharing_links').insert({
      tenant_id: tenantId,
      user_id: event.created_by,
      target_type: 'event',
      target_id: event.id,
      short_code: shortCode,
      utm_source: 'social',
      utm_medium: 'share',
      utm_campaign: 'event_social_card',
    });

    const deepLink = `${APP_URL}/community/events/${event.slug || event.id}?utm_source=social&utm_medium=share&utm_campaign=event_social_card&sc=${shortCode}`;
    const date = new Date(event.start_time).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const cardCaption = `${event.title} — ${date}. ${event.participant_count || 0} going. Join us on Vitana!`;

    ctx.notify(event.created_by, 'orb_suggestion', {
      title: 'Your event card is ready to share 📣',
      body: `Post "${event.title}" to your socials and fill more seats.`,
      data: { url: `/community/events/${event.id}`, event_id: event.id, share_caption: cardCaption, share_link: deepLink },
    });

    usersAffected++;
    actionsTaken += 2;
    cardsGenerated++;
  }

  await ctx.emitEvent('autopilot.sharing.event_social_cards_generated', { cards_generated: cardsGenerated });
  return { usersAffected, actionsTaken };
}

// ── AP-0406: Auto-Post Community Highlights ─────────────────
// No live "global feed"/posts table exists to auto-post into (group_posts
// is per-group only). Implemented as a weekly broadcast highlighting the
// week's top group + top event.
const HIGHLIGHTS_WINDOW_DAYS = 7;

async function runAutoPostCommunityHighlights(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const weekAgo = new Date(Date.now() - HIGHLIGHTS_WINDOW_DAYS * 86_400_000).toISOString();

  const { data: newMemberships } = await supabase
    .from('global_community_group_members')
    .select('group_id')
    .gte('joined_at', weekAgo)
    .limit(5000);

  const groupCounts = new Map<string, number>();
  for (const m of newMemberships || []) groupCounts.set(m.group_id, (groupCounts.get(m.group_id) || 0) + 1);

  let topGroupId: string | null = null;
  let topGroupCount = 0;
  for (const [groupId, count] of groupCounts) {
    if (count > topGroupCount) { topGroupId = groupId; topGroupCount = count; }
  }

  let topGroupName: string | null = null;
  if (topGroupId) {
    const { data: g } = await supabase.from('global_community_groups').select('name').eq('id', topGroupId).maybeSingle();
    topGroupName = g?.name || null;
  }

  const in14d = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const { data: topEvent } = await supabase
    .from('global_community_events')
    .select('id, title, participant_count')
    .gte('start_time', new Date().toISOString())
    .lte('start_time', in14d)
    .order('participant_count', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!topGroupName && !topEvent) return { usersAffected: 0, actionsTaken: 0 };

  const highlightParts: string[] = [];
  if (topGroupName) highlightParts.push(`"${topGroupName}" grew by ${topGroupCount} member${topGroupCount === 1 ? '' : 's'} this week`);
  if (topEvent) highlightParts.push(`"${topEvent.title}" has ${topEvent.participant_count || 0} people going`);

  const shortCode = generateShortCode();
  await supabase.from('sharing_links').insert({
    tenant_id: tenantId,
    user_id: VITANA_BOT_USER_ID,
    target_type: topEvent ? 'event' : 'group',
    target_id: topEvent ? topEvent.id : topGroupId,
    short_code: shortCode,
    utm_source: 'vitana',
    utm_medium: 'digest',
    utm_campaign: 'community_highlights',
  });

  const users = await ctx.queryTargetUsers();
  for (const { user_id } of users) {
    ctx.notify(user_id, 'community_highlights', {
      title: 'This Week in Your Community 🌟',
      body: highlightParts.join(' · '),
      data: { url: topEvent ? `/community/events/${topEvent.id}` : `/community/groups/${topGroupId}`, short_code: shortCode },
    });
    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.sharing.community_highlights_posted', {
    top_group_id: topGroupId, top_event_id: topEvent?.id || null, users_notified: usersAffected,
  });
  return { usersAffected, actionsTaken };
}

// ── AP-0407: User Profile Share Card ─────────────────────────
// Manual trigger (user taps "Share my profile").
async function runUserProfileShareCard(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: user } = await supabase
    .from('app_users').select('display_name').eq('user_id', userId).maybeSingle();
  if (!user) return { usersAffected: 0, actionsTaken: 0 };

  const { count: interestCount } = await supabase
    .from('user_interests').select('id', { count: 'exact', head: true }).eq('user_id', userId);

  const { count: connectionCount } = await supabase
    .from('relationship_edges').select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('source_type', 'person').eq('source_id', userId).eq('target_type', 'person');

  const shortCode = generateShortCode();
  await supabase.from('sharing_links').insert({
    tenant_id: tenantId, user_id: userId, target_type: 'profile', target_id: userId,
    short_code: shortCode, utm_source: 'social', utm_medium: 'share', utm_campaign: 'profile_share_card',
  });

  const deepLink = `${APP_URL}/u/${userId}?utm_source=social&utm_medium=share&utm_campaign=profile_share_card&sc=${shortCode}`;
  const bodyParts: string[] = [];
  if (connectionCount) bodyParts.push(`${connectionCount} connections`);
  if (interestCount) bodyParts.push(`${interestCount} interests`);

  ctx.notify(userId, 'orb_suggestion', {
    title: 'Your share card is ready',
    body: `${user.display_name || 'Your'} profile card${bodyParts.length ? ` — ${bodyParts.join(', ')}` : ''} is ready to share.`,
    data: { url: '/profile/share', share_link: deepLink, short_code: shortCode },
  });

  await ctx.emitEvent('autopilot.sharing.profile_card_generated', { user_id: userId, short_code: shortCode });
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0409: "Your Week on Vitana" Shareable Recap ──────────
const RECAP_WINDOW_DAYS = 7;
const RECAP_MAX_USERS_PER_RUN = 2000;

async function runWeeklyRecapShare(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const weekAgo = new Date(Date.now() - RECAP_WINDOW_DAYS * 86_400_000).toISOString();
  const users = (await ctx.queryTargetUsers()).slice(0, RECAP_MAX_USERS_PER_RUN);

  for (const { user_id } of users) {
    const [matchesRes, messagesRes, eventsRes, groupsRes] = await Promise.all([
      supabase.from('daily_matches').select('id', { count: 'exact', head: true })
        .eq('user_id', user_id).gte('created_at', weekAgo).not('viewed_at', 'is', null),
      supabase.from('chat_messages').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('sender_id', user_id).gte('created_at', weekAgo),
      supabase.from('global_event_participants').select('id', { count: 'exact', head: true })
        .eq('user_id', user_id).gte('registered_at', weekAgo),
      supabase.from('global_community_group_members').select('id', { count: 'exact', head: true })
        .eq('user_id', user_id).gte('joined_at', weekAgo),
    ]);
    const matchesViewed = matchesRes.count;
    const messagesSent = messagesRes.count;
    const eventsJoined = eventsRes.count;
    const groupsJoined = groupsRes.count;

    const total = (matchesViewed || 0) + (messagesSent || 0) + (eventsJoined || 0) + (groupsJoined || 0);
    if (total === 0) continue;

    const shortCode = generateShortCode();
    await supabase.from('sharing_links').insert({
      tenant_id: tenantId, user_id, target_type: 'profile', target_id: user_id,
      short_code: shortCode, utm_source: 'social', utm_medium: 'share', utm_campaign: 'weekly_recap',
    });

    const highlights: string[] = [];
    if (matchesViewed) highlights.push(`${matchesViewed} matches`);
    if (messagesSent) highlights.push(`${messagesSent} messages`);
    if (eventsJoined) highlights.push(`${eventsJoined} events`);
    if (groupsJoined) highlights.push(`${groupsJoined} new groups`);

    ctx.notify(user_id, 'weekly_recap_ready', {
      title: 'Your Week on Vitana 📊',
      body: `${highlights.join(', ')}. Share your recap!`,
      data: {
        url: '/profile/recap', short_code: shortCode,
        matches_viewed: String(matchesViewed || 0), messages_sent: String(messagesSent || 0),
        events_joined: String(eventsJoined || 0), groups_joined: String(groupsJoined || 0),
      },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.sharing.weekly_recap_sent', { users: usersAffected });
  return { usersAffected, actionsTaken };
}

// ── AP-0411: "Bring Your Circle" Smart Invite Wave ──────────
// Same live topic as AP-0404 (match.feedback.like). Resolves user_id itself
// from daily_matches via match_id rather than trusting payload.user_id,
// which the live dispatch site (match-feedback.ts) never provides.
const CIRCLE_WAVE_COOLDOWN_DAYS = 14;

async function runBringYourCircleInviteWave(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const matchId = payload?.match_id;
  if (!matchId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: match } = await supabase.from('daily_matches').select('user_id').eq('id', matchId).maybeSingle();
  if (!match?.user_id) return { usersAffected: 0, actionsTaken: 0 };
  const userId = match.user_id;

  const cooldownCutoff = new Date(Date.now() - CIRCLE_WAVE_COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data: recentWave } = await supabase
    .from('user_notifications').select('id')
    .eq('user_id', userId).contains('data', { automation_id: 'AP-0411' })
    .gte('created_at', cooldownCutoff).limit(1);
  if (recentWave && recentWave.length > 0) return { usersAffected: 0, actionsTaken: 0 };

  const shortCode = generateShortCode();
  await supabase.from('sharing_links').insert({
    tenant_id: tenantId, user_id: userId, target_type: 'profile', target_id: userId,
    short_code: shortCode, utm_source: 'vitana', utm_medium: 'referral', utm_campaign: 'circle_invite_wave',
  });

  const rewardConfig = REWARD_TABLE['referral_completed'];
  const deepLink = `${APP_URL}/invite?ref=${userId}&sc=${shortCode}&utm_campaign=circle_invite_wave`;

  ctx.notify(userId, 'orb_suggestion', {
    title: 'Bring your circle to Vitana 🎉',
    body: `You're on a roll — invite a few friends who'd vibe with your matches. ${rewardConfig.amount} credits per friend who joins.`,
    data: { url: '/invite', short_code: shortCode, share_link: deepLink, automation_id: 'AP-0411' },
  });

  await ctx.emitEvent('autopilot.sharing.circle_invite_wave_sent', { user_id: userId, short_code: shortCode });
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0412: "Progress to Story" Shareable Win ──────────────
// user.milestone.reached is never actually dispatched today — milestone
// events land straight in oasis_events without going through dispatchEvent
// (see milestone-service.ts). Implemented assuming payload shape
// { user_id, milestone, reward } for when that wiring is added.
async function runProgressToStoryShare(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id: userId, milestone, reward } = payload || {};
  if (!userId || !milestone) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const shortCode = generateShortCode();
  await supabase.from('sharing_links').insert({
    tenant_id: tenantId, user_id: userId, target_type: 'profile', target_id: userId,
    short_code: shortCode, utm_source: 'social', utm_medium: 'share', utm_campaign: 'milestone_story',
  });

  const deepLink = `${APP_URL}/u/${userId}/milestones/${milestone}?utm_source=social&utm_medium=share&utm_campaign=milestone_story&sc=${shortCode}`;
  const rewardLine = reward ? ` (+${reward} credits)` : '';

  ctx.notify(userId, 'orb_suggestion', {
    title: 'Share your win! 🏆',
    body: `You just hit a milestone${rewardLine}. Turn it into a story to share.`,
    data: { url: `/profile/milestones/${milestone}`, short_code: shortCode, share_link: deepLink, milestone },
  });

  await ctx.emitEvent('autopilot.sharing.milestone_story_shared', { user_id: userId, milestone, short_code: shortCode });
  return { usersAffected: 1, actionsTaken: 1 };
}

export function registerSharingGrowthHandlers(): void {
  registerHandler('generateWhatsAppEventLink', generateWhatsAppEventLink);
  registerHandler('generateWhatsAppGroupInvite', generateWhatsAppGroupInvite);
  registerHandler('runInviteAfterPositive', runInviteAfterPositive);
  registerHandler('runReferralReward', runReferralReward);
  registerHandler('runEventCountdownSharePrompt', runEventCountdownSharePrompt);
  registerHandler('runViralLoopOnboarding', runViralLoopOnboarding);
  registerHandler('runSocialMediaEventCardGenerator', runSocialMediaEventCardGenerator);
  registerHandler('runAutoPostCommunityHighlights', runAutoPostCommunityHighlights);
  registerHandler('runUserProfileShareCard', runUserProfileShareCard);
  registerHandler('runWeeklyRecapShare', runWeeklyRecapShare);
  registerHandler('runBringYourCircleInviteWave', runBringYourCircleInviteWave);
  registerHandler('runProgressToStoryShare', runProgressToStoryShare);
}
