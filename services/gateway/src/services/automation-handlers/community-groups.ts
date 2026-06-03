/**
 * Community & Groups Handlers — AP-0200 series
 *
 * VTID: VTID-01250
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-0202: Group Invite Follow-Up ─────────────────────────
async function runGroupInviteFollowUp(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: pendingInvites } = await supabase
    .from('community_group_invitations')
    .select('id, user_id, group_id, invited_by')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lte('created_at', fortyEightHoursAgo)
    .limit(100);

  for (const invite of pendingInvites || []) {
    const { data: group } = await supabase
      .from('community_groups')
      .select('name, topic_keys')
      .eq('id', invite.group_id)
      .maybeSingle();

    const { data: inviter } = await supabase
      .from('app_users')
      .select('display_name')
      .eq('id', invite.invited_by)
      .maybeSingle();

    ctx.notify(invite.user_id, 'group_invitation_received', {
      title: 'Group Invitation Reminder',
      body: `${inviter?.display_name || 'Someone'} invited you to join "${group?.name || 'a group'}"`,
      data: { url: `/community/groups/${invite.group_id}`, group_id: invite.group_id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0203: New Member Welcome ─────────────────────────────
async function runNewMemberWelcome(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, group_id } = payload || {};
  if (!user_id || !group_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: group } = await supabase
    .from('community_groups')
    .select('name, description, created_by')
    .eq('id', group_id)
    .maybeSingle();

  const { count: memberCount } = await supabase
    .from('community_memberships')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', group_id);

  ctx.notify(user_id, 'orb_proactive_message', {
    title: `Welcome to ${group?.name || 'the group'}!`,
    body: `${memberCount || 0} members are active. ${group?.description || ''}`.trim(),
    data: { url: `/community/groups/${group_id}`, group_id },
  });

  // Notify group creator
  if (group?.created_by && group.created_by !== user_id) {
    const { data: newMember } = await supabase
      .from('app_users').select('display_name').eq('id', user_id).maybeSingle();

    ctx.notify(group.created_by, 'someone_joined_your_group', {
      title: 'New Group Member!',
      body: `${newMember?.display_name || 'Someone'} just joined ${group.name}!`,
      data: { url: `/community/groups/${group_id}`, group_id },
    });
  }

  return { usersAffected: 2, actionsTaken: 2 };
}

// ── AP-0212: "Welcome Squad" New-Member Activation ──────────
// Multi-step orchestration fired on community.member.joined:
//   1. Introduce the newcomer to up to 3 existing group members ("the squad")
//   2. Suggest related public groups in the same category
//   3. Send the newcomer a warm welcome with the intros + suggestions
//   4. Notify the group host their Welcome Squad went out (auto-fire,
//      in-platform members only, attributed "via Autopilot")
//   5. Seed Autopilot recommendation cards so the newcomer's Autopilot
//      page is populated with one-tap "approve" actions
// Guardrails: intros capped at SQUAD_SIZE; all sends are in-platform
// member notifications (no external channels); messages are attributed.
const SQUAD_SIZE = 3;

async function runWelcomeSquad(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, group_id } = payload || {};
  if (!user_id || !group_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Real schema: global_community_groups / global_community_group_members
  // (the VTID-01084 community_groups/_memberships tables were never deployed
  // to production; the live, populated tables are the global_* ones).
  const { data: group } = await supabase
    .from('global_community_groups')
    .select('name, description, created_by, category')
    .eq('id', group_id)
    .maybeSingle();
  if (!group) return { usersAffected: 0, actionsTaken: 0 };

  const { data: newMember } = await supabase
    .from('app_users')
    .select('display_name')
    .eq('id', user_id)
    .maybeSingle();
  const newMemberName = newMember?.display_name || 'A new member';

  // Step 1 — pick the squad: up to 3 existing members of this group
  // (excluding the newcomer and the host, who is notified separately).
  // Oldest members first so the newcomer meets established regulars.
  const { data: members } = await supabase
    .from('global_community_group_members')
    .select('user_id')
    .eq('group_id', group_id)
    .neq('user_id', user_id)
    .order('joined_at', { ascending: true })
    .limit(50);

  const squad: string[] = [];
  for (const m of members || []) {
    if (m.user_id === group.created_by) continue;
    squad.push(m.user_id);
    if (squad.length >= SQUAD_SIZE) break;
  }

  // Step 2 — suggest related public groups in the same category.
  let suggestedGroups: Array<{ id: string; name: string }> = [];
  if (group.category) {
    const { data: related } = await supabase
      .from('global_community_groups')
      .select('id, name')
      .eq('category', group.category)
      .eq('is_public', true)
      .neq('id', group_id)
      .limit(2);
    suggestedGroups = related || [];
  }

  // Step 3 — warm welcome to the newcomer with the squad + suggestions.
  const squadLine = squad.length
    ? `Meet ${squad.length} member${squad.length > 1 ? 's' : ''} to connect with`
    : 'Say hi to the group';
  const extras: string[] = [];
  if (suggestedGroups.length) {
    extras.push(`${suggestedGroups.length} related group${suggestedGroups.length > 1 ? 's' : ''} you'll like`);
  }

  ctx.notify(user_id, 'orb_proactive_message', {
    title: `Welcome to ${group.name}! Your squad is ready 👋`,
    body: [squadLine, ...extras].join(' · '),
    data: {
      url: `/community/groups/${group_id}`,
      group_id,
      squad_user_ids: squad.join(','),
      suggested_group_ids: suggestedGroups.map((g) => g.id).join(','),
      via: 'autopilot',
      automation_id: 'AP-0212',
    },
  });
  usersAffected++;
  actionsTaken++;

  // Step 4 — notify the host their Welcome Squad went out (auto-fire,
  // in-platform member, attributed).
  if (group.created_by && group.created_by !== user_id) {
    ctx.notify(group.created_by, 'someone_joined_your_group', {
      title: `Welcome Squad sent for ${newMemberName} 🎉`,
      body: `Autopilot introduced them to ${squad.length} member${squad.length === 1 ? '' : 's'} in ${group.name} and shared what to do next.`,
      data: {
        url: `/community/groups/${group_id}`,
        group_id,
        new_member_id: user_id,
        via: 'autopilot',
        automation_id: 'AP-0212',
      },
    });
    usersAffected++;
    actionsTaken++;
  }

  // Step 5 — seed Autopilot recommendation cards for the newcomer so the
  // Autopilot page has one-tap "approve" actions waiting.
  try {
    const { generatePersonalRecommendations } = await import('../recommendation-engine');
    await generatePersonalRecommendations(user_id, tenantId, {
      trigger_type: 'auto_replenish',
    });
    actionsTaken++;
  } catch (err: any) {
    ctx.log(`AP-0212: recommendation seeding skipped (${err?.message || err})`);
  }

  await ctx.emitEvent('autopilot.welcome_squad.sent', {
    user_id,
    group_id,
    squad_size: squad.length,
    suggested_groups: suggestedGroups.length,
  });

  return { usersAffected, actionsTaken };
}

// ── AP-0207: Meetup RSVP Encouragement ──────────────────────
async function runMeetupRsvpEncouragement(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Find meetups starting in next 24h with < 3 RSVPs
  const { data: meetups } = await supabase
    .from('community_meetups')
    .select('id, title, group_id, starts_at')
    .eq('tenant_id', tenantId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', in24h.toISOString());

  for (const meetup of meetups || []) {
    const { count: rsvpCount } = await supabase
      .from('community_meetup_attendance')
      .select('id', { count: 'exact', head: true })
      .eq('meetup_id', meetup.id)
      .eq('status', 'rsvp');

    if ((rsvpCount || 0) >= 3) continue;

    // Get group members who haven't RSVP'd
    const { data: rsvpUsers } = await supabase
      .from('community_meetup_attendance')
      .select('user_id')
      .eq('meetup_id', meetup.id);

    const rsvpSet = new Set((rsvpUsers || []).map((r: any) => r.user_id));

    const { data: groupMembers } = await supabase
      .from('community_memberships')
      .select('user_id')
      .eq('group_id', meetup.group_id)
      .limit(20);

    for (const member of groupMembers || []) {
      if (rsvpSet.has(member.user_id)) continue;

      ctx.notify(member.user_id, 'meetup_recommended', {
        title: 'Meetup Tomorrow!',
        body: `"${meetup.title}" is tomorrow — ${rsvpCount || 0} people are going. Join them?`,
        data: { url: `/community/meetups/${meetup.id}`, meetup_id: meetup.id },
      });

      usersAffected++;
      actionsTaken++;
    }
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0208: Post-Meetup Connection Prompt ──────────────────
async function runPostMeetupConnect(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const meetupId = payload?.meetup_id;
  if (!meetupId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: attendees } = await supabase
    .from('community_meetup_attendance')
    .select('user_id')
    .eq('meetup_id', meetupId)
    .eq('status', 'attended');

  const { data: meetup } = await supabase
    .from('community_meetups')
    .select('title')
    .eq('id', meetupId)
    .maybeSingle();

  for (const attendee of attendees || []) {
    ctx.notify(attendee.user_id, 'orb_proactive_message', {
      title: `How was ${meetup?.title || 'the meetup'}?`,
      body: 'Want to connect with people you met? Check your matches.',
      data: { url: '/matches', meetup_id: meetupId },
    });
    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0210: Community Digest for Group Creators ────────────
async function runCommunityCreatorDigest(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: groups } = await supabase
    .from('community_groups')
    .select('id, name, created_by')
    .eq('tenant_id', tenantId);

  for (const group of groups || []) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: newMembers } = await supabase
      .from('community_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', group.id)
      .gte('joined_at', sevenDaysAgo);

    ctx.notify(group.created_by, 'orb_proactive_message', {
      title: `Your group "${group.name}" this week`,
      body: `+${newMembers || 0} new members this week.`,
      data: { url: `/community/groups/${group.id}`, group_id: group.id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0211: "Revive Your Group" Re-Ignition ────────────────
// Daily heartbeat: scan for dormant groups (no posts in DORMANT_DAYS) that
// still have members and a host, and nudge the host to re-ignite — post an
// update or plan a meetup. In-platform host notification, attributed to
// Autopilot. A per-group cooldown prevents nudging the same host more than
// once every REVIVE_COOLDOWN_DAYS even though the scan runs daily.
const DORMANT_DAYS = 14;
const REVIVE_COOLDOWN_DAYS = 7;
const REVIVE_MAX_NUDGES = 50; // safety cap per run

async function runReviveYourGroup(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const dormantCutoff = new Date(Date.now() - DORMANT_DAYS * 86_400_000).toISOString();
  const cooldownCutoff = new Date(Date.now() - REVIVE_COOLDOWN_DAYS * 86_400_000).toISOString();

  // Active, hosted groups that still have members. global_community_groups has
  // no tenant_id — the global community is shared — so we scan all of them.
  const { data: groups } = await supabase
    .from('global_community_groups')
    .select('id, name, created_by, member_count')
    .eq('status', 'approved')
    .not('created_by', 'is', null)
    .gte('member_count', 1)
    .limit(500);

  let scanned = 0;
  for (const group of groups || []) {
    if (actionsTaken >= REVIVE_MAX_NUDGES) break;
    scanned++;

    // Most recent post in the group is the activity signal.
    const { data: lastPost } = await supabase
      .from('group_posts')
      .select('created_at')
      .eq('group_id', group.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Dormant = no posts at all, or the latest post is older than the cutoff.
    const isDormant = !lastPost || lastPost.created_at < dormantCutoff;
    if (!isDormant) continue;

    // Cooldown: skip if this host was already nudged for this group recently.
    const { data: recentNudge } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', group.created_by)
      .eq('type', 'orb_proactive_message')
      .contains('data', { automation_id: 'AP-0211', group_id: group.id })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentNudge && recentNudge.length > 0) continue;

    const daysQuiet = lastPost
      ? Math.floor((Date.now() - new Date(lastPost.created_at).getTime()) / 86_400_000)
      : null;
    const memberCount = group.member_count ?? 0;
    const memberWord = memberCount === 1 ? 'member' : 'members';

    ctx.notify(group.created_by, 'orb_proactive_message', {
      title: `Your group "${group.name}" has gone quiet 🌱`,
      body: daysQuiet !== null
        ? `No new posts in ${daysQuiet} days. Your ${memberCount} ${memberWord} are waiting — share an update or plan a meetup to bring it back to life.`
        : `${memberCount} ${memberWord} joined but no one has posted yet. Kick things off with a welcome or a question.`,
      data: {
        url: `/community/groups/${group.id}`,
        group_id: group.id,
        days_quiet: String(daysQuiet ?? 0),
        via: 'autopilot',
        automation_id: 'AP-0211',
      },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.group_revive.scanned', {
    groups_scanned: scanned,
    nudges_sent: actionsTaken,
    dormant_threshold_days: DORMANT_DAYS,
  });

  return { usersAffected, actionsTaken };
}

export function registerCommunityGroupsHandlers(): void {
  registerHandler('runGroupInviteFollowUp', runGroupInviteFollowUp);
  registerHandler('runNewMemberWelcome', runNewMemberWelcome);
  registerHandler('runWelcomeSquad', runWelcomeSquad);
  registerHandler('runReviveYourGroup', runReviveYourGroup);
  registerHandler('runMeetupRsvpEncouragement', runMeetupRsvpEncouragement);
  registerHandler('runPostMeetupConnect', runPostMeetupConnect);
  registerHandler('runCommunityCreatorDigest', runCommunityCreatorDigest);
}
