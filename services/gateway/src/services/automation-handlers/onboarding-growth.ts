/**
 * Onboarding & Viral Growth Handlers — AP-1300 series
 *
 * Automations for first-time user onboarding, starter packs,
 * social proof notifications, and contact-based growth loops.
 *
 * Triggered primarily by the `user.signup.completed` event dispatched
 * from admin-signups route when a user reaches "onboarded" status.
 */

import { randomUUID } from 'crypto';
import { AutomationContext, REWARD_TABLE } from '../../types/automations';
import { registerHandler } from '../automation-executor';

const APP_URL = process.env.APP_URL || 'https://vitana.app';
const VITANA_BOT_USER_ID = process.env.VITANA_BOT_USER_ID || '00000000-0000-0000-0000-000000000000';

// ── AP-1301: ORB-Guided Conversational Onboarding ────────────
// Triggered by: user.signup.completed
// Sends a personalized welcome message via Maxina (ORB) and delivers
// the first batch of onboarding recommendations.
async function runOrbGuidedOnboarding(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) {
    ctx.log('No user_id in event payload, skipping');
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const { supabase, tenantId } = ctx;
  let actionsTaken = 0;

  // Gather user context for personalized welcome
  const { data: user } = await supabase
    .from('app_users')
    .select('display_name, language, created_at')
    .eq('id', userId)
    .maybeSingle();

  const displayName = user?.display_name || '';
  const firstName = displayName.split(' ')[0] || 'there';

  // Check if user has any interests set
  const { count: interestCount } = await supabase
    .from('user_topic_profile')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);

  // Check if user has an avatar
  const { data: profile } = await supabase
    .from('app_users')
    .select('avatar_url')
    .eq('id', userId)
    .maybeSingle();

  const hasAvatar = !!profile?.avatar_url;
  const hasInterests = (interestCount || 0) > 0;

  // Build personalized next-step suggestion
  let nextStep = 'explore your community';
  let nextUrl = '/community';
  if (!hasAvatar) {
    nextStep = 'add your photo so others can recognize you';
    nextUrl = '/profile/edit';
  } else if (!hasInterests) {
    nextStep = 'share your interests so we can find your people';
    nextUrl = '/profile/edit';
  }

  // Send welcome message via ORB (Maxina)
  ctx.notify(userId, 'orb_proactive_message', {
    title: `Welcome to Vitana, ${firstName}!`,
    body: `I'm Maxina, your companion here. I've prepared some things to help you get started. First, let's ${nextStep}.`,
    data: {
      url: nextUrl,
      action: 'onboarding_welcome',
      orb_conversation_starter: 'true',
    },
  });
  actionsTaken++;

  // Trigger personal recommendations generation so the autopilot page is populated
  try {
    const { generatePersonalRecommendations } = await import('../recommendation-engine');
    await generatePersonalRecommendations(userId, tenantId, {
      limit: 8,
      trigger_type: 'first_login',
    });
    actionsTaken++;
    ctx.log(`Generated initial recommendations for user ${userId.slice(0, 8)}…`);
  } catch (err: any) {
    ctx.log(`Warning: Failed to generate initial recommendations: ${err.message}`);
  }

  // Credit onboarding welcome bonus (small amount to introduce wallet)
  try {
    await supabase.rpc('credit_wallet', {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_amount: REWARD_TABLE['complete_onboarding'].amount,
      p_type: 'reward',
      p_source: 'AP-1301',
      p_source_event_id: `onboarding_welcome_${userId}`,
      p_description: 'Welcome bonus for joining Vitana!',
    });
    actionsTaken++;
    ctx.log(`Credited welcome bonus to user ${userId.slice(0, 8)}…`);
  } catch (err: any) {
    // Wallet credit is best-effort; may fail if duplicate (idempotent source_event_id)
    ctx.log(`Wallet credit skipped (${err.message})`);
  }

  await ctx.emitEvent('autopilot.onboarding.welcome_sent', {
    user_id: userId,
    has_avatar: hasAvatar,
    has_interests: hasInterests,
    next_step: nextStep,
  });

  return { usersAffected: 1, actionsTaken };
}

