/**
 * Conversation Flow v3 — decision engine tests.
 *
 * Locks the user's contract:
 *   - match > topic > song > greeting; urgent pre-empts all
 *   - match is immediate (no permission), topic/song are permission-gated
 *   - topic block NAMES the feature, introduces VERBALLY first, "show/open
 *     screen" only as a later step
 *   - song routes to Media Hub music with autoplay=random
 *   - affirmative/negative detection (multilingual, negation wins)
 */

import {
  pickFlowFocus,
  renderFlowFocusBlock,
  detectAffirmative,
  type FlowInputs,
  type JourneyTopicInput,
} from '../src/services/guide/conversation-flow-v3';

function inputs(overrides: Partial<FlowInputs> = {}): FlowInputs {
  return {
    has_urgent: false,
    new_match: null,
    next_topic: null,
    song_available: false,
    recently_surfaced: new Set<string>(),
    date_key: '2026-06-17',
    ...overrides,
  };
}

const topic = (o: Partial<JourneyTopicInput> = {}): JourneyTopicInput => ({
  topic_id: 't-life-compass',
  name: 'Life Compass',
  voice_script: 'Der Life Compass hilft dir, deine wichtigsten Ziele festzulegen.',
  short_description: null,
  route: '/memory?open=life_compass',
  session: 3,
  ...o,
});

describe('pickFlowFocus — priority order', () => {
  it('urgent pre-empts everything', () => {
    const f = pickFlowFocus(
      inputs({ has_urgent: true, new_match: { first_name: 'Mariia' }, next_topic: topic(), song_available: true }),
    );
    expect(f.kind).toBe('defer_to_urgent');
    expect(f.pending_action).toBeNull();
  });

  it('new match outranks topic and song, and is immediate', () => {
    const f = pickFlowFocus(
      inputs({ new_match: { first_name: 'Mariia' }, next_topic: topic(), song_available: true }),
    );
    expect(f.kind).toBe('community_match');
    expect(f.name).toBe('Mariia');
    expect(f.pending_action).toEqual({ route: '/me/matches', immediate: true });
  });

  it('un-learned topic outranks song when no match', () => {
    const f = pickFlowFocus(inputs({ next_topic: topic(), song_available: true }));
    expect(f.kind).toBe('journey_topic');
    expect(f.name).toBe('Life Compass');
    expect(f.pending_action).toEqual({ route: '/memory?open=life_compass', immediate: false });
  });

  it('song offer when no match and no un-learned topic', () => {
    const f = pickFlowFocus(inputs({ song_available: true }));
    expect(f.kind).toBe('song');
    expect(f.pending_action).toEqual({
      route: '/comm/media-hub?tab=music&autoplay=random',
      immediate: false,
      autoplay_random: true,
    });
  });

  it('falls back to greeting when nothing to surface', () => {
    expect(pickFlowFocus(inputs()).kind).toBe('greeting');
  });

  it('topic with no route still introduces (no open-screen step)', () => {
    const f = pickFlowFocus(inputs({ next_topic: topic({ route: null }) }));
    expect(f.kind).toBe('journey_topic');
    expect(f.pending_action).toBeNull();
  });
});

describe('pickFlowFocus — dedupe', () => {
  it('skips a match already surfaced today and falls to the topic', () => {
    const f = pickFlowFocus(
      inputs({
        new_match: { first_name: 'Mariia' },
        next_topic: topic(),
        recently_surfaced: new Set(['match:2026-06-17']),
      }),
    );
    expect(f.kind).toBe('journey_topic');
  });

  it('skips a topic already surfaced today and falls to the song', () => {
    const f = pickFlowFocus(
      inputs({
        next_topic: topic(),
        song_available: true,
        recently_surfaced: new Set(['topic:t-life-compass:2026-06-17']),
      }),
    );
    expect(f.kind).toBe('song');
  });
});

describe('renderFlowFocusBlock', () => {
  it('match block: names the user, immediate, no permission ask', () => {
    const block = renderFlowFocusBlock(
      pickFlowFocus(inputs({ new_match: { first_name: 'Mariia' } })),
    );
    expect(block).toMatch(/NEW COMMUNITY MATCH/);
    expect(block).toContain('"Mariia"');
    expect(block).toMatch(/NOT a permission ask/);
    expect(block).toContain('/me/matches');
  });

  it('topic block: NAMES the feature, verbal-first, "show/open" only as step 3', () => {
    const block = renderFlowFocusBlock(pickFlowFocus(inputs({ next_topic: topic() })));
    expect(block).toContain('Life Compass');
    expect(block).toMatch(/Ask permission to INTRODUCE/);
    expect(block).toMatch(/INTRODUCE it VERBALLY/);
    // "open the screen" must be step 3, after the verbal intro
    const step2 = block.indexOf('STEP 2');
    const step3 = block.indexOf('STEP 3');
    expect(step2).toBeGreaterThan(-1);
    expect(step3).toBeGreaterThan(step2);
    expect(block).toContain('/memory?open=life_compass');
    // explicitly forbids the old abstract "may I show you something" form
    expect(block).toMatch(/never .*abstractly/i);
  });

  it('topic block carries the verbal script content', () => {
    const block = renderFlowFocusBlock(pickFlowFocus(inputs({ next_topic: topic() })));
    expect(block).toContain('Der Life Compass hilft dir');
  });

  it('song block: permission-gated, routes to media hub autoplay', () => {
    const block = renderFlowFocusBlock(pickFlowFocus(inputs({ song_available: true })));
    expect(block).toMatch(/OFFER TO PLAY A SONG/);
    expect(block).toMatch(/darf ich/i);
    expect(block).toContain('/comm/media-hub?tab=music&autoplay=random');
  });

  it('every spoken block enforces the language directive', () => {
    for (const f of [
      pickFlowFocus(inputs({ new_match: { first_name: 'X' } })),
      pickFlowFocus(inputs({ next_topic: topic() })),
      pickFlowFocus(inputs({ song_available: true })),
      pickFlowFocus(inputs()),
    ]) {
      expect(renderFlowFocusBlock(f)).toMatch(/language directive/);
    }
  });
});

describe('detectAffirmative', () => {
  it('accepts clear yes in multiple languages', () => {
    for (const t of ['Yes', 'yes please', 'Ja', 'gerne', 'klar', 'sí', 'claro', 'da, naravno', 'go ahead', 'show me']) {
      expect(detectAffirmative(t)).toBe(true);
    }
  });

  it('rejects negatives and negation-wins', () => {
    for (const t of ['no', 'nein', 'not now', 'später', 'no, gerne nicht', 'nein danke']) {
      expect(detectAffirmative(t)).toBe(false);
    }
  });

  it('rejects empty / ambiguous turns', () => {
    expect(detectAffirmative('')).toBe(false);
    expect(detectAffirmative('hmm what is that')).toBe(false);
  });
});
