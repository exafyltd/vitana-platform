/**
 * BOOTSTRAP-SOCIAL-MEMORY — explainable rankers for posts and events.
 *
 * Every score is accompanied by human-readable reasons; the assistant and
 * the UI surface WHY something was recommended, never a bare number.
 * Blocked/muted/hidden filtering happens in the repository BEFORE ranking;
 * the ranker only sees eligible candidates.
 */

import {
  RankedPost,
  RankedEvent,
  MatchSummary,
  SocialPerson,
} from './social-memory-types';
import { RawPost, RawEvent } from './social-memory-repository';

export interface PostRankSignals {
  viewer_id: string;
  followed_ids: Set<string>;
  /** person_id → match score (0-100) for high-quality-match boosts. */
  match_scores: Map<string, number>;
  /** Lowercased interest terms of the viewer (user_interests + memory). */
  interests: string[];
  /** Lowercased goal terms (Life Compass primary goal words). */
  goal_terms: string[];
  /** person_id → shared community group count with the viewer. */
  shared_group_counts: Map<string, number>;
  people: Map<string, SocialPerson>;
}

const HIGH_QUALITY_MATCH = 75;

function freshnessScore(createdAt: string, halfLifeHours: number): number {
  const ageHours = Math.max(0, (Date.now() - Date.parse(createdAt)) / 3600000);
  return Math.exp(-ageHours / halfLifeHours);
}

function matchTerms(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => t.length >= 3 && lower.includes(t));
}

export function rankInterestingPosts(
  candidates: RawPost[],
  signals: PostRankSignals,
  topK = 8,
): RankedPost[] {
  const ranked: RankedPost[] = [];

  for (const post of candidates) {
    let score = 0;
    const reason: string[] = [];

    if (signals.followed_ids.has(post.user_id)) {
      score += 30;
      reason.push('You follow this person');
    }
    const matchScore = signals.match_scores.get(post.user_id);
    if (matchScore != null && matchScore >= HIGH_QUALITY_MATCH) {
      score += 20;
      reason.push('This author is one of your high-quality matches');
    } else if (matchScore != null) {
      score += 10;
      reason.push('This author is one of your matches');
    }

    const interestHits = matchTerms(post.content || '', signals.interests);
    if (interestHits.length > 0) {
      score += Math.min(20, interestHits.length * 8);
      reason.push(`Matches your interests: ${interestHits.slice(0, 3).join(', ')}`);
    }
    const goalHits = matchTerms(post.content || '', signals.goal_terms);
    if (goalHits.length > 0) {
      score += 15;
      reason.push('This topic connects to your current goal');
    }

    const sharedGroups = signals.shared_group_counts.get(post.user_id) || 0;
    if (sharedGroups > 0) {
      score += Math.min(10, sharedGroups * 5);
      reason.push(`You share ${sharedGroups} group${sharedGroups === 1 ? '' : 's'} with the author`);
    }

    // Freshness (48h half-life) + engagement, capped so relationship
    // signals always dominate raw popularity.
    score += Math.round(freshnessScore(post.created_at, 48) * 15);
    const engagement = (post.likes_count || 0) + 2 * (post.comments_count || 0);
    score += Math.min(10, Math.round(Math.log10(1 + engagement) * 5));
    if (post.image_url || post.video_url) score += 2;

    if (reason.length === 0) reason.push('Recent public post from the community');

    const author = signals.people.get(post.user_id);
    ranked.push({
      post_id: post.id,
      author: author ?? {
        user_id: post.user_id,
        display_name: null,
        handle: null,
        vitana_id: null,
        avatar_url: null,
        bio: null,
        city: null,
        country: null,
        visibility: null,
      },
      snippet: (post.content || '').slice(0, 160),
      created_at: post.created_at,
      media_type: post.video_url ? 'video' : post.image_url ? 'image' : 'text',
      likes_count: post.likes_count || 0,
      comments_count: post.comments_count || 0,
      score: Math.min(100, score),
      reason,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topK);
}

export interface EventRankSignals {
  viewer_id: string;
  followed_ids: Set<string>;
  match_scores: Map<string, number>;
  interests: string[];
  goal_terms: string[];
  /** Viewer's city/country (lowercased) for location affinity. */
  location_terms: string[];
  /** event_id → participant user_ids. */
  participants: Map<string, string[]>;
  people: Map<string, SocialPerson>;
}

export function rankInterestingEvents(
  candidates: RawEvent[],
  signals: EventRankSignals,
  topK = 6,
): RankedEvent[] {
  const ranked: RankedEvent[] = [];

  for (const ev of candidates) {
    let score = 0;
    const reason: string[] = [];
    const text = `${ev.title || ''} ${ev.description || ''} ${ev.event_type || ''}`;

    const participantIds = signals.participants.get(ev.id) || [];
    const followedAttending = participantIds.filter((p) => signals.followed_ids.has(p));
    const matchedAttending = participantIds.filter(
      (p) => (signals.match_scores.get(p) ?? 0) >= HIGH_QUALITY_MATCH,
    );

    if (followedAttending.length > 0) {
      score += Math.min(30, followedAttending.length * 12);
      reason.push(
        `${followedAttending.length} ${followedAttending.length === 1 ? 'person you follow is' : 'people you follow are'} attending`,
      );
    }
    if (matchedAttending.length > 0) {
      score += Math.min(20, matchedAttending.length * 10);
      reason.push('One of your high-quality matches is attending');
    }

    const interestHits = matchTerms(text, signals.interests);
    if (interestHits.length > 0) {
      score += Math.min(25, interestHits.length * 10);
      reason.push(`Matches your interests: ${interestHits.slice(0, 3).join(', ')}`);
    }
    const goalHits = matchTerms(text, signals.goal_terms);
    if (goalHits.length > 0) {
      score += 15;
      reason.push('It fits your current goal');
    }
    const locationHits = matchTerms(`${ev.location || ''}`, signals.location_terms);
    if (locationHits.length > 0) {
      score += 10;
      reason.push('It is near you');
    }

    // Sooner events surface first (7-day half-life on time-to-start).
    const daysOut = Math.max(0, (Date.parse(ev.start_time) - Date.now()) / 86400000);
    score += Math.round(Math.exp(-daysOut / 7) * 15);
    if ((ev.participant_count || 0) >= 5) score += 5;

    if (reason.length === 0) reason.push('Upcoming community event');

    const followedNames = followedAttending
      .map((id) => signals.people.get(id)?.display_name)
      .filter((n): n is string => !!n)
      .slice(0, 3);

    ranked.push({
      event_id: ev.id,
      title: ev.title,
      event_type: ev.event_type ?? null,
      start_time: ev.start_time,
      location: ev.location ?? null,
      url: ev.slug ? `https://vitanaland.com/e/${ev.slug}` : null,
      participant_count: ev.participant_count ?? null,
      followed_attendees: followedNames,
      matched_attendees: matchedAttending
        .map((id) => signals.people.get(id)?.display_name)
        .filter((n): n is string => !!n)
        .slice(0, 3),
      score: Math.min(100, score),
      reason,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topK);
}

/** Extract lowercase significant terms from free text (goals, interests). */
export function extractTerms(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-zà-üäöüß0-9]+/i)
        .filter((w) => w.length >= 4),
    ),
  ).slice(0, 12);
}

/** Match score lookup map from MatchSummary list. */
export function buildMatchScoreMap(matches: MatchSummary[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of matches) {
    if (m.score != null) out.set(m.person.user_id, m.score);
  }
  return out;
}
