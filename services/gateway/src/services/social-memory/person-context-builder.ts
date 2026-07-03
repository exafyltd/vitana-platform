/**
 * BOOTSTRAP-SOCIAL-MEMORY — Person Intelligence.
 *
 * For "tell me about X" / "why is X a good match" questions: assembles a
 * complete, privacy-gated picture of one person relative to the viewer —
 * relationship flags, match score + reasons, shared interests/groups/
 * events, latest PUBLIC posts, upcoming events, last chat, and a
 * recommended next action, plus a speech-ready relevance summary.
 *
 * Privacy: blocked people return null (as if not found). Private profiles
 * with no viewer relationship (no follow / match / chat) are data-minimized
 * to name-only with privacy_limited=true. Only public posts are ever read.
 */

import {
  PersonContext,
  MatchSummary,
  SocialPerson,
} from './social-memory-types';
import {
  fetchPersonById,
  resolvePersonByName,
  fetchFollowFlags,
  fetchMatches,
  fetchExclusions,
  fetchInterests,
  fetchGroupsForUsers,
  fetchEventsForUsers,
  fetchGroupNames,
  fetchEventTitles,
  fetchPersonPosts,
  fetchLastChatAt,
} from './social-memory-repository';

export interface BuildPersonContextInput {
  tenant_id: string;
  user_id: string;
  /** Either a concrete user_id... */
  person_id?: string;
  /** ...or a fuzzy name/handle hint extracted from the question. */
  person_hint?: string;
}

export async function buildPersonContext(
  input: BuildPersonContextInput,
): Promise<PersonContext | null> {
  // Resolve target
  let person: SocialPerson | null = null;
  if (input.person_id) {
    person = await fetchPersonById(input.person_id);
  } else if (input.person_hint) {
    person = await resolvePersonByName(input.person_hint);
  }
  if (!person || person.user_id === input.user_id) return null;

  const excl = await fetchExclusions(input.user_id);
  // Blocked people are treated as not found — the assistant must not
  // resurrect someone the user blocked.
  if (excl.blocked.has(person.user_id)) return null;

  const [flags, matches, interests, groups, events, posts, lastChatAt] = await Promise.all([
    fetchFollowFlags(input.user_id, person.user_id),
    fetchMatches(input.user_id, excl.blocked, 30),
    fetchInterests([input.user_id, person.user_id]),
    fetchGroupsForUsers([input.user_id, person.user_id]),
    fetchEventsForUsers([input.user_id, person.user_id]),
    fetchPersonPosts(person.user_id, 5),
    fetchLastChatAt(input.user_id, input.tenant_id, person.user_id),
  ]);

  const match: MatchSummary | null =
    matches.find((m) => m.person.user_id === person!.user_id) ?? null;

  const myInterests = new Set(interests.get(input.user_id) || []);
  const theirInterests = interests.get(person.user_id) || [];
  const sharedInterests = theirInterests.filter((i) => myInterests.has(i));

  const myGroups = groups.get(input.user_id) || new Set<string>();
  const theirGroups = groups.get(person.user_id) || new Set<string>();
  const sharedGroupIds = Array.from(theirGroups).filter((g) => myGroups.has(g));

  const myEvents = events.get(input.user_id) || new Set<string>();
  const theirEvents = events.get(person.user_id) || new Set<string>();
  const sharedEventIds = Array.from(theirEvents).filter((e) => myEvents.has(e));

  const [groupNames, eventTitles] = await Promise.all([
    fetchGroupNames(sharedGroupIds),
    fetchEventTitles(sharedEventIds),
  ]);

  // Privacy minimization: private profile + no relationship → name only.
  const hasRelationship =
    flags.you_follow || flags.follows_you || !!match || !!lastChatAt;
  const privacyLimited = person.visibility === 'private' && !hasRelationship;

  const latestPosts = privacyLimited
    ? []
    : posts.map((p) => ({
        post_id: p.id,
        snippet: (p.content || '').slice(0, 140),
        created_at: p.created_at,
        media_type: p.video_url ? 'video' : p.image_url ? 'image' : 'text',
      }));

  let upcomingEvents: Array<{ event_id: string; title: string; start_time: string }> = [];
  if (!privacyLimited) {
    const titles = await fetchEventTitles(Array.from(theirEvents).slice(0, 5));
    upcomingEvents = Array.from(titles.entries()).map(([event_id, title]) => ({
      event_id,
      title,
      start_time: '',
    }));
  }

  const nextAction = recommendNextAction({
    flags,
    match,
    lastChatAt,
    sharedGroups: sharedGroupIds.length,
    privacyLimited,
  });

  const context: PersonContext = {
    person: privacyLimited
      ? { ...person, bio: null, city: null, country: null }
      : person,
    you_follow: flags.you_follow,
    follows_you: flags.follows_you,
    match,
    shared_interests: privacyLimited ? [] : sharedInterests,
    shared_groups: Array.from(groupNames.values()),
    shared_events: Array.from(eventTitles.values()),
    latest_posts: latestPosts,
    upcoming_events: upcomingEvents,
    last_chat_at: lastChatAt,
    privacy_limited: privacyLimited,
    recommended_next_action: nextAction,
    relevance_summary: '',
  };
  context.relevance_summary = buildRelevanceSummary(context);
  return context;
}

