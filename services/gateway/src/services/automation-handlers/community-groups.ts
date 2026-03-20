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

    const rsvpSet = new Set((rsvpUsers || []).map(r => r.user_id));

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

export function registerCommunityGroupsHandlers(): void {
  registerHandler('runGroupInviteFollowUp', runGroupInviteFollowUp);
  registerHandler('runNewMemberWelcome', runNewMemberWelcome);
  registerHandler('runMeetupRsvpEncouragement', runMeetupRsvpEncouragement);
  registerHandler('runPostMeetupConnect', runPostMeetupConnect);
  registerHandler('runCommunityCreatorDigest', runCommunityCreatorDigest);
}