// ── AP-1302: Starter Pack Delivery ───────────────────────────
// Triggered by: user.signup.completed (simplified from onboarding.assessment.completed)
// Delivers a curated starter pack: auto-join relevant groups, queue initial
// matches, and notify about available events.
async function runStarterPackDelivery(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) {
    ctx.log('No user_id in event payload, skipping');
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const { supabase, tenantId } = ctx;
  let actionsTaken = 0;

  // 1. Find user's interests for group matching
  const { data: userTopics } = await supabase
    .from('user_topic_profile')
    .select('topic_key, score')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('score', { ascending: false })
    .limit(5);

  const topicKeys = (userTopics || []).map((t: any) => t.topic_key);

  // 2. Auto-join the "Welcome" / general community group if it exists
  const { data: welcomeGroup } = await supabase
    .from('community_groups')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .eq('is_default', true)
    .maybeSingle();

  if (welcomeGroup) {
    const { error: joinErr } = await supabase
      .from('community_memberships')
      .upsert({
        tenant_id: tenantId,
        group_id: welcomeGroup.id,
        user_id: userId,
        role: 'member',
        joined_at: new Date().toISOString(),
      }, { onConflict: 'group_id,user_id' });

    if (!joinErr) {
      actionsTaken++;
      ctx.log(`Auto-joined user to default group: ${welcomeGroup.name}`);
    }
  }

  // 3. Suggest topic-matched groups (up to 3)
  if (topicKeys.length > 0) {
    const { data: matchedGroups } = await supabase
      .from('community_groups')
      .select('id, name, topic_keys')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .overlaps('topic_keys', topicKeys)
      .neq('is_default', true)
      .limit(3);

    for (const group of matchedGroups || []) {
      ctx.notify(userId, 'group_recommended', {
        title: `Join "${group.name}"`,
        body: `This group matches your interests. Check it out!`,
        data: { url: `/groups/${group.id}`, group_id: group.id },
      });
      actionsTaken++;
    }
  }

  // 4. Find upcoming events in the next 7 days and notify
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const { data: upcomingEvents } = await supabase
    .from('community_meetups')
    .select('id, title, starts_at')
    .eq('tenant_id', tenantId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', weekFromNow.toISOString())
    .order('starts_at', { ascending: true })
    .limit(3);

  if (upcomingEvents?.length) {
    const eventCount = upcomingEvents.length;
    ctx.notify(userId, 'orb_suggestion', {
      title: `${eventCount} event${eventCount > 1 ? 's' : ''} this week`,
      body: `"${upcomingEvents[0].title}" and more — join an event to meet people!`,
      data: { url: '/events' },
    });
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.onboarding.starter_pack_delivered', {
    user_id: userId,
    groups_suggested: topicKeys.length > 0 ? 'yes' : 'no',
    events_found: upcomingEvents?.length || 0,
    default_group_joined: !!welcomeGroup,
  });

  return { usersAffected: 1, actionsTaken };
}

