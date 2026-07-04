/**
 * Community & Groups Handlers — AP-0200 series
 *
 * VTID: VTID-01250
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-0202: Group Invite Follow-Up ─────────────────────────
// Real schema: community_groups/community_memberships (VTID-01084) were
// never deployed; global_community_groups is the live groups table.
// community_group_invitations IS live, but its invitee column is
// invited_user_id, not user_id. app_users' primary key is user_id, not id
// (a mistake repeated across several handlers in this file before this fix).
async function runGroupInviteFollowUp(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: pendingInvites } = await supabase
    .from('community_group_invitations')
    .select('id, invited_user_id, group_id, invited_by')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lte('created_at', fortyEightHoursAgo)
    .limit(100);

  for (const invite of pendingInvites || []) {
    const { data: group } = await supabase
      .from('global_community_groups')
      .select('name')
      .eq('id', invite.group_id)
      .maybeSingle();

    const { data: inviter } = await supabase
      .from('app_users')
      .select('display_name')
      .eq('user_id', invite.invited_by)
      .maybeSingle();

    ctx.notify(invite.invited_user_id, 'group_invitation_received', {
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
// Real schema: global_community_groups/global_community_group_members
// (no tenant_id — the global community is shared across tenants).
async function runNewMemberWelcome(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, group_id } = payload || {};
  if (!user_id || !group_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase } = ctx;

  const { data: group } = await supabase
    .from('global_community_groups')
    .select('name, description, created_by')
    .eq('id', group_id)
    .maybeSingle();

  const { count: memberCount } = await supabase
    .from('global_community_group_members')
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
      .from('app_users').select('display_name').eq('user_id', user_id).maybeSingle();

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
    .eq('user_id', user_id)
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
// Real schema: community_meetups/community_meetup_attendance were never
// deployed. global_community_events/global_event_participants is the live
// equivalent — but events there aren't linked to a group_id, so "notify
// group members who haven't RSVP'd" has no live equivalent. Adapted to the
// schema that actually exists: nudge the event's own creator to help
// promote it when registrations are low as start time approaches.
async function runMeetupRsvpEncouragement(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title, created_by, start_time, participant_count, max_participants')
    .gte('start_time', now.toISOString())
    .lte('start_time', in24h.toISOString())
    .not('created_by', 'is', null);

  for (const event of events || []) {
    const participantCount = event.participant_count || 0;
    if (participantCount >= 3) continue;

    ctx.notify(event.created_by, 'meetup_recommended', {
      title: 'Your event is tomorrow',
      body: `"${event.title}" starts soon with ${participantCount} registered${event.max_participants ? ` (room for ${event.max_participants})` : ''}. Share it to fill more seats.`,
      data: { url: `/community/events/${event.id}`, event_id: event.id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0208: Post-Meetup Connection Prompt ──────────────────
// Real schema: global_community_events/global_event_participants (see
// AP-0207 comment). global_event_participants has no distinct "attended"
// status observed live (only 'attending'), so this fires on registered
// participants once the event has ended.
async function runPostMeetupConnect(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const meetupId = payload?.meetup_id;
  if (!meetupId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: attendees } = await supabase
    .from('global_event_participants')
    .select('user_id')
    .eq('event_id', meetupId)
    .eq('status', 'attending');

  const { data: meetup } = await supabase
    .from('global_community_events')
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
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: groups } = await supabase
    .from('global_community_groups')
    .select('id, name, created_by')
    .not('created_by', 'is', null);

  for (const group of groups || []) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: newMembers } = await supabase
      .from('global_community_group_members')
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

const VITANA_BOT_USER_ID = process.env.VITANA_BOT_USER_ID || '00000000-0000-0000-0000-000000000000';

// ── AP-0201: Auto-Create Group from Interest Cluster ────────
// Clusters on user_interests.interest (the live interest-signal table —
// user_topic_profile, used by AP-0102, does not exist in the live DB).
// Bounded: at most INTEREST_CLUSTER_MAX_NEW_GROUPS new groups per run, skips
// any interest that already has a public group.
const INTEREST_CLUSTER_MIN_USERS = 5;
const INTEREST_CLUSTER_MIN_CONFIDENCE = 0.6;
const INTEREST_CLUSTER_MAX_NEW_GROUPS = 2;
const INTEREST_CLUSTER_MAX_MEMBERS_PER_GROUP = 20;

async function runAutoCreateGroupFromInterestCluster(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: interestRows } = await supabase
    .from('user_interests')
    .select('user_id, interest, confidence_score')
    .gte('confidence_score', INTEREST_CLUSTER_MIN_CONFIDENCE)
    .limit(2000);

  const usersByInterest = new Map<string, string[]>();
  for (const row of interestRows || []) {
    const key = (row.interest || '').trim().toLowerCase();
    if (!key) continue;
    const users = usersByInterest.get(key) || [];
    if (!users.includes(row.user_id)) users.push(row.user_id);
    usersByInterest.set(key, users);
  }

  let groupsCreated = 0;
  for (const [interest, userIds] of usersByInterest) {
    if (groupsCreated >= INTEREST_CLUSTER_MAX_NEW_GROUPS) break;
    if (userIds.length < INTEREST_CLUSTER_MIN_USERS) continue;

    const { data: existingGroup } = await supabase
      .from('global_community_groups')
      .select('id')
      .ilike('category', interest)
      .limit(1)
      .maybeSingle();
    if (existingGroup) continue;

    const displayName = interest.replace(/(^|\s)\S/g, (c: string) => c.toUpperCase());
    const { data: newGroup, error: createErr } = await supabase
      .from('global_community_groups')
      .insert({
        name: `${displayName} Circle`,
        description: `Auto-created for members who share an interest in ${displayName}.`,
        category: interest,
        is_public: true,
        created_by: VITANA_BOT_USER_ID,
      })
      .select('id, name')
      .single();
    if (createErr || !newGroup) continue;

    const memberIds = userIds.slice(0, INTEREST_CLUSTER_MAX_MEMBERS_PER_GROUP);
    await supabase
      .from('global_community_group_members')
      .insert(memberIds.map((user_id) => ({ group_id: newGroup.id, user_id, role: 'member' })));

    for (const user_id of memberIds) {
      ctx.notify(user_id, 'group_recommended', {
        title: `New group: ${newGroup.name}`,
        body: `We created a group for people who share your interest in ${displayName}.`,
        data: { url: `/community/groups/${newGroup.id}`, group_id: newGroup.id },
      });
      usersAffected++;
      actionsTaken++;
    }

    groupsCreated++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.community.groups_auto_created', { groups_created: groupsCreated });

  return { usersAffected, actionsTaken };
}

// ── AP-0204: Auto-Suggest Meetup from Group Activity ────────
// Registry originally specified an event trigger (community.chat.activity_
// spike), but nothing in the gateway inserts group chat messages — the
// frontend writes global_messages directly via Supabase, so there is no
// gateway-side hook to dispatch that event from. Implemented as a heartbeat
// scan of global_messages volume per group instead (see registry entry).
const ACTIVITY_SPIKE_WINDOW_HOURS = 3;
const ACTIVITY_SPIKE_MIN_MESSAGES = 15;
const ACTIVITY_SPIKE_COOLDOWN_DAYS = 7;
const ACTIVITY_SPIKE_MAX_SUGGESTIONS = 20;

async function runAutoSuggestMeetupFromGroupActivity(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const windowStart = new Date(Date.now() - ACTIVITY_SPIKE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const cooldownCutoff = new Date(Date.now() - ACTIVITY_SPIKE_COOLDOWN_DAYS * 86_400_000).toISOString();

  const { data: groups } = await supabase
    .from('global_community_groups')
    .select('id, name, created_by, chat_thread_id')
    .not('chat_thread_id', 'is', null)
    .not('created_by', 'is', null)
    .limit(500);

  let suggestionsSent = 0;
  for (const group of groups || []) {
    if (suggestionsSent >= ACTIVITY_SPIKE_MAX_SUGGESTIONS) break;

    const { count: messageCount } = await supabase
      .from('global_messages')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', group.chat_thread_id)
      .gte('created_at', windowStart);

    if ((messageCount || 0) < ACTIVITY_SPIKE_MIN_MESSAGES) continue;

    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', group.created_by)
      .contains('data', { automation_id: 'AP-0204', group_id: group.id })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    ctx.notify(group.created_by, 'orb_proactive_message', {
      title: `${group.name} is buzzing 🔥`,
      body: `${messageCount} messages in the last ${ACTIVITY_SPIKE_WINDOW_HOURS}h — a great time to plan a meetup while everyone's engaged.`,
      data: {
        url: `/community/groups/${group.id}`,
        group_id: group.id,
        via: 'autopilot',
        automation_id: 'AP-0204',
      },
    });

    usersAffected++;
    actionsTaken++;
    suggestionsSent++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0205: Group Health Monitor ───────────────────────────
// Weekly ops/admin digest: dormant groups (no posts in DORMANT_DAYS, mirrors
// AP-0211's threshold) and groups with zero members, so ops has visibility
// before a group needs manual intervention.
const HEALTH_MONITOR_MAX_GROUPS_LISTED = 10;

async function runGroupHealthMonitor(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const dormantCutoff = new Date(Date.now() - DORMANT_DAYS * 86_400_000).toISOString();

  const { data: groups } = await supabase
    .from('global_community_groups')
    .select('id, name, member_count')
    .eq('status', 'approved')
    .limit(1000);

  const emptyGroups: string[] = [];
  const dormantGroups: string[] = [];

  for (const group of groups || []) {
    if ((group.member_count || 0) === 0) {
      emptyGroups.push(group.name);
      continue;
    }

    const { data: lastPost } = await supabase
      .from('group_posts')
      .select('created_at')
      .eq('group_id', group.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastPost || lastPost.created_at < dormantCutoff) {
      dormantGroups.push(group.name);
    }
  }

  if (emptyGroups.length === 0 && dormantGroups.length === 0) {
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const opsUsers = await ctx.queryTargetUsers();
  for (const { user_id } of opsUsers) {
    ctx.notify(user_id, 'admin_digest', {
      title: 'Weekly Group Health Report',
      body: `${dormantGroups.length} dormant, ${emptyGroups.length} empty of ${groups?.length || 0} total groups.`,
      data: {
        dormant_groups: dormantGroups.slice(0, HEALTH_MONITOR_MAX_GROUPS_LISTED).join(', '),
        empty_groups: emptyGroups.slice(0, HEALTH_MONITOR_MAX_GROUPS_LISTED).join(', '),
      },
    });
    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.group_health.reported', {
    total_groups: groups?.length || 0,
    dormant_count: dormantGroups.length,
    empty_count: emptyGroups.length,
  });

  return { usersAffected, actionsTaken };
}

// ── AP-0206: Cross-Group Introduction ───────────────────────
// Finds pairs of users who co-belong to 2+ of the same groups but have no
// relationship_edges connection yet, and suggests they connect. Bounded to
// a sample of users per run to keep the O(n²) pairing cheap.
const CROSS_GROUP_MAX_USERS_SCANNED = 200;
const CROSS_GROUP_MIN_SHARED_GROUPS = 2;
const CROSS_GROUP_MAX_INTROS = 20;

async function runCrossGroupIntroduction(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: memberships } = await supabase
    .from('global_community_group_members')
    .select('user_id, group_id')
    .limit(5000);

  const groupsByUser = new Map<string, Set<string>>();
  for (const m of memberships || []) {
    const set = groupsByUser.get(m.user_id) || new Set<string>();
    set.add(m.group_id);
    groupsByUser.set(m.user_id, set);
  }

  const userIds = [...groupsByUser.keys()].slice(0, CROSS_GROUP_MAX_USERS_SCANNED);
  const introduced = new Set<string>(); // "userA|userB" pairs already handled this run

  let introsSent = 0;
  for (let i = 0; i < userIds.length && introsSent < CROSS_GROUP_MAX_INTROS; i++) {
    for (let j = i + 1; j < userIds.length && introsSent < CROSS_GROUP_MAX_INTROS; j++) {
      const userA = userIds[i];
      const userB = userIds[j];
      const pairKey = [userA, userB].sort().join('|');
      if (introduced.has(pairKey)) continue;

      const groupsA = groupsByUser.get(userA)!;
      const groupsB = groupsByUser.get(userB)!;
      let shared = 0;
      for (const g of groupsA) if (groupsB.has(g)) shared++;
      if (shared < CROSS_GROUP_MIN_SHARED_GROUPS) continue;

      const { data: existingEdge } = await supabase
        .from('relationship_edges')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('source_type', 'person')
        .eq('source_id', userA)
        .eq('target_type', 'person')
        .eq('target_id', userB)
        .limit(1);
      if (existingEdge && existingEdge.length > 0) continue;

      introduced.add(pairKey);

      ctx.notify(userA, 'person_match_suggested', {
        title: 'You keep showing up together',
        body: `You and someone else are both in ${shared} of the same groups — want to connect?`,
        data: { peer_id: userB, url: `/chat/${userB}` },
      });
      ctx.notify(userB, 'person_match_suggested', {
        title: 'You keep showing up together',
        body: `You and someone else are both in ${shared} of the same groups — want to connect?`,
        data: { peer_id: userA, url: `/chat/${userA}` },
      });

      usersAffected += 2;
      actionsTaken += 2;
      introsSent++;
    }
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0209: Group Creation from Match Cluster ──────────────
// Finds fully-connected triangles in relationship_edges (three mutually
// "connected" users with no group in common) and auto-creates a group for
// them. Bounded to MATCH_CLUSTER_MAX_NEW_GROUPS per run.
const MATCH_CLUSTER_MAX_NEW_GROUPS = 2;
const MATCH_CLUSTER_MAX_EDGES_SCANNED = 3000;

async function runGroupCreationFromMatchCluster(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: edges } = await supabase
    .from('relationship_edges')
    .select('source_id, target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .limit(MATCH_CLUSTER_MAX_EDGES_SCANNED);

  const connections = new Map<string, Set<string>>();
  for (const e of edges || []) {
    if (!connections.has(e.source_id)) connections.set(e.source_id, new Set());
    connections.get(e.source_id)!.add(e.target_id);
  }

  const foundTriangles: [string, string, string][] = [];
  for (const [a, aConns] of connections) {
    for (const b of aConns) {
      const bConns = connections.get(b);
      if (!bConns) continue;
      for (const c of bConns) {
        if (c === a) continue;
        if (aConns.has(c)) {
          const triangle = [a, b, c].sort() as [string, string, string];
          const key = triangle.join('|');
          if (!foundTriangles.some((t) => t.join('|') === key)) {
            foundTriangles.push(triangle);
          }
        }
      }
    }
  }

  let groupsCreated = 0;
  for (const [userA, userB, userC] of foundTriangles) {
    if (groupsCreated >= MATCH_CLUSTER_MAX_NEW_GROUPS) break;

    // Skip if these three already share a group.
    const { data: sharedMemberships } = await supabase
      .from('global_community_group_members')
      .select('group_id, user_id')
      .in('user_id', [userA, userB, userC]);

    const groupCounts = new Map<string, number>();
    for (const m of sharedMemberships || []) {
      groupCounts.set(m.group_id, (groupCounts.get(m.group_id) || 0) + 1);
    }
    if ([...groupCounts.values()].some((count) => count === 3)) continue;

    const { data: newGroup, error: createErr } = await supabase
      .from('global_community_groups')
      .insert({
        name: 'Your Match Circle',
        description: 'Auto-created for a group of mutually connected matches.',
        is_public: false,
        created_by: VITANA_BOT_USER_ID,
      })
      .select('id, name')
      .single();
    if (createErr || !newGroup) continue;

    await supabase.from('global_community_group_members').insert(
      [userA, userB, userC].map((user_id) => ({ group_id: newGroup.id, user_id, role: 'member' }))
    );

    for (const user_id of [userA, userB, userC]) {
      ctx.notify(user_id, 'group_recommended', {
        title: 'A group just for your circle',
        body: 'We created a private group for you and two mutual connections.',
        data: { url: `/community/groups/${newGroup.id}`, group_id: newGroup.id },
      });
      usersAffected++;
      actionsTaken++;
    }

    groupsCreated++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.community.match_cluster_groups_created', { groups_created: groupsCreated });

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
  registerHandler('runAutoCreateGroupFromInterestCluster', runAutoCreateGroupFromInterestCluster);
  registerHandler('runAutoSuggestMeetupFromGroupActivity', runAutoSuggestMeetupFromGroupActivity);
  registerHandler('runGroupHealthMonitor', runGroupHealthMonitor);
  registerHandler('runCrossGroupIntroduction', runCrossGroupIntroduction);
  registerHandler('runGroupCreationFromMatchCluster', runGroupCreationFromMatchCluster);
}
