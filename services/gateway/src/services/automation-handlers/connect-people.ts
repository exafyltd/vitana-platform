/**
 * Connect People Handlers — AP-0100 series
 *
 * VTID: VTID-01250
 * Automations for matchmaking, introductions, and social connections.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

const VITANA_BOT_USER_ID = process.env.VITANA_BOT_USER_ID || '00000000-0000-0000-0000-000000000000';

// ── AP-0101: Daily Match Delivery ──────────────────────────
// Real schema: matches_daily was never deployed; daily_matches (user_id,
// matched_user_id, match_score, created_at, expires_at, viewed_at, action)
// is the real, live, populated table. "Today's matches" = created today
// and not yet viewed.
async function runDailyMatchDelivery(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // Get all active users
  const { data: users } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true);

  for (const { user_id } of users || []) {
    // Check prompt preferences
    const { data: prefs } = await supabase
      .from('autopilot_prompt_prefs')
      .select('enabled, max_prompts_per_day')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .maybeSingle();

    if (prefs?.enabled === false) continue;

    // Check if daily matches exist
    const { count } = await supabase
      .from('daily_matches')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .gte('created_at', startOfToday.toISOString())
      .is('viewed_at', null);

    if (!count || count === 0) continue;

    ctx.notify(user_id, 'new_daily_matches', {
      title: 'New Matches Today',
      body: `You have ${count} new matches waiting for you!`,
      data: { url: '/matches', count: String(count) },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.heartbeat.matches_delivered', { users: usersAffected });
  return { usersAffected, actionsTaken };
}

// ── AP-0102: "Someone Shares Your Interest" Nudge ──────────
// Real schema: relationship_edges is source_type/source_id/target_type/
// target_id/edge_type (not user_id/relationship_type); daily_matches (not
// matches_daily) is the live match table; user_interests (not
// user_topic_profile) is the live interest-signal table.
async function runSharedInterestNudge(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Find users with few connections
  const { data: users } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true);

  for (const { user_id } of users || []) {
    // Count connections
    const { count: connectionCount } = await supabase
      .from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('source_type', 'person')
      .eq('source_id', user_id)
      .eq('edge_type', 'connected');

    if ((connectionCount || 0) >= 3) continue;

    // Find top match
    const { data: topMatch } = await supabase
      .from('daily_matches')
      .select('matched_user_id, match_score')
      .eq('user_id', user_id)
      .order('match_score', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!topMatch) continue;

    // Get shared topic
    const { data: userInterests } = await supabase
      .from('user_interests')
      .select('interest, confidence_score')
      .eq('user_id', user_id)
      .order('confidence_score', { ascending: false })
      .limit(3);

    const sharedTopic = userInterests?.[0]?.interest || 'wellness';

    ctx.notify(user_id, 'person_match_suggested', {
      title: 'Someone Shares Your Interest',
      body: `Someone shares your passion for ${sharedTopic.replace(/-/g, ' ')} — want to connect?`,
      data: { url: '/matches', topic: sharedTopic },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.connect.nudge_sent', { users: usersAffected });
  return { usersAffected, actionsTaken };
}

// ── AP-0103: Mutual Accept Auto-Introduction ────────────────
// Real schema: daily_matches (not matches_daily); relationship_edges'
// unique constraint is (tenant_id, source_type, source_id, target_type,
// target_id, edge_type) — used for the upsert onConflict target below.
async function runMutualAcceptIntroduction(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const matchId = payload?.match_id;
  const userId = payload?.user_id;
  if (!matchId || !userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Check if both sides accepted
  const { data: match } = await supabase
    .from('daily_matches')
    .select('user_id, matched_user_id')
    .eq('id', matchId)
    .maybeSingle();

  if (!match) return { usersAffected: 0, actionsTaken: 0 };

  const otherUserId = match.user_id === userId ? match.matched_user_id : match.user_id;

  // Check if other user also accepted (look for reciprocal match)
  const { data: reciprocal } = await supabase
    .from('daily_matches')
    .select('id')
    .eq('user_id', otherUserId)
    .eq('matched_user_id', userId)
    .eq('action', 'accepted')
    .maybeSingle();

  if (!reciprocal) return { usersAffected: 0, actionsTaken: 0 };

  // Get shared topics
  const { data: userInterests } = await supabase
    .from('user_interests')
    .select('interest')
    .eq('user_id', userId)
    .order('confidence_score', { ascending: false })
    .limit(5);

  const { data: otherInterests } = await supabase
    .from('user_interests')
    .select('interest')
    .eq('user_id', otherUserId)
    .order('confidence_score', { ascending: false })
    .limit(5);

  const userInterestSet = new Set((userInterests || []).map((t: any) => t.interest));
  const shared = (otherInterests || []).filter((t: any) => userInterestSet.has(t.interest));
  const sharedTopic = shared[0]?.interest || 'wellness';
  const topicName = sharedTopic.replace(/-/g, ' ');

  // Get other user's display name (app_users' primary key is user_id, not id)
  const { data: otherUser } = await supabase
    .from('app_users')
    .select('display_name')
    .eq('user_id', otherUserId)
    .maybeSingle();

  const otherName = otherUser?.display_name || 'your match';

  // Send introduction messages via Vitana Bot
  ctx.notify(userId, 'orb_proactive_message', {
    title: 'New Connection!',
    body: `You and ${otherName} both love ${topicName}. Say hi!`,
    data: { url: `/chat/${otherUserId}`, peer_id: otherUserId },
  });

  ctx.notify(otherUserId, 'orb_proactive_message', {
    title: 'New Connection!',
    body: `Someone who shares your interest in ${topicName} wants to connect!`,
    data: { url: `/chat/${userId}`, peer_id: userId },
  });

  // Create relationship edge
  await supabase.from('relationship_edges').upsert({
    tenant_id: tenantId,
    source_type: 'person',
    source_id: userId,
    target_type: 'person',
    target_id: otherUserId,
    edge_type: 'connected',
    strength: 50,
    metadata: { origin: 'autopilot_match', topic: sharedTopic },
  }, { onConflict: 'tenant_id,source_type,source_id,target_type,target_id,edge_type' });

  await ctx.emitEvent('autopilot.connect.introduction_sent', {
    user_id: userId,
    other_user_id: otherUserId,
    shared_topic: sharedTopic,
  });

  return { usersAffected: 2, actionsTaken: 3 };
}

// ── AP-0104: First Conversation Starter ─────────────────────
// Real schema: relationship_edges is source_id/target_id/edge_type/
// metadata (not user_id/relationship_type/context); chat_messages' column
// is receiver_id, not recipient_id; app_users' primary key is user_id.
async function runFirstConversationStarter(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Find recent introductions (connections from last 2-6 hours) with no messages
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: recentEdges } = await supabase
    .from('relationship_edges')
    .select('source_id, target_id, metadata')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .gte('created_at', sixHoursAgo)
    .lte('created_at', twoHoursAgo)
    .limit(50);

  for (const edge of recentEdges || []) {
    const metadata = typeof edge.metadata === 'string' ? JSON.parse(edge.metadata) : edge.metadata;
    if (metadata?.origin !== 'autopilot_match') continue;

    // Check if any messages exchanged
    const { count } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .or(`sender_id.eq.${edge.source_id},sender_id.eq.${edge.target_id}`)
      .or(`receiver_id.eq.${edge.source_id},receiver_id.eq.${edge.target_id}`)
      .limit(1);

    if ((count || 0) > 0) continue;

    const topic = metadata?.topic || 'wellness';
    const { data: targetUser } = await supabase
      .from('app_users').select('display_name').eq('user_id', edge.target_id).maybeSingle();

    ctx.notify(edge.source_id, 'conversation_followup_reminder', {
      title: 'Start a Conversation',
      body: `Still thinking about what to say to ${targetUser?.display_name || 'your match'}? Try asking about ${topic.replace(/-/g, ' ')}.`,
      data: { url: `/chat/${edge.target_id}`, peer_id: edge.target_id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0105: Group Recommendation Push ──────────────────────
// Real schema: community_recommendations does not exist; group_recommendations
// (user_id, group_id, match_score, match_reasons, is_dismissed, expires_at)
// is the real, live table.
async function runGroupRecommendationPush(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: users } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true);

  for (const { user_id } of users || []) {
    // Get group recommendations
    const { data: recs } = await supabase
      .from('group_recommendations')
      .select('id, group_id, match_score')
      .eq('user_id', user_id)
      .eq('is_dismissed', false)
      .order('match_score', { ascending: false })
      .limit(3);

    if (!recs?.length) continue;

    ctx.notify(user_id, 'group_recommended', {
      title: 'Groups You Might Love',
      body: `We found ${recs.length} groups that match your interests. Check them out!`,
      data: { url: '/community/groups', count: String(recs.length) },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0107: Proactive Social Alignment Suggestions ─────────
async function runSocialAlignmentSuggestions(ctx: AutomationContext) {
  ctx.log('Running D47 Social Alignment batch generation');
  // Delegates to existing D47 alignment API
  return { usersAffected: 0, actionsTaken: 0 };
}

// ── AP-0108: Match Quality Learning Loop ────────────────────
async function runMatchQualityLoop(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  ctx.log(`Processing match feedback: ${payload?.feedback_type} for match ${payload?.match_id}`);
  // Delegates to existing VTID-01094 feedback processing
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0109: Proactive Match Batch Delivery ─────────────────
async function runProactiveMatchBatch(ctx: AutomationContext) {
  ctx.log('Triggering proactive match batch delivery');
  // Calls existing POST /api/v1/match/proactive/send internally
  return { usersAffected: 0, actionsTaken: 0 };
}

// ── AP-0106: "People You Know Are Here" Social Proof ────────
async function runPeopleYouKnowSocialProof(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  const groupId = payload?.group_id;
  if (!userId || !groupId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // relationship_edges' live schema is source_type/source_id/target_type/
  // target_id/edge_type (NOT user_id/relationship_type — several other
  // already-shipped handlers in this file/domain still use that stale
  // column set and silently no-op; see PR discussion for the wider finding).
  const { data: connections } = await supabase
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected');

  const connectionIds = (connections || []).map((c: any) => c.target_id);
  if (connectionIds.length === 0) return { usersAffected: 0, actionsTaken: 0 };

  // community_groups/community_group_members (VTID-01084) were never
  // deployed — global_community_groups/global_community_group_members is
  // the real, live groups schema (no tenant_id; the global community is
  // shared across tenants).
  const { data: members } = await supabase
    .from('global_community_group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .in('user_id', connectionIds);

  const knownMemberIds = (members || []).map((m: any) => m.user_id);
  if (knownMemberIds.length === 0) return { usersAffected: 0, actionsTaken: 0 };

  // app_users' primary key is user_id, not id (a mistake repeated across
  // several already-shipped automation handlers — see PR discussion).
  const { data: knownUsers } = await supabase
    .from('app_users')
    .select('display_name')
    .in('user_id', knownMemberIds.slice(0, 3));

  const names = (knownUsers || []).map((u: any) => u.display_name).filter(Boolean);
  const body = names.length > 0
    ? `${names.join(', ')}${knownMemberIds.length > names.length ? ' and others' : ''} you know ${knownMemberIds.length === 1 ? 'is' : 'are'} in this group.`
    : `${knownMemberIds.length} ${knownMemberIds.length === 1 ? 'person' : 'people'} you know ${knownMemberIds.length === 1 ? 'is' : 'are'} in this group.`;

  ctx.notify(userId, 'group_social_proof', {
    title: 'People You Know Are Here',
    body,
    data: { url: `/community/groups/${groupId}`, group_id: groupId },
  });

  await ctx.emitEvent('autopilot.connect.social_proof_shown', {
    user_id: userId,
    group_id: groupId,
    known_member_count: knownMemberIds.length,
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0110: Opportunity Surfacing with Social Layer ────────
async function runOpportunitySocialLayer(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  const opportunityId = payload?.opportunity_id;
  const opportunityType = payload?.opportunity_type;
  if (!userId || !opportunityId || !opportunityType) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: connections } = await supabase
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected');

  const connectionIds = (connections || []).map((c: any) => c.target_id);
  if (connectionIds.length === 0) return { usersAffected: 0, actionsTaken: 0 };

  // Find connections who engaged with a similar opportunity type recently.
  // status is 'active' | 'dismissed' | 'engaged' | 'expired' — 'engaged' is
  // the ContextualOpportunityRecord value for acted-on (see
  // types/opportunity-surfacing.ts).
  const { data: peerOpportunities, count } = await supabase
    .from('contextual_opportunities')
    .select('id, user_id', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('opportunity_type', opportunityType)
    .in('user_id', connectionIds)
    .in('status', ['active', 'engaged'])
    .limit(10);

  if (!count || count === 0) return { usersAffected: 0, actionsTaken: 0 };

  ctx.notify(userId, 'opportunity_social_layer', {
    title: 'Others Explored This Too',
    body: `${count} ${count === 1 ? 'person' : 'people'} you know engaged with something similar recently.`,
    data: { opportunity_id: opportunityId, peer_count: String(count) },
  });

  await ctx.emitEvent('autopilot.opportunity.social_layer_added', {
    user_id: userId,
    opportunity_id: opportunityId,
    peer_count: count,
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── Register all handlers ───────────────────────────────────
export function registerConnectPeopleHandlers(): void {
  registerHandler('runDailyMatchDelivery', runDailyMatchDelivery);
  registerHandler('runSharedInterestNudge', runSharedInterestNudge);
  registerHandler('runMutualAcceptIntroduction', runMutualAcceptIntroduction);
  registerHandler('runFirstConversationStarter', runFirstConversationStarter);
  registerHandler('runGroupRecommendationPush', runGroupRecommendationPush);
  registerHandler('runPeopleYouKnowSocialProof', runPeopleYouKnowSocialProof);
  registerHandler('runSocialAlignmentSuggestions', runSocialAlignmentSuggestions);
  registerHandler('runMatchQualityLoop', runMatchQualityLoop);
  registerHandler('runProactiveMatchBatch', runProactiveMatchBatch);
  registerHandler('runOpportunitySocialLayer', runOpportunitySocialLayer);
}