function recommendNextAction(x: {
  flags: { you_follow: boolean; follows_you: boolean };
  match: MatchSummary | null;
  lastChatAt: string | null;
  sharedGroups: number;
  privacyLimited: boolean;
}): string | null {
  if (x.privacyLimited) return null;
  if (x.match && !x.match.conversation_started && !x.lastChatAt) {
    return 'Send a first message — you matched but never talked.';
  }
  if (x.lastChatAt) {
    const daysSince = (Date.now() - Date.parse(x.lastChatAt)) / 86400000;
    if (daysSince > 7) return 'Reconnect — your last chat was over a week ago.';
    return 'Continue your conversation.';
  }
  if (x.flags.follows_you && !x.flags.you_follow) {
    return 'They follow you — follow back or open their profile.';
  }
  if (x.flags.you_follow) return 'Open their profile to see their latest activity.';
  if (x.sharedGroups > 0) return 'Say hello in your shared group.';
  return 'Open their profile to learn more.';
}

/** One-paragraph, speech-ready relevance summary (English; the LLM localizes). */
export function buildRelevanceSummary(ctx: PersonContext): string {
  const name = ctx.person.display_name || ctx.person.handle || 'This member';
  if (ctx.privacy_limited) {
    return `${name} keeps their profile private, so only limited information is available.`;
  }
  const parts: string[] = [];
  if (ctx.you_follow && ctx.follows_you) parts.push('you follow each other');
  else if (ctx.you_follow) parts.push('you follow them');
  else if (ctx.follows_you) parts.push('they follow you');
  if (ctx.match?.score != null) {
    parts.push(`they are a ${ctx.match.score}-point match for you${ctx.match.reasons[0] ? ` (${ctx.match.reasons[0].toLowerCase()})` : ''}`);
  }
  if (ctx.shared_interests.length > 0) {
    parts.push(`you share interests around ${ctx.shared_interests.slice(0, 3).join(', ')}`);
  }
  if (ctx.shared_groups.length > 0) {
    parts.push(`you are both in ${ctx.shared_groups.slice(0, 2).join(' and ')}`);
  }
  if (ctx.latest_posts.length > 0) {
    parts.push('they have been active recently');
  }
  const relevance =
    parts.length > 0
      ? `${name} is relevant to you because ${parts.join(', ')}.`
      : `${name} is a member of your Maxina community.`;
  return ctx.recommended_next_action
    ? `${relevance} Best next step: ${ctx.recommended_next_action}`
    : relevance;
}