// ── AP-1303: Contact Book Sync & Bulk Invite ─────────────────
// Triggered by: manual (user uploads contacts)
// Matches uploaded contacts against existing users and generates
// invite links for non-users.
async function runContactBookSyncAndInvite(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  const contacts = payload?.contacts as Array<{ name?: string; email?: string; phone?: string }> | undefined;

  if (!userId || !contacts?.length) {
    ctx.log('No user_id or contacts in payload, skipping');
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Extract emails and phones for matching
  const emails = contacts.filter(c => c.email).map(c => c.email!.toLowerCase());
  const phones = contacts.filter(c => c.phone).map(c => c.phone!);

  // 1. Find existing users by email
  let existingUserIds: string[] = [];
  if (emails.length > 0) {
    const { data: existingByEmail } = await supabase
      .from('app_users')
      .select('id, email')
      .in('email', emails);

    existingUserIds = (existingByEmail || []).map((u: any) => u.id);

    // Notify user about found contacts
    if (existingUserIds.length > 0) {
      ctx.notify(userId, 'orb_proactive_message', {
        title: `${existingUserIds.length} of your contacts are on Vitana!`,
        body: 'We found people you know. Want to connect with them?',
        data: { url: '/connections', found_count: String(existingUserIds.length) },
      });
      usersAffected++;
      actionsTaken++;

      // Create pending connection suggestions for found contacts
      for (const contactUserId of existingUserIds.slice(0, 10)) {
        await supabase.from('relationship_edges').upsert({
          tenant_id: tenantId,
          user_id: userId,
          target_type: 'person',
          target_id: contactUserId,
          relationship_type: 'suggested',
          strength: 40,
          context: JSON.stringify({ origin: 'contact_sync' }),
        }, { onConflict: 'tenant_id,user_id,target_type,target_id' });
        actionsTaken++;
      }
    }
  }

  // 2. Generate invite links for non-existing contacts
  const existingEmails = new Set(
    (await supabase.from('app_users').select('email').in('email', emails))?.data?.map((u: any) => u.email?.toLowerCase()) || []
  );

  const newContacts = contacts.filter(c => c.email && !existingEmails.has(c.email.toLowerCase()));
  const inviteCount = Math.min(newContacts.length, 20); // Cap at 20 invites per sync

  if (inviteCount > 0) {
    const shortCode = randomUUID().replace(/-/g, '').substring(0, 8);
    await supabase.from('sharing_links').insert({
      tenant_id: tenantId,
      user_id: userId,
      target_type: 'profile',
      target_id: userId,
      short_code: shortCode,
      utm_source: 'contact_sync',
      utm_medium: 'referral',
      utm_campaign: 'bulk_invite',
      metadata: { invite_count: inviteCount },
    });

    ctx.notify(userId, 'orb_suggestion', {
      title: `Invite ${inviteCount} friends to Vitana`,
      body: 'Send them a personal invite link and earn credits when they join!',
      data: { url: '/invite', short_code: shortCode, invite_count: String(inviteCount) },
    });
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.onboarding.contact_sync_completed', {
    user_id: userId,
    total_contacts: contacts.length,
    existing_found: existingUserIds.length,
    invitable: inviteCount,
  });

  return { usersAffected: usersAffected + inviteCount, actionsTaken };
}

// ── AP-1304: "X Joined Vitana!" Social Proof Notifications ───
// Triggered by: user.signup.completed
// Notifies existing users who have a relationship to the new user
// (contacts, same groups, shared interests) that someone new has joined.
async function runSocialProofNotification(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const newUserId = payload?.user_id;
  if (!newUserId) {
    ctx.log('No user_id in event payload, skipping');
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Get new user's display name
  const { data: newUser } = await supabase
    .from('app_users')
    .select('display_name, email')
    .eq('id', newUserId)
    .maybeSingle();

  const newUserName = newUser?.display_name || 'Someone new';

  // 1. Find users who referred this person
  const { data: referrals } = await supabase
    .from('referrals')
    .select('referrer_id')
    .eq('tenant_id', tenantId)
    .eq('referred_id', newUserId);

  for (const ref of referrals || []) {
    ctx.notify(ref.referrer_id, 'orb_proactive_message', {
      title: `${newUserName} joined Vitana!`,
      body: 'Your friend signed up through your invite. Say hello!',
      data: { url: `/chat/${newUserId}`, peer_id: newUserId },
    });
    usersAffected++;
    actionsTaken++;
  }

  // 2. Find existing users who share the same email domain (colleagues/org)
  if (newUser?.email) {
    const domain = newUser.email.split('@')[1];
    // Skip common public email domains
    const publicDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'protonmail.com'];
    if (domain && !publicDomains.includes(domain)) {
      const { data: colleagues } = await supabase
        .from('app_users')
        .select('id')
        .like('email', `%@${domain}`)
        .neq('id', newUserId)
        .limit(10);

      for (const colleague of colleagues || []) {
        ctx.notify(colleague.id, 'orb_suggestion', {
          title: `${newUserName} from your organization joined!`,
          body: 'Someone from your organization is now on Vitana. Connect with them!',
          data: { url: `/matches`, peer_id: newUserId },
        });
        usersAffected++;
        actionsTaken++;
      }
    }
  }

  // 3. Find existing users who were suggested as contacts (from prior contact syncs)
  const { data: priorSuggestions } = await supabase
    .from('relationship_edges')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('target_id', newUserId)
    .eq('relationship_type', 'suggested')
    .limit(20);

  for (const suggestion of priorSuggestions || []) {
    ctx.notify(suggestion.user_id, 'orb_proactive_message', {
      title: `${newUserName} is now on Vitana!`,
      body: 'Someone from your contacts just joined. Want to connect?',
      data: { url: `/connections`, peer_id: newUserId },
    });
    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.onboarding.social_proof_sent', {
    new_user_id: newUserId,
    notifications_sent: actionsTaken,
    referrer_notified: (referrals || []).length > 0,
  });

  return { usersAffected, actionsTaken };
}

