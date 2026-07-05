/**
 * Personalization Engines Handlers — AP-0800 series
 *
 * VTID: VTID-01250
 * Automations that tailor tone, timing, and content of other automations'
 * notifications to an individual user's social comfort, taste, life stage,
 * and notification load.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-0801: Social Comfort-Aware Suggestions ───────────────
// No 'social.suggestion.requested'-style event is ever dispatched (same gap
// pattern as AP-0403/AP-0605) — implemented as a heartbeat scan instead.
// Connection count (relationship_edges, edge_type='connected') is used as a
// comfort proxy: low-connection users get a low-stakes suggestion (join a
// group), well-connected users get a higher-stakes one (host a live room).
const SOCIAL_COMFORT_LOW_THRESHOLD = 3;
const SOCIAL_COMFORT_COOLDOWN_DAYS = 14;
const SOCIAL_COMFORT_MAX_USERS_PER_RUN = 500;

async function runSocialComfortAwareSuggestions(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = (await ctx.queryTargetUsers()).slice(0, SOCIAL_COMFORT_MAX_USERS_PER_RUN);
  const cooldownCutoff = new Date(Date.now() - SOCIAL_COMFORT_COOLDOWN_DAYS * 86_400_000).toISOString();

  for (const { user_id } of users) {
    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', user_id)
      .contains('data', { automation_id: 'AP-0801' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    const { count: connectionCount } = await supabase
      .from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('source_type', 'person')
      .eq('source_id', user_id)
      .eq('target_type', 'person')
      .eq('edge_type', 'connected');

    const isLowComfort = (connectionCount || 0) < SOCIAL_COMFORT_LOW_THRESHOLD;

    ctx.notify(user_id, 'orb_suggestion', {
      title: isLowComfort ? 'Find Your People' : 'Ready for the Spotlight?',
      body: isLowComfort
        ? 'Joining a small community group is a low-pressure way to meet people who share your interests.'
        : 'You\'ve built a strong network — consider hosting a Live Room to share something with your community.',
      data: { url: isLowComfort ? '/community/groups' : '/live/create', automation_id: 'AP-0801' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0802: Taste-Aligned Event Recommendations ────────────
// No dispatch site for a 'taste.profile.updated'-style event exists —
// implemented as a heartbeat scan matching user_interests against
// global_community_events.event_type (the closest live proxy for a topic/
// category column on that table).
const TASTE_EVENT_LOOKAHEAD_DAYS = 14;
const TASTE_SUGGESTION_COOLDOWN_DAYS = 7;
const TASTE_MAX_USERS_PER_RUN = 500;

async function runTasteAlignedEventRecommendations(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const lookahead = new Date(now.getTime() + TASTE_EVENT_LOOKAHEAD_DAYS * 86_400_000);

  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title, event_type, start_time')
    .gte('start_time', now.toISOString())
    .lte('start_time', lookahead.toISOString())
    .not('event_type', 'is', null)
    .limit(100);

  if (!events?.length) return { usersAffected: 0, actionsTaken: 0 };

  const users = (await ctx.queryTargetUsers()).slice(0, TASTE_MAX_USERS_PER_RUN);
  const cooldownCutoff = new Date(now.getTime() - TASTE_SUGGESTION_COOLDOWN_DAYS * 86_400_000).toISOString();

  for (const { user_id } of users) {
    const { data: interests } = await supabase
      .from('user_interests')
      .select('interest')
      .eq('user_id', user_id)
      .order('confidence_score', { ascending: false })
      .limit(10);
    const interestSet = new Set((interests || []).map((i: any) => (i.interest || '').toLowerCase()));
    if (interestSet.size === 0) continue;

    const match = events.find((e: any) => interestSet.has((e.event_type || '').toLowerCase()));
    if (!match) continue;

    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', user_id)
      .contains('data', { automation_id: 'AP-0802' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'An Event Matching Your Interests',
      body: `"${match.title}" lines up with what you're into — worth a look.`,
      data: { url: `/community/events/${match.id}`, event_id: match.id, automation_id: 'AP-0802' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0803: Opportunity Surfacing Automation ───────────────
// contextual_opportunities (D48, VTID-01142) is the live table. Reminds
// users of active, un-engaged opportunities before they expire.
const OPPORTUNITY_EXPIRY_WINDOW_HOURS = 24;
const OPPORTUNITY_MAX_PER_RUN = 200;

async function runOpportunitySurfacingAutomation(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const soon = new Date(now.getTime() + OPPORTUNITY_EXPIRY_WINDOW_HOURS * 3_600_000);

  const { data: opportunities } = await supabase
    .from('contextual_opportunities')
    .select('id, user_id, title, why_now, expires_at')
    .eq('tenant_id', tenantId)
    .is('dismissed_at', null)
    .is('engaged_at', null)
    .not('expires_at', 'is', null)
    .gte('expires_at', now.toISOString())
    .lte('expires_at', soon.toISOString())
    .limit(OPPORTUNITY_MAX_PER_RUN);

  for (const opp of opportunities || []) {
    ctx.notify(opp.user_id, 'orb_suggestion', {
      title: opp.title || 'An Opportunity Is Expiring Soon',
      body: opp.why_now || 'Take a look before it expires.',
      data: { url: '/orb', opportunity_id: opp.id },
    });
    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0804: Life-Stage Aware Communication ─────────────────
// app_users.lifecycle_stage ('onboarding' | 'early' | 'established' |
// 'mature', per types/conversation.ts) is a real column already read by
// discover-feed personalization — currently unpopulated for any live user,
// so this is a no-op today, but reacts correctly once that pipeline writes
// it. No dispatch event exists for stage transitions, so implemented as a
// weekly heartbeat instead.
async function runLifeStageAwareCommunication(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = await ctx.queryTargetUsers();

  for (const { user_id } of users) {
    const { data: user } = await supabase
      .from('app_users')
      .select('lifecycle_stage')
      .eq('user_id', user_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!user?.lifecycle_stage) continue;

    let title = '';
    let body = '';
    if (user.lifecycle_stage === 'onboarding') {
      title = 'Getting Started';
      body = 'Take it one step at a time — your ORB is here to help you find your footing.';
    } else if (user.lifecycle_stage === 'early') {
      title = 'You\'re Off to a Good Start';
      body = 'Try exploring a Community Group or Live Room this week to build momentum.';
    } else if (user.lifecycle_stage === 'established') {
      title = 'Deepen Your Vitana Experience';
      body = 'You know your way around — have you tried the advanced ORB features yet?';
    } else if (user.lifecycle_stage === 'mature') {
      title = 'Thanks for Being Part of Vitana';
      body = 'Your experience helps others — consider hosting or mentoring in a group you love.';
    } else {
      continue;
    }

    ctx.notify(user_id, 'orb_suggestion', {
      title, body,
      data: { url: '/orb', lifecycle_stage: user.lifecycle_stage },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0805: Overload Detection & Throttle ──────────────────
// Shares the 'automation.pre_execute' topic with AP-0613/AP-0904 (multiple
// automations may key off one topic). Counts real user_notifications sent
// in the last 24h and flags the caller to suppress non-critical sends when
// a user is already saturated.
const OVERLOAD_MAX_NOTIFICATIONS_PER_DAY = 8;

async function runOverloadDetectionThrottle(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase } = ctx;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count } = await supabase
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', oneDayAgo);

  const isOverloaded = (count || 0) >= OVERLOAD_MAX_NOTIFICATIONS_PER_DAY;

  ctx.run.metadata = {
    ...ctx.run.metadata,
    overload_throttled: isOverloaded,
    notifications_last_24h: count || 0,
  };

  if (isOverloaded) {
    ctx.log(`User ${userId.slice(0, 8)}… is overloaded (${count} notifications/24h) — flagging for throttle`);
  }

  return { usersAffected: 1, actionsTaken: 0 };
}

export function registerPersonalizationEnginesHandlers(): void {
  registerHandler('runSocialComfortAwareSuggestions', runSocialComfortAwareSuggestions);
  registerHandler('runTasteAlignedEventRecommendations', runTasteAlignedEventRecommendations);
  registerHandler('runOpportunitySurfacingAutomation', runOpportunitySurfacingAutomation);
  registerHandler('runLifeStageAwareCommunication', runLifeStageAwareCommunication);
  registerHandler('runOverloadDetectionThrottle', runOverloadDetectionThrottle);
}
