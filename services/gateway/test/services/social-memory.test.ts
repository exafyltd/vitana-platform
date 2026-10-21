// BOOTSTRAP-SOCIAL-MEMORY — unit tests for the Social Memory Intelligence
// layer: intent detection + person-hint extraction, explainable rankers,
// prompt formatting (incl. privacy hints), and person-context privacy
// minimization.

import {
  detectSocialIntent,
  extractPersonHint,
  formatSocialContextForPrompt,
  buildAssistantSystemHints,
} from '../../src/services/social-memory/social-memory-prompts';
import {
  rankInterestingPosts,
  rankInterestingEvents,
  extractTerms,
  buildMatchScoreMap,
} from '../../src/services/social-memory/social-memory-ranker';
import { buildRelevanceSummary } from '../../src/services/social-memory/person-context-builder';
import type {
  SocialContextPack,
  SocialPerson,
  PersonContext,
  MatchSummary,
} from '../../src/services/social-memory/social-memory-types';

function person(id: string, name: string): SocialPerson {
  return {
    user_id: id,
    display_name: name,
    handle: null,
    vitana_id: null,
    avatar_url: null,
    bio: null,
    city: null,
    country: null,
    visibility: null,
  };
}

// ---------------------------------------------------------------------------
// Intent detection — the acceptance-criteria questions must classify social
// ---------------------------------------------------------------------------

describe('detectSocialIntent', () => {
  const socialQuestions: Array<[string, string]> = [
    ['Who do I follow?', 'follows'],
    ['Wem folge ich?', 'follows'],
    ['Who follows me?', 'followers'],
    ['Wer folgt mir?', 'followers'],
    ['Who did I message recently?', 'messages'],
    ['Which group chats am I part of?', 'group_chats'],
    ['What matches do I have?', 'matches'],
    ['What posts are interesting for me today?', 'interesting_posts'],
    ['What events should I join?', 'interesting_events'],
    ['Who should I contact today?', 'who_to_contact'],
    ['What changed in my Maxina Community since yesterday?', 'community_changes'],
  ];

  it.each(socialQuestions)('classifies "%s" as social (%s)', (q, kind) => {
    const d = detectSocialIntent(q);
    expect(d.is_social).toBe(true);
    expect(d.kinds).toContain(kind);
  });

  it('detects a person query with the person name extracted', () => {
    const d = detectSocialIntent('Tell me more about Mariia Maksina.');
    expect(d.is_social).toBe(true);
    expect(d.kinds).toContain('person_query');
    expect(d.person_hint).toBe('Mariia Maksina');
  });

  it('detects person activity queries', () => {
    const d = detectSocialIntent('What did Mariia Maksina do recently?');
    expect(d.kinds).toContain('person_activity');
    expect(d.person_hint).toBe('Mariia Maksina');
  });

  it('does NOT classify non-social questions as social', () => {
    for (const q of [
      'How can I sleep better?',
      'Was sollte ich heute Abend essen?',
      'What is my Vitana Index?',
    ]) {
      expect(detectSocialIntent(q).is_social).toBe(false);
    }
  });
});