// ── AP-1307: Contact Activity Feed Digest ────────────────────
// Triggered by: heartbeat (every 6 hours)
// Sends a digest of recent activity from a user's connections
// to keep them engaged with what their network is doing.
async function runContactActivityDigest(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Get users who have been active in the last 7 days but not in the last 6 hours
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const users = await ctx.queryTargetUsers('user_id, active_role');

  for (const { user_id } of users) {
    // Check that user has connections
    const { count: connectionCount } = await supabase
      .from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .eq('relationship_type', 'connected');

    if ((connectionCount || 0) < 1) continue;

    // Get connected user IDs
    const { data: connections } = await supabase
      .from('relationship_edges')
      .select('target_id')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .eq('relationship_type', 'connected')
      .limit(50);

    const connectedIds = (connections || []).map((c: any) => c.target_id);
    if (connectedIds.length === 0) continue;

    // Count recent activities by connections (new groups joined, events RSVPed, etc.)
    const { count: groupJoins } = await supabase
      .from('community_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('user_id', connectedIds)
      .gte('joined_at', sevenDaysAgo);

    const { count: eventRsvps } = await supabase
      .from('community_meetup_attendance')
      .select('id', { count: 'exact', head: true })
      .in('user_id', connectedIds)
      .gte('created_at', sevenDaysAgo);

    const totalActivity = (groupJoins || 0) + (eventRsvps || 0);
    if (totalActivity === 0) continue;

    // Build summary
    const parts: string[] = [];
    if (groupJoins && groupJoins > 0) parts.push(`${groupJoins} group join${groupJoins > 1 ? 's' : ''}`);
    if (eventRsvps && eventRsvps > 0) parts.push(`${eventRsvps} event RSVP${eventRsvps > 1 ? 's' : ''}`);

    ctx.notify(user_id, 'community_digest', {
      title: 'Your connections have been busy!',
      body: `This week: ${parts.join(', ')}. See what's happening.`,
      data: { url: '/community' },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.onboarding.activity_digest_sent', {
    users_notified: usersAffected,
  });

  return { usersAffected, actionsTaken };
}

// ── AP-1305: Social Account Connect ───────────────────────────
// Triggered by: manual (user initiates from UI settings)
// Reminds users to connect their social accounts for profile enrichment.
// Also runs as a heartbeat to re-trigger enrichment for pending connections.
async function runSocialAccountConnect(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;

  // Manual mode: specific user triggered connection
  if (userId) {
    ctx.log(`Social account connect triggered for user ${userId.slice(0, 8)}…`);
    return { usersAffected: 1, actionsTaken: 1 };
  }

  // Heartbeat mode: find users who haven't connected any social accounts
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = await ctx.queryTargetUsers('user_id, active_role');

  for (const { user_id } of users.slice(0, 50)) {
    // Check if user has any social connections
    const { count: socialCount } = await supabase
      .from('social_connections')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .eq('is_active', true);

    if ((socialCount || 0) > 0) continue;

    // Check account age (only nudge users who've been around 3+ days)
    const { data: appUser } = await supabase
      .from('app_users')
      .select('created_at')
      .eq('user_id', user_id)
      .maybeSingle();

    if (!appUser?.created_at) continue;
    const daysSinceSignup = (Date.now() - new Date(appUser.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceSignup < 3) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Connect Your Social Accounts',
      body: 'Link Instagram, Facebook, or LinkedIn to auto-fill your profile and share achievements!',
      data: {
        url: '/settings/social',
        source: 'AP-1305',
      },
    });

    usersAffected++;
    actionsTaken++;
  }

  // Also re-trigger enrichment for connections stuck in 'pending'
  const { data: pendingConns } = await supabase
    .from('social_connections')
    .select('id, user_id')
    .eq('enrichment_status', 'pending')
    .eq('is_active', true)
    .limit(20);

  if (pendingConns?.length) {
    try {
      const { enrichProfileFromSocial } = await import('../social-connect-service');
      for (const conn of pendingConns) {
        await enrichProfileFromSocial(supabase, conn.user_id, tenantId, conn.id);
        actionsTaken++;
      }
    } catch (err: any) {
      ctx.log(`Enrichment retry error: ${err.message}`);
    }
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1306: Auto-Share to Social Accounts ────────────────────
// Triggered by: user.milestone.reached
// Posts achievement to user's connected social accounts.
// If auto-share is disabled, sends a notification with a share link instead.
async function runAutoShareToSocial(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, milestone, tenant_id } = payload || {};
  if (!user_id || !milestone) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase } = ctx;
  const effectiveTenantId = tenant_id || ctx.tenantId;
  let actionsTaken = 0;

  // Get milestone definition
  let milestoneDef: { id: string; name: string; celebration: string; icon: string } | null = null;
  try {
    const { MILESTONES } = await import('../milestone-service');
    const def = MILESTONES[milestone];
    if (def) {
      milestoneDef = { id: milestone, name: def.name, celebration: def.celebration, icon: def.icon };
    }
  } catch {}

  if (!milestoneDef) {
    milestoneDef = { id: milestone, name: milestone, celebration: `Achievement unlocked: ${milestone}`, icon: '🏆' };
  }

  // Attempt auto-share
  try {
    const { shareMilestoneToSocial } = await import('../social-connect-service');
    const shareResult = await shareMilestoneToSocial(supabase, user_id, effectiveTenantId, milestoneDef);

    if (shareResult.shared.length > 0) {
      ctx.log(`Shared "${milestone}" to: ${shareResult.shared.join(', ')}`);
      actionsTaken += shareResult.shared.length;

      // Notify user that their achievement was shared
      ctx.notify(user_id, 'orb_proactive_message', {
        title: `${milestoneDef.icon} Shared to ${shareResult.shared.join(', ')}!`,
        body: `Your achievement "${milestoneDef.name}" was posted. If you'd like to disable auto-sharing, visit your Autopilot settings.`,
        data: {
          url: '/settings/autopilot',
          milestone,
          shared_to: shareResult.shared.join(','),
        },
      });
      actionsTaken++;
    }

    if (shareResult.notify_instead) {
      // Auto-share is off or no connected accounts — send share prompt instead
      const shareUrl = `${process.env.APP_URL || 'https://vitana.app'}/profile?milestone=${milestone}`;

      ctx.notify(user_id, 'orb_suggestion', {
        title: `${milestoneDef.icon} Share Your Achievement!`,
        body: `You earned "${milestoneDef.name}"! Share it with your network.`,
        data: {
          url: shareUrl,
          milestone,
          action: 'share_prompt',
          settings_url: '/settings/autopilot',
        },
      });
      actionsTaken++;
    }
  } catch (err: any) {
    ctx.log(`Auto-share error: ${err.message}`);

    // Fallback: always send a share prompt notification
    ctx.notify(user_id, 'orb_suggestion', {
      title: `${milestoneDef.icon} Share Your Achievement!`,
      body: `You earned "${milestoneDef.name}"! Share it with friends.`,
      data: { url: '/profile', milestone },
    });
    actionsTaken++;
  }

  return { usersAffected: 1, actionsTaken };
}

// ── Register all handlers ───────────────────────────────────
export function registerOnboardingGrowthHandlers(): void {
  registerHandler('runOrbGuidedOnboarding', runOrbGuidedOnboarding);
  registerHandler('runStarterPackDelivery', runStarterPackDelivery);
  registerHandler('runContactBookSyncAndInvite', runContactBookSyncAndInvite);
  registerHandler('runSocialProofNotification', runSocialProofNotification);
  registerHandler('runContactActivityDigest', runContactActivityDigest);
  registerHandler('runSocialAccountConnect', runSocialAccountConnect);
  registerHandler('runAutoShareToSocial', runAutoShareToSocial);
}
