/**
 * BOOTSTRAP-SOCIAL-MEMORY — Social Context Pack assembly.
 *
 * Parallel-fetches the user's live community picture and runs the
 * explainable rankers. Sections degrade independently (a failing stream
 * is recorded in meta.degraded_sections, never throws) — same resilience
 * contract as the memory orchestrator.
 */

import { getSupabase } from '../../lib/supabase';
import {
  SocialContextPack,
  BuildSocialContextInput,
  RecommendedAction,
  RelationshipSummary,
} from './social-memory-types';
import {
  fetchExclusions,
  fetchFollowEdges,
  fetchMatches,
  fetchRecentMessageContacts,
  fetchGroupChats,
  fetchCandidatePosts,
  fetchUpcomingEvents,
  fetchEventParticipants,
  fetchGroupsForUsers,
  fetchInterests,
  fetchPersonById,
} from './social-memory-repository';
import {
  rankInterestingPosts,
  rankInterestingEvents,
  extractTerms,
  buildMatchScoreMap,
} from './social-memory-ranker';
import { fetchPeople } from './social-memory-repository';
import { buildPersonContext } from './person-context-builder';
import { buildPersonActivity, buildNetworkDigest } from './community-activity-builder';
import { detectSocialIntent, buildAssistantSystemHints } from './social-memory-prompts';

async function settle<T>(
  label: string,
  p: Promise<T>,
  fallback: T,
  degraded: string[],
): Promise<T> {
  try {
    return await p;
  } catch (err: any) {
    console.warn(`[SOCIAL-MEMORY] section ${label} degraded: ${err?.message}`);
    degraded.push(label);
    return fallback;
  }
}

export async function buildSocialContextPack(
  input: BuildSocialContextInput,
): Promise<SocialContextPack> {
  const startTime = Date.now();
  const degraded: string[] = [];
  const sections: string[] = [];
  const compact = input.compact === true;
  const intent = input.intent ?? detectSocialIntent(input.question || '');

  // Exclusions first — every other section depends on them.
  const excl = await settle(
    'exclusions',
    fetchExclusions(input.user_id),
    { blocked: new Set<string>(), muted: new Set<string>(), hidden_posts: new Set<string>() },
    degraded,
  );

  const [user, follows, matches, messages, groupChats] = await Promise.all([
    settle('user', fetchPersonById(input.user_id), null, degraded),
    settle(
      'follows',
      fetchFollowEdges(input.user_id, excl.blocked, compact ? 20 : 50),
      { following: [], followers: [] },
      degraded,
    ),
    settle('matches', fetchMatches(input.user_id, excl.blocked, compact ? 10 : 20), [], degraded),
    settle(
      'messages',
      fetchRecentMessageContacts(input.user_id, input.tenant_id, excl.blocked, compact ? 8 : 15),
      [],
      degraded,
    ),
    settle('group_chats', fetchGroupChats(input.user_id, input.tenant_id), [], degraded),
  ]);
  sections.push('relationships', 'matches', 'messages', 'group_chats');

  const followingIds = follows.following.map((f) => f.person.user_id);
  const followerIds = new Set(follows.followers.map((f) => f.person.user_id));
  const relationships: RelationshipSummary = {
    following: follows.following,
    followers: follows.followers,
    following_count: follows.following.length,
    followers_count: follows.followers.length,
    mutual_ids: followingIds.filter((id) => followerIds.has(id)),
  };

  // Ranking signals: interests, goal terms, shared groups, location.
  const matchScores = buildMatchScoreMap(matches);
  const importantIds = Array.from(
    new Set([...followingIds, ...matches.map((m) => m.person.user_id)]),
  );

  const [interestsMap, groupsMap, goalTerms] = await Promise.all([
    settle('interests', fetchInterests([input.user_id]), new Map(), degraded),
    settle(
      'shared_groups',
      fetchGroupsForUsers([input.user_id, ...importantIds.slice(0, 30)]),
      new Map(),
      degraded,
    ),
    settle('goal_terms', fetchGoalTerms(input.user_id), [] as string[], degraded),
  ]);

  const myInterests = interestsMap.get(input.user_id) || [];
  const myGroups = groupsMap.get(input.user_id) || new Set<string>();
  const sharedGroupCounts = new Map<string, number>();
  for (const [uid, set] of groupsMap) {
    if (uid === input.user_id) continue;
    let n = 0;
    for (const g of set) if (myGroups.has(g)) n++;
    if (n > 0) sharedGroupCounts.set(uid, n);
  }
  const locationTerms = [user?.city, user?.country]
    .filter((x): x is string => !!x)
    .map((x) => x.toLowerCase());

  // Posts + events with explainable ranking.
  const [candidatePosts, upcomingEvents] = await Promise.all([
    settle(
      'posts',
      fetchCandidatePosts(input.user_id, followingIds, excl, compact ? 25 : 40),
      [],
      degraded,
    ),
    settle('events', fetchUpcomingEvents(compact ? 25 : 40), [], degraded),
  ]);
  const participants = await settle(
    'event_participants',
    fetchEventParticipants(upcomingEvents.map((e) => e.id)),
    new Map(),
    degraded,
  );

  const authorIds = Array.from(new Set(candidatePosts.map((p) => p.user_id)));
  const attendeeIds = Array.from(new Set(Array.from(participants.values()).flat())).slice(0, 100);
  const people = await settle(
    'people',
    fetchPeople([...authorIds, ...attendeeIds]),
    new Map(),
    degraded,
  );

  const followedSet = new Set(followingIds);
  const interestingPosts = rankInterestingPosts(
    candidatePosts,
    {
      viewer_id: input.user_id,
      followed_ids: followedSet,
      match_scores: matchScores,
      interests: myInterests,
      goal_terms: goalTerms,
      shared_group_counts: sharedGroupCounts,
      people,
    },
    compact ? 5 : 8,
  );
  const interestingEvents = rankInterestingEvents(
    upcomingEvents,
    {
      viewer_id: input.user_id,
      followed_ids: followedSet,
      match_scores: matchScores,
      interests: myInterests,
      goal_terms: goalTerms,
      location_terms: locationTerms,
      participants,
      people,
    },
    compact ? 4 : 6,
  );
  sections.push('interesting_posts', 'interesting_events');

  // Person / activity context only when the question calls for it.
  let personContext = null;
  let activityContext = null;
  if (input.person_id || intent.person_hint) {
    personContext = await settle(
      'person_context',
      buildPersonContext({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        person_id: input.person_id,
        person_hint: intent.person_hint ?? undefined,
      }),
      null,
      degraded,
    );
    sections.push('person_context');
    if (personContext && intent.kinds.includes('person_activity')) {
      activityContext = await settle(
        'activity_context',
        buildPersonActivity(personContext.person.user_id),
        null,
        degraded,
      );
      sections.push('activity_context');
    }
  }
  if (!activityContext && intent.kinds.includes('community_changes')) {
    activityContext = await settle(
      'activity_context',
      buildNetworkDigest(importantIds, excl.blocked),
      null,
      degraded,
    );
    sections.push('activity_context');
  }

  const recommendedActions = buildRecommendedActions({
    relationships,
    matches,
    messages,
    interestingEvents,
    personContext,
  });

  const pack: SocialContextPack = {
    user,
    relationships,
    matches,
    messages,
    group_chats: groupChats,
    interesting_posts: interestingPosts,
    interesting_events: interestingEvents,
    person_context: personContext,
    activity_context: activityContext,
    memory_highlights: [],
    recommended_actions: recommendedActions,
    assistant_system_hints: [],
    meta: {
      built_at: new Date().toISOString(),
      latency_ms: Date.now() - startTime,
      sections_loaded: sections,
      degraded_sections: degraded,
      privacy_filters_applied: [
        'blocked_authors',
        'muted_authors',
        'hidden_posts',
        'public_posts_only',
        'private_profile_minimization',
        'own_conversations_only',
        'tenant_scope',
      ],
    },
  };
  pack.assistant_system_hints = buildAssistantSystemHints(pack);
  return pack;
}

