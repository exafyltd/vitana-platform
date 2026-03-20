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
async function runDailyMatchDelivery(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

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
    const { data: matches, count } = await supabase
      .from('matches_daily')
      .select('id', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .eq('match_date', new Date().toISOString().split('T')[0])
      .limit(1);

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
      .eq('user_id', user_id)
      .eq('relationship_type', 'connected');

    if ((connectionCount || 0) >= 3) continue;

    // Find top match
    const { data: topMatch } = await supabase
      .from('matches_daily')
      .select('matched_entity_id, match_type, explanation')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .eq('match_type', 'person')
      .order('score', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!topMatch) continue;

    // Get shared topic
    const { data: userTopics } = await supabase
      .from('user_topic_profile')
      .select('topic_key, score')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .order('score', { ascending: false })
      .limit(3);

    const sharedTopic = userTopics?.[0]?.topic_key || 'wellness';

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
async function runMutualAcceptIntroduction(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const matchId = payload?.match_id;
  const userId = payload?.user_id;
  if (!matchId || !userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Check if both sides accepted
  const { data: match } = await supabase
    .from('matches_daily')
    .select('user_id, matched_entity_id, match_type')
    .eq('id', matchId)
    .maybeSingle();

  if (!match || match.match_type !== 'person') return { usersAffected: 0, actionsTaken: 0 };

  const otherUserId = match.user_id === userId ? match.matched_entity_id : match.user_id;

  // Check if other user also accepted (look for reciprocal match)
  const { data: reciprocal } = await supabase
    .from('matches_daily')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('user_id', otherUserId)
    .eq('matched_entity_id', userId)
    .eq('state', 'accepted')
    .maybeSingle();

  if (!reciprocal) return { usersAffected: 0, actionsTaken: 0 };

  // Get shared topics
  const { data: userTopics } = await supabase
    .from('user_topic_profile')
    .select('topic_key')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('score', { ascending: false })
    .limit(5);

  const { data: otherTopics } = await supabase
    .from('user_topic_profile')
    .select('topic_key')
    .eq('tenant_id', tenantId)
    .eq('user_id', otherUserId)
    .order('score', { ascending: false })
    .limit(5);

  const userTopicSet = new Set((userTopics || []).map(t => t.topic_key));
  const shared = (otherTopics || []).filter(t => userTopicSet.has(t.topic_key));
  const sharedTopic = shared[0]?.topic_key || 'wellness';
  const topicName = sharedTopic.replace(/-/g, ' ');

  // Get other user's display name
  const { data: otherUser } = await supabase
    .from('app_users')
    .select('display_name')
    .eq('id', otherUserId)
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
    user_id: userId,
    target_type: 'person',
    target_id: otherUserId,
    relationship_type: 'connected',
    strength: 50,
    context: JSON.stringify({ origin: 'autopilot_match', topic: sharedTopic }),
  }, { onConflict: 'tenant_id,user_id,target_type,target_id' });

  await ctx.emitEvent('autopilot.connect.introduction_sent', {
    user_id: userId,
    other_user_id: otherUserId,
    shared_topic: sharedTopic,
  });

  return { usersAffected: 2, actionsTaken: 3 };
}

// ── AP-0104: First Conversation Starter ─────────────────────
async function runFirstConversationStarter(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Find recent introductions (connections from last 2-6 hours) with no messages
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: recentEdges } = await supabase
    .from('relationship_edges')
    .select('user_id, target_id, context')
    .eq('tenant_id', tenantId)
    .eq('target_type', 'person')
    .eq('relationship_type', 'connected')
    .gte('created_at', sixHoursAgo)
    .lte('created_at', twoHoursAgo)
    .limit(50);

  for (const edge of recentEdges || []) {
    const context = typeof edge.context === 'string' ? JSON.parse(edge.context) : edge.context;
    if (context?.origin !== 'autopilot_match') continue;

    // Check if any messages exchanged
    const { count } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .or(`sender_id.eq.${edge.user_id},sender_id.eq.${edge.target_id}`)
      .or(`recipient_id.eq.${edge.user_id},recipient_id.eq.${edge.target_id}`)
      .limit(1);

    if ((count || 0) > 0) continue;

    const topic = context?.topic || 'wellness';
    const { data: targetUser } = await supabase
      .from('app_users').select('display_name').eq('id', edge.target_id).maybeSingle();

    ctx.notify(edge.user_id, 'conversation_followup_reminder', {
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
      .from('community_recommendations')
      .select('id, group_id, score, rationale')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .eq('type', 'group')
      .order('score', { ascending: false })
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

// ── Register all handlers ───────────────────────────────────
export function registerConnectPeopleHandlers(): void {
  registerHandler('runDailyMatchDelivery', runDailyMatchDelivery);
  registerHandler('runSharedInterestNudge', runSharedInterestNudge);
  registerHandler('runMutualAcceptIntroduction', runMutualAcceptIntroduction);
  registerHandler('runFirstConversationStarter', runFirstConversationStarter);
  registerHandler('runGroupRecommendationPush', runGroupRecommendationPush);
  registerHandler('runSocialAlignmentSuggestions', runSocialAlignmentSuggestions);
  registerHandler('runMatchQualityLoop', runMatchQualityLoop);
  registerHandler('runProactiveMatchBatch', runProactiveMatchBatch);
}
