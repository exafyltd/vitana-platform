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

// ── Short code generator ────────────────────────────────────
function generateShortCode(): string {
  return randomUUID().replace(/-/g, '').substring(0, 8);
}

// ── AP-0401: WhatsApp Event Share Link ──────────────────────
async function generateWhatsAppEventLink(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, event_id } = payload || {};
  if (!user_id || !event_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Get event details
  const { data: event } = await supabase
    .from('community_meetups')
    .select('title, starts_at')
    .eq('id', event_id)
    .maybeSingle();

  if (!event) return { usersAffected: 0, actionsTaken: 0 };

  // Get attendee count
  const { count: rsvpCount } = await supabase
    .from('community_meetup_attendance')
    .select('id', { count: 'exact', head: true })
    .eq('meetup_id', event_id)
    .eq('status', 'rsvp');

  // Create sharing link
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
  const date = new Date(event.starts_at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const message = `Hey! Join me at "${event.title}" on ${date}\n${rsvpCount || 0} people are already going.\n\nJoin here: ${deepLink}`;
  const whatsappUri = `whatsapp://send?text=${encodeURIComponent(message)}`;

  await ctx.emitEvent('autopilot.sharing.whatsapp_event_shared', {
    user_id, event_id, short_code: shortCode,
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0402: WhatsApp Group Invite ──────────────────────────
async function generateWhatsAppGroupInvite(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, group_id } = payload || {};
  if (!user_id || !group_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: group } = await supabase
    .from('community_groups')
    .select('name, topic_keys')
    .eq('id', group_id)
    .maybeSingle();

  if (!group) return { usersAffected: 0, actionsTaken: 0 };

  const { count: memberCount } = await supabase
    .from('community_memberships')
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

  const topic = (group.topic_keys?.[0] || 'wellness').replace(/-/g, ' ');
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
async function runReferralReward(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { referrer_id, referred_id, source } = payload || {};
  if (!referrer_id || !referred_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Update referral record
  await supabase.from('referrals')
    .update({ referred_id, status: 'signed_up' })
    .eq('tenant_id', tenantId)
    .eq('referrer_id', referrer_id)
    .eq('status', 'created')
    .order('created_at', { ascending: false })
    .limit(1);

  // Get referrer name
  const { data: referred } = await supabase
    .from('app_users').select('display_name').eq('id', referred_id).maybeSingle();

  ctx.notify(referrer_id, 'orb_proactive_message', {
    title: 'Your Friend Joined!',
    body: `${referred?.display_name || 'Your friend'} just joined Vitana through your invite!`,
    data: { url: '/wallet' },
  });

  // Credit wallet (reward will be given after activation, tracked here)
  const rewardConfig = REWARD_TABLE['referral_completed'];
  const eventId = `referral_${referrer_id}_${referred_id}`;

  await supabase.rpc('credit_wallet', {
    p_tenant_id: tenantId,
    p_user_id: referrer_id,
    p_amount: rewardConfig.amount,
    p_type: 'reward',
    p_source: 'AP-0405',
    p_source_event_id: eventId,
    p_description: rewardConfig.description,
  });

  await ctx.emitEvent('autopilot.sharing.referral_completed', {
    referrer_id, referred_id, reward: rewardConfig.amount,
  });

  return { usersAffected: 2, actionsTaken: 3 };
}

// ── AP-0408: Event Countdown Share Prompt ───────────────────
async function runEventCountdownSharePrompt(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const in46h = new Date(now.getTime() + 46 * 60 * 60 * 1000);

  // Meetups starting in ~48 hours with 5+ RSVPs
  const { data: meetups } = await supabase
    .from('community_meetups')
    .select('id, title')
    .eq('tenant_id', tenantId)
    .gte('starts_at', in46h.toISOString())
    .lte('starts_at', in48h.toISOString());

  for (const meetup of meetups || []) {
    const { data: rsvps, count } = await supabase
      .from('community_meetup_attendance')
      .select('user_id', { count: 'exact' })
      .eq('meetup_id', meetup.id)
      .eq('status', 'rsvp');

    if ((count || 0) < 5) continue;

    for (const rsvp of rsvps || []) {
      ctx.notify(rsvp.user_id, 'orb_suggestion', {
        title: `${meetup.title} is in 2 days!`,
        body: 'Help spread the word — share with friends who might enjoy it.',
        data: { url: `/community/meetups/${meetup.id}`, meetup_id: meetup.id },
      });
      usersAffected++;
      actionsTaken++;
    }
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0410: Viral Loop — Shared Link → New User Onboarding ─
async function runViralLoopOnboarding(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { referred_id, referrer_id, target_type, target_id } = payload || {};
  if (!referred_id || !referrer_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Auto-connect referrer and referred
  await supabase.from('relationship_edges').upsert({
    tenant_id: tenantId,
    user_id: referred_id,
    target_type: 'person',
    target_id: referrer_id,
    relationship_type: 'connected',
    strength: 30,
    context: JSON.stringify({ origin: 'referral' }),
  }, { onConflict: 'tenant_id,user_id,target_type,target_id' });

  // If target is an event, auto-RSVP
  if (target_type === 'event' && target_id) {
    await supabase.from('community_meetup_attendance').upsert({
      tenant_id: tenantId,
      meetup_id: target_id,
      user_id: referred_id,
      status: 'rsvp',
    }, { onConflict: 'meetup_id,user_id' });
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

export function registerSharingGrowthHandlers(): void {
  registerHandler('generateWhatsAppEventLink', generateWhatsAppEventLink);
  registerHandler('generateWhatsAppGroupInvite', generateWhatsAppGroupInvite);
  registerHandler('runInviteAfterPositive', runInviteAfterPositive);
  registerHandler('runReferralReward', runReferralReward);
  registerHandler('runEventCountdownSharePrompt', runEventCountdownSharePrompt);
  registerHandler('runViralLoopOnboarding', runViralLoopOnboarding);
}