/** Life Compass goal words for topical boosts (reuses the canonical read). */
async function fetchGoalTerms(userId: string): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('life_compass')
    .select('primary_goal, category')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  const goal = data?.[0];
  if (!goal) return [];
  return extractTerms(`${goal.primary_goal} ${goal.category}`);
}

function buildRecommendedActions(x: {
  relationships: RelationshipSummary;
  matches: SocialContextPack['matches'];
  messages: SocialContextPack['messages'];
  interestingEvents: SocialContextPack['interesting_events'];
  personContext: SocialContextPack['person_context'];
}): RecommendedAction[] {
  const actions: RecommendedAction[] = [];

  if (x.personContext?.recommended_next_action) {
    actions.push({
      action: x.personContext.recommended_next_action,
      reason: `About ${x.personContext.person.display_name || 'this member'}`,
      route: `/profile/${x.personContext.person.user_id}`,
    });
  }

  const untouchedMatch = x.matches.find(
    (m) => m.is_current && !m.conversation_started && m.action !== 'rejected',
  );
  if (untouchedMatch) {
    actions.push({
      action: `Say hello to ${untouchedMatch.person.display_name || 'your newest match'}`,
      reason: untouchedMatch.reasons[0] || `Match score ${untouchedMatch.score ?? ''}`.trim(),
      route: '/matches',
    });
  }

  const topEvent = x.interestingEvents[0];
  if (topEvent && topEvent.score >= 30) {
    actions.push({
      action: `Check out "${topEvent.title}"`,
      reason: topEvent.reason[0] || 'Recommended event',
      route: topEvent.url,
    });
  }

  const staleContact = x.messages.find(
    (m) => Date.now() - Date.parse(m.last_message_at) > 7 * 86400000,
  );
  if (staleContact && actions.length < 3) {
    actions.push({
      action: `Reconnect with ${staleContact.person.display_name || 'a recent contact'}`,
      reason: 'Your last exchange was over a week ago',
      route: `/messages/${staleContact.person.user_id}`,
    });
  }

  if (actions.length === 0 && x.relationships.following_count === 0) {
    actions.push({
      action: 'Follow a few members to build your community feed',
      reason: 'You are not following anyone yet',
      route: '/community',
    });
  }
  return actions.slice(0, 3);
}
