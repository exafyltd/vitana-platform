/**
 * Tests for src/services/social-memory/social-memory-prompts.ts
 *
 * Pure functions — no mocking needed. Covers:
 *   - extractPersonHint(): multi-word name extraction, stopword filtering,
 *     preposition-anchored single-name extraction
 *   - detectSocialIntent(): trigger-kind classification + person_query wiring
 *   - formatSocialContextForPrompt(): <social_context> rendering per section
 *   - buildAssistantSystemHints(): standing + conditional hints
 */
import {
  extractPersonHint,
  detectSocialIntent,
  formatSocialContextForPrompt,
  buildAssistantSystemHints,
} from '../../../src/services/social-memory/social-memory-prompts';
import type { SocialContextPack, SocialPerson } from '../../../src/services/social-memory/social-memory-types';

function person(overrides: Partial<SocialPerson> = {}): SocialPerson {
  return {
    user_id: 'u-1',
    display_name: 'Mariia Maksina',
    handle: 'mariia',
    vitana_id: 'V-1',
    avatar_url: null,
    bio: null,
    city: null,
    country: null,
    visibility: 'public',
    ...overrides,
  };
}

function emptyPack(overrides: Partial<SocialContextPack> = {}): SocialContextPack {
  return {
    user: null,
    relationships: { following: [], followers: [], following_count: 0, followers_count: 0, mutual_ids: [] },
    matches: [],
    messages: [],
    group_chats: [],
    interesting_posts: [],
    interesting_events: [],
    person_context: null,
    activity_context: null,
    memory_highlights: [],
    recommended_actions: [],
    assistant_system_hints: [],
    meta: {
      built_at: '2026-07-01T00:00:00.000Z',
      latency_ms: 12,
      sections_loaded: [],
      degraded_sections: [],
      privacy_filters_applied: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractPersonHint
// ---------------------------------------------------------------------------

describe('extractPersonHint', () => {
  it('returns null for empty/falsy input', () => {
    expect(extractPersonHint('')).toBeNull();
    expect(extractPersonHint(null as unknown as string)).toBeNull();
  });

  it('extracts a full multi-word capitalized name', () => {
    expect(extractPersonHint('Did I talk to Mariia Maksina recently?')).toBe('Mariia Maksina');
  });

  it('skips a multi-word candidate composed entirely of stopwords', () => {
    // "Life" and "Compass" are both in NAME_STOPWORDS — must not be treated
    // as a person name, and no other candidate exists in the sentence.
    expect(extractPersonHint('Tell me about my Life Compass score')).toBeNull();
  });

  it('extracts a single capitalized name after "about"', () => {
    expect(extractPersonHint('tell me about Mariia and her posts')).toBe('Mariia');
  });

  it('extracts a single capitalized name after the German preposition "über"', () => {
    expect(extractPersonHint('was weißt du über Mariia')).toBe('Mariia');
  });

  it('does not extract a NAME_STOPWORD as a single-name candidate', () => {
    expect(extractPersonHint('was weißt du über Vitana')).toBeNull();
  });

  it('returns null when there is no capitalized-name candidate at all', () => {
    expect(extractPersonHint('what are my upcoming events this week')).toBeNull();
  });

  it('prefers a multi-word name over a later single-word preposition match', () => {
    expect(extractPersonHint('about Mariia Maksina and also über Someone')).toBe('Mariia Maksina');
  });
});

// ---------------------------------------------------------------------------
// detectSocialIntent
// ---------------------------------------------------------------------------

describe('detectSocialIntent', () => {
  it('flags no social intent for an unrelated question', () => {
    const decision = detectSocialIntent('what is the capital of France');
    expect(decision.is_social).toBe(false);
    expect(decision.kinds).toEqual([]);
    expect(decision.person_hint).toBeNull();
  });

  it('detects "follows" intent (EN)', () => {
    const decision = detectSocialIntent('who do I follow on Maxina');
    expect(decision.is_social).toBe(true);
    expect(decision.kinds).toContain('follows');
  });

  it('detects "followers" intent (DE)', () => {
    const decision = detectSocialIntent('wer folgt mir gerade');
    expect(decision.is_social).toBe(true);
    expect(decision.kinds).toContain('followers');
  });

  it('detects multiple kinds in a single question', () => {
    const decision = detectSocialIntent('what are my matches and who follows me');
    expect(decision.kinds).toEqual(expect.arrayContaining(['matches', 'followers']));
  });

  it('adds person_query and person_hint when a name is present', () => {
    const decision = detectSocialIntent('what did Mariia Maksina post recently');
    expect(decision.kinds).toContain('person_query');
    expect(decision.person_hint).toBe('Mariia Maksina');
  });

  it('does not duplicate person_query if a trigger already classified it', () => {
    // "what did ... do" triggers person_activity; a name is also present.
    const decision = detectSocialIntent('What did Mariia Maksina do recently?');
    const occurrences = decision.kinds.filter((k) => k === 'person_query').length;
    expect(occurrences).toBe(1);
    expect(decision.kinds).toContain('person_activity');
  });

  it('detects "latest activity" phrasing as person_activity (regression: the trailing \\b after the truncated "activit" stem must not swallow the rest of the word)', () => {
    const decision = detectSocialIntent('what is the latest activity of Mariia Maksina');
    expect(decision.kinds).toContain('person_activity');
  });

  it('detects German "letzte Aktivität" phrasing as person_activity', () => {
    const decision = detectSocialIntent('zeig mir ihre letzte Aktivität');
    expect(decision.kinds).toContain('person_activity');
  });
});

// ---------------------------------------------------------------------------
// formatSocialContextForPrompt
// ---------------------------------------------------------------------------

describe('formatSocialContextForPrompt', () => {
  it('renders the "none yet" branch when there are no follows/followers', () => {
    const text = formatSocialContextForPrompt(emptyPack());
    expect(text).toContain('<social_context>');
    expect(text).toContain('Follows: none yet. Followers: none yet.');
    expect(text).toContain('</social_context>');
  });

  it('renders follow/follower names and counts when present', () => {
    const pack = emptyPack({
      relationships: {
        following: [{ person: person({ user_id: 'a', display_name: 'Alice' }), since: '2026-01-01' }],
        followers: [{ person: person({ user_id: 'b', display_name: 'Bob' }), since: '2026-01-02' }],
        following_count: 1,
        followers_count: 1,
        mutual_ids: [],
      },
    });
    const text = formatSocialContextForPrompt(pack);
    expect(text).toContain('Follows (1): Alice');
    expect(text).toContain('Followers (1): Bob');
  });

  it('renders matches with score and reasons, capped at 6', () => {
    const matches = Array.from({ length: 8 }, (_, i) => ({
      person: person({ user_id: `m${i}`, display_name: `Match${i}` }),
      score: 90 - i,
      reasons: ['shared interest'],
      source: 'daily_match' as const,
      matched_at: '2026-07-01T00:00:00.000Z',
      action: null,
      conversation_started: false,
      is_current: true,
    }));
    const text = formatSocialContextForPrompt(emptyPack({ matches }));
    expect(text).toContain('Matches (best first):');
    expect(text).toContain('Match0 (score 90)');
    // Only the first 6 are rendered
    expect(text).not.toContain('Match6');
    expect(text).not.toContain('Match7');
  });

  it('renders recent chat contacts with direction and date', () => {
    const text = formatSocialContextForPrompt(
      emptyPack({
        messages: [
          {
            person: person({ display_name: 'Carla' }),
            last_message_at: '2026-07-05T00:00:00.000Z',
            last_direction: 'received',
            last_snippet: 'hi there',
            messages_30d: 3,
          },
        ],
      }),
    );
    expect(text).toContain('Recent chat contacts (last 30 days):');
    expect(text).toContain('Carla — last received 2026-07-05, 3 msg(s)');
  });

  it('renders group chats joined with commas', () => {
    const text = formatSocialContextForPrompt(
      emptyPack({
        group_chats: [
          { group_id: 'g1', name: 'Runners', member_count: 12, is_system: false, last_message_at: null, joined_at: null },
          { group_id: 'g2', name: null, member_count: null, is_system: false, last_message_at: null, joined_at: null },
        ],
      }),
    );
    expect(text).toContain('Group chats: Runners (12), Unnamed');
  });

  it('renders interesting posts and events with score + reasons', () => {
    const text = formatSocialContextForPrompt(
      emptyPack({
        interesting_posts: [
          {
            post_id: 'p1',
            author: person({ display_name: 'Dana' }),
            snippet: 'went for a run',
            created_at: '2026-07-01T00:00:00.000Z',
            media_type: 'text',
            likes_count: 2,
            comments_count: 0,
            score: 77,
            reason: ['you follow Dana', 'high engagement'],
          },
        ],
        interesting_events: [
          {
            event_id: 'e1',
            title: 'Community Run',
            event_type: 'meetup',
            start_time: '2026-07-10T00:00:00.000Z',
            location: 'Berlin',
            url: 'https://example.com/e1',
            participant_count: 5,
            followed_attendees: [],
            matched_attendees: [],
            score: 55,
            reason: ['matches your interests'],
          },
        ],
      }),
    );
    expect(text).toContain('Interesting posts for this user:');
    expect(text).toContain('[77] Dana: "went for a run" — you follow Dana; high engagement');
    expect(text).toContain('Interesting events for this user:');
    expect(text).toContain('[55] Community Run (2026-07-10, Berlin) — matches your interests');
    expect(text).toContain('Link: https://example.com/e1');
  });

  it('renders person_context with shared info when not privacy limited', () => {
    const text = formatSocialContextForPrompt(
      emptyPack({
        person_context: {
          person: person({ display_name: 'Eve' }),
          you_follow: true,
          follows_you: false,
          match: null,
          shared_interests: ['hiking'],
          shared_groups: ['Trail Club'],
          shared_events: ['Weekend Hike'],
          latest_posts: [{ post_id: 'p2', snippet: 'loved the trail', created_at: '2026-07-02T00:00:00.000Z', media_type: 'text' }],
          upcoming_events: [],
          last_chat_at: '2026-07-03T00:00:00.000Z',
          privacy_limited: false,
          recommended_next_action: null,
          relevance_summary: 'Eve shares your interest in hiking.',
        },
      }),
    );
    expect(text).toContain('Person in focus — Eve:');
    expect(text).toContain('Eve shares your interest in hiking.');
    expect(text).toContain('Shared interests: hiking');
    expect(text).toContain('Shared groups: Trail Club');
    expect(text).toContain('Shared events: Weekend Hike');
    expect(text).toContain('Recent post (2026-07-02): "loved the trail"');
    expect(text).toContain('Last chat with the user: 2026-07-03');
    expect(text).not.toContain('PRIVACY: profile is private');
  });

  it('renders privacy-limited person_context WITHOUT leaking shared details', () => {
    const text = formatSocialContextForPrompt(
      emptyPack({
        person_context: {
          person: person({ display_name: 'Frank' }),
          you_follow: false,
          follows_you: false,
          match: null,
          shared_interests: ['should not appear'],
          shared_groups: ['should not appear either'],
          shared_events: [],
          latest_posts: [],
          upcoming_events: [],
          last_chat_at: null,
          privacy_limited: true,
          recommended_next_action: null,
          relevance_summary: 'Frank has a private profile.',
        },
      }),
    );
    expect(text).toContain('PRIVACY: profile is private and the user has no connection');
    expect(text).not.toContain('should not appear');
  });

  it('renders activity_context for a specific person vs. the general network', () => {
    const forPerson = formatSocialContextForPrompt(
      emptyPack({
        activity_context: {
          person: person({ display_name: 'Gina' }),
          items: [{ kind: 'post', at: '2026-07-01T00:00:00.000Z', summary: 'posted a photo', ref_id: 'p3' }],
          window_days: 7,
        },
      }),
    );
    expect(forPerson).toContain('Recent activity of Gina:');
    expect(forPerson).toContain('2026-07-01: posted a photo');

    const forNetwork = formatSocialContextForPrompt(
      emptyPack({
        activity_context: { person: null, items: [{ kind: 'post', at: '2026-07-01T00:00:00.000Z', summary: 'someone joined a group', ref_id: null }], window_days: 3 },
      }),
    );
    expect(forNetwork).toContain("Recent activity in the user's network (last 3 day(s)):");
  });

  it('renders recommended_actions and assistant_system_hints', () => {
    const text = formatSocialContextForPrompt(
      emptyPack({
        recommended_actions: [{ action: 'Message Dana', reason: 'you both attended the same event', route: '/chat/dana' }],
        assistant_system_hints: ['Be concise.'],
      }),
    );
    expect(text).toContain('Recommended next actions (offer at most ONE, woven naturally):');
    expect(text).toContain('Message Dana — you both attended the same event');
    expect(text).toContain('Guidance:');
    expect(text).toContain('Be concise.');
  });

  it('omits optional sections entirely when their arrays are empty', () => {
    const text = formatSocialContextForPrompt(emptyPack());
    expect(text).not.toContain('Matches (best first):');
    expect(text).not.toContain('Recent chat contacts');
    expect(text).not.toContain('Group chats:');
    expect(text).not.toContain('Person in focus');
    expect(text).not.toContain('Recommended next actions');
    expect(text).not.toContain('Guidance:');
  });
});

// ---------------------------------------------------------------------------
// buildAssistantSystemHints
// ---------------------------------------------------------------------------

describe('buildAssistantSystemHints', () => {
  it('returns exactly the 3 standing hints when nothing special applies', () => {
    const hints = buildAssistantSystemHints({ person_context: null, matches: [{ person: person(), score: 80, reasons: [], source: 'daily_match', matched_at: null, action: null, conversation_started: false, is_current: true }] });
    expect(hints).toHaveLength(3);
    expect(hints[0]).toMatch(/Answer social questions ONLY/);
  });

  it('appends a privacy hint when the focused person is privacy-limited', () => {
    const hints = buildAssistantSystemHints({
      person_context: {
        person: person(),
        you_follow: false,
        follows_you: false,
        match: null,
        shared_interests: [],
        shared_groups: [],
        shared_events: [],
        latest_posts: [],
        upcoming_events: [],
        last_chat_at: null,
        privacy_limited: true,
        recommended_next_action: null,
        relevance_summary: '',
      },
      matches: [],
    });
    expect(hints).toContain('The person in focus has a private profile — politely say details are limited.');
  });

  it('appends a no-matches hint when matches is empty', () => {
    const hints = buildAssistantSystemHints({ person_context: null, matches: [] });
    expect(hints).toContain('The user has no active matches — if asked, say so honestly and suggest exploring the community.');
  });

  it('appends both conditional hints when both conditions are true (5 total)', () => {
    const hints = buildAssistantSystemHints({
      person_context: {
        person: person(),
        you_follow: false,
        follows_you: false,
        match: null,
        shared_interests: [],
        shared_groups: [],
        shared_events: [],
        latest_posts: [],
        upcoming_events: [],
        last_chat_at: null,
        privacy_limited: true,
        recommended_next_action: null,
        relevance_summary: '',
      },
      matches: [],
    });
    expect(hints).toHaveLength(5);
  });
});