describe('extractPersonHint', () => {
  it('extracts multi-word capitalized names', () => {
    expect(extractPersonHint('Talk about Mariia Maksina latest activities')).toBe('Mariia Maksina');
    expect(extractPersonHint('Erzähl mir etwas über Anna Schmidt bitte')).toBe('Anna Schmidt');
  });

  it('extracts single names after prepositions', () => {
    expect(extractPersonHint('tell me about Mariia')).toBe('Mariia');
    expect(extractPersonHint('was weißt du über Kemal?')).toBe('Kemal');
  });

  it('never mistakes platform words for names', () => {
    expect(extractPersonHint('Tell me about Vitana Index')).toBeNull();
    expect(extractPersonHint('What is the Maxina Community?')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rankers — explainable, relationship-signal-dominated
// ---------------------------------------------------------------------------

describe('rankInterestingPosts', () => {
  const people = new Map([
    ['followed-1', person('followed-1', 'Mariia')],
    ['match-1', person('match-1', 'Anna')],
    ['stranger-1', person('stranger-1', 'Random')],
  ]);
  const basePost = (id: string, author: string, content: string, hoursAgo = 1) => ({
    id,
    user_id: author,
    content,
    image_url: null,
    video_url: null,
    likes_count: 0,
    comments_count: 0,
    created_at: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
  });

  const signals = {
    viewer_id: 'me',
    followed_ids: new Set(['followed-1']),
    match_scores: new Map([['match-1', 87]]),
    interests: ['fitness', 'dance'],
    goal_terms: ['longevity'],
    shared_group_counts: new Map<string, number>(),
    people,
  };

  it('ranks followed authors above strangers and explains why', () => {
    const ranked = rankInterestingPosts(
      [
        basePost('p1', 'stranger-1', 'A generic update'),
        basePost('p2', 'followed-1', 'Morning walk'),
      ],
      signals,
    );
    expect(ranked[0].post_id).toBe('p2');
    expect(ranked[0].reason).toContain('You follow this person');
  });

  it('boosts high-quality-match authors and interest/goal topics with reasons', () => {
    const ranked = rankInterestingPosts(
      [basePost('p3', 'match-1', 'New dance and fitness session for longevity fans')],
      signals,
    );
    const r = ranked[0];
    expect(r.reason).toEqual(
      expect.arrayContaining([
        'This author is one of your high-quality matches',
        expect.stringContaining('Matches your interests'),
        'This topic connects to your current goal',
      ]),
    );
    expect(r.score).toBeGreaterThan(50);
  });

  it('every result carries at least one reason', () => {
    const ranked = rankInterestingPosts([basePost('p4', 'stranger-1', 'hello world')], signals);
    expect(ranked[0].reason.length).toBeGreaterThan(0);
  });
});

describe('rankInterestingEvents', () => {
  const people = new Map([['followed-1', person('followed-1', 'Mariia')]]);
  const ev = (id: string, title: string, daysOut = 2) => ({
    id,
    title,
    description: null,
    event_type: null,
    start_time: new Date(Date.now() + daysOut * 86400000).toISOString(),
    location: 'Berlin',
    slug: 'test-event',
    participant_count: 10,
  });

  it('boosts events attended by followed people, with attendee names', () => {
    const ranked = rankInterestingEvents([ev('e1', 'Dance Night')], {
      viewer_id: 'me',
      followed_ids: new Set(['followed-1']),
      match_scores: new Map(),
      interests: ['dance'],
      goal_terms: [],
      location_terms: ['berlin'],
      participants: new Map([['e1', ['followed-1', 'other']]]),
      people,
    });
    const r = ranked[0];
    expect(r.reason).toEqual(
      expect.arrayContaining([
        '1 person you follow is attending',
        expect.stringContaining('Matches your interests'),
        'It is near you',
      ]),
    );
    expect(r.followed_attendees).toEqual(['Mariia']);
    expect(r.url).toBe('https://vitanaland.com/e/test-event');
  });
});

describe('helpers', () => {
  it('extractTerms produces lowercase significant words', () => {
    expect(extractTerms('Improve Sleep Quality')).toEqual(
      expect.arrayContaining(['improve', 'sleep', 'quality']),
    );
    expect(extractTerms(null)).toEqual([]);
  });

  it('buildMatchScoreMap maps person → score', () => {
    const matches: MatchSummary[] = [
      {
        person: person('a', 'A'),
        score: 87,
        reasons: [],
        source: 'daily_match',
        matched_at: null,
        action: null,
        conversation_started: false,
        is_current: true,
      },
    ];
    expect(buildMatchScoreMap(matches).get('a')).toBe(87);
  });
});

// ---------------------------------------------------------------------------
// Prompt formatting + privacy
// ---------------------------------------------------------------------------

function makePack(overrides: Partial<SocialContextPack> = {}): SocialContextPack {
  return {
    user: person('me', 'Test User'),
    relationships: {
      following: [{ person: person('f1', 'Mariia Maksina'), since: '2026-07-01' }],
      followers: [],
      following_count: 1,
      followers_count: 0,
      mutual_ids: [],
    },
    matches: [
      {
        person: person('m1', 'Anna'),
        score: 87,
        reasons: ["You're both strong in Sleep"],
        source: 'daily_match',
        matched_at: null,
        action: null,
        conversation_started: false,
        is_current: true,
      },
    ],
    messages: [],
    group_chats: [],
    interesting_posts: [],
    interesting_events: [],
    person_context: null,
    activity_context: null,
    memory_highlights: [],
    recommended_actions: [
      { action: 'Say hello to Anna', reason: 'Match score 87', route: '/matches' },
    ],
    assistant_system_hints: [],
    meta: {
      built_at: new Date().toISOString(),
      latency_ms: 5,
      sections_loaded: [],
      degraded_sections: [],
      privacy_filters_applied: [],
    },
    ...overrides,
  };
}

describe('formatSocialContextForPrompt', () => {
  it('renders follows, matches with scores/reasons, and recommended actions', () => {
    const pack = makePack();
    pack.assistant_system_hints = buildAssistantSystemHints(pack);
    const block = formatSocialContextForPrompt(pack);
    expect(block).toContain('<social_context>');
    expect(block).toContain('Mariia Maksina');
    expect(block).toContain('Anna (score 87)');
    expect(block).toContain("You're both strong in Sleep");
    expect(block).toContain('Say hello to Anna');
    expect(block).toContain('never invent people');
  });

  it('emits a hard privacy instruction for privacy-limited person context', () => {
    const pc: PersonContext = {
      person: person('p1', 'Private Person'),
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
      relevance_summary: 'Private Person keeps their profile private, so only limited information is available.',
    };
    const block = formatSocialContextForPrompt(makePack({ person_context: pc }));
    expect(block).toContain('PRIVACY: profile is private');
    expect(block).toContain('do NOT speculate');
  });
});

describe('buildRelevanceSummary', () => {
  const baseCtx = (over: Partial<PersonContext>): PersonContext => ({
    person: person('p1', 'Mariia Maksina'),
    you_follow: true,
    follows_you: false,
    match: {
      person: person('p1', 'Mariia Maksina'),
      score: 87,
      reasons: ["You're both strong in Sleep"],
      source: 'daily_match',
      matched_at: null,
      action: null,
      conversation_started: false,
      is_current: true,
    },
    shared_interests: ['fitness', 'dance'],
    shared_groups: ['Maxina Fitness'],
    shared_events: [],
    latest_posts: [{ post_id: 'x', snippet: 'hi', created_at: '2026-07-01', media_type: 'text' }],
    upcoming_events: [],
    last_chat_at: null,
    privacy_limited: false,
    recommended_next_action: 'Open her profile.',
    relevance_summary: '',
    ...over,
  });

  it('produces the spec-style relevance narrative with next action', () => {
    const s = buildRelevanceSummary(baseCtx({}));
    expect(s).toContain('Mariia Maksina is relevant to you because');
    expect(s).toContain('you follow them');
    expect(s).toContain('87-point match');
    expect(s).toContain('fitness, dance');
    expect(s).toContain('Best next step: Open her profile.');
  });

  it('says details are limited for private profiles', () => {
    const s = buildRelevanceSummary(baseCtx({ privacy_limited: true }));
    expect(s).toContain('private');
    expect(s).not.toContain('87-point');
  });
});
