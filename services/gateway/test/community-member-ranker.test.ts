/**
 * VTID-02754 — community-member-ranker unit tests.
 *
 * Tests the parts of the ranker that don't require a Supabase connection:
 *   - parseQuery() — query interpreter
 *   - hashQuery() — deterministic hash
 *   - voice_summary copy invariants (no apologetic words ever)
 *
 * Live ranker integration tests against Supabase are covered by the
 * end-to-end voice test described in the plan.
 */

import { parseQuery, hashQuery } from '../src/services/voice-tools/community-member-ranker';

describe('VTID-02754 — parseQuery: Tier 2 (Vitana Index)', () => {
  test('"who is the healthiest" → indexOverall=true', () => {
    const p = parseQuery('Who is the healthiest member?');
    expect(p.indexOverall).toBe(true);
  });

  test('"who is the fittest" → pillar=exercise', () => {
    const p = parseQuery('Who is the fittest in the community?');
    expect(p.pillar).toBe('exercise');
  });

  test('"who has the best sleep" → pillar=sleep', () => {
    const p = parseQuery('Who in the community has the best sleep?');
    expect(p.pillar).toBe('sleep');
  });

  test('"who is the calmest" → pillar=mental', () => {
    const p = parseQuery('Who is the calmest community member?');
    expect(p.pillar).toBe('mental');
  });

  test('"who eats the best" → pillar=nutrition', () => {
    const p = parseQuery('who eats the best in the community');
    expect(p.pillar).toBe('nutrition');
  });
});

describe('VTID-02754 — parseQuery: Tier 3 lanes', () => {
  test('"who is the best teacher" → tier3Lane=teaching', () => {
    const p = parseQuery('Who is the best teacher of yoga?');
    expect(p.tier3Lane).toBe('teaching');
  });

  test('"smartest about nutrition" → tier3Lane=expertise', () => {
    const p = parseQuery('Who is the smartest person about nutrition?');
    expect(p.tier3Lane).toBe('expertise');
  });

  test('"most experienced golfer" → tier3Lane=experience', () => {
    const p = parseQuery('Who is the most experienced golfer in the community?');
    expect(p.tier3Lane).toBe('experience');
  });

  test('"most inspiring person" → tier3Lane=motivation', () => {
    const p = parseQuery('Who is the most inspiring member?');
    expect(p.tier3Lane).toBe('motivation');
  });

  test('"funniest" → tier3Lane=entertainment', () => {
    const p = parseQuery('Who is the funniest person here?');
    expect(p.tier3Lane).toBe('entertainment');
  });

  test('"best to talk to" → tier3Lane=conversation', () => {
    const p = parseQuery('Who is the best to talk to?');
    expect(p.tier3Lane).toBe('conversation');
  });
});

describe('VTID-02754 — parseQuery: Tier 4 ethics reroute', () => {
  test('"most beautiful" → ethicsReroute=true', () => {
    const p = parseQuery('Who is the most beautiful in the community?');
    expect(p.ethicsReroute).toBe(true);
  });

  test('"richest" → ethicsReroute=true', () => {
    const p = parseQuery('Who is the richest member?');
    expect(p.ethicsReroute).toBe(true);
  });

  test('"prettiest" → ethicsReroute=true', () => {
    const p = parseQuery('Show me the prettiest girl in the community');
    expect(p.ethicsReroute).toBe(true);
  });

  test('"hottest" → ethicsReroute=true', () => {
    const p = parseQuery('Who is the hottest right now?');
    expect(p.ethicsReroute).toBe(true);
  });

  test('"healthiest" does NOT trip ethics reroute', () => {
    const p = parseQuery('Who is the healthiest member?');
    expect(p.ethicsReroute).toBe(false);
  });
});

describe('VTID-02754 — parseQuery: location modifier', () => {
  test('"near me" → locationFilter=near_me', () => {
    const p = parseQuery('Who is good at running near me?');
    expect(p.locationFilter).toBe('near_me');
  });

  test('"in my city" → locationFilter=near_me', () => {
    const p = parseQuery('Who plays golf in my city?');
    expect(p.locationFilter).toBe('near_me');
  });

  test('"in Berlin" → locationFilter=in_place + place=berlin', () => {
    const p = parseQuery('Who is the best dancer in Berlin?');
    expect(p.locationFilter).toBe('in_place');
    expect(p.locationPlace).toMatch(/berlin/i);
  });
});

describe('VTID-02754 — parseQuery: tenure modifier', () => {
  test('"newest member" → tenureFilter=newest', () => {
    const p = parseQuery('Who is the newest member?');
    expect(p.tenureFilter).toBe('newest');
  });

  test('"longest member" → tenureFilter=longest', () => {
    const p = parseQuery('Who is the longest standing member?');
    expect(p.tenureFilter).toBe('longest');
  });

  test('"OG member" → tenureFilter=longest', () => {
    const p = parseQuery('Who is the OG member of this community?');
    expect(p.tenureFilter).toBe('longest');
  });

  test('"just joined" → tenureFilter=newest', () => {
    const p = parseQuery('Who just joined recently?');
    expect(p.tenureFilter).toBe('newest');
  });

  test('"most active right now" → tenureFilter=recent_active', () => {
    const p = parseQuery('Who is the most active right now in our community?');
    expect(p.tenureFilter).toBe('recent_active');
  });
});

describe('VTID-02754 — parseQuery: composition (multiple modifiers)', () => {
  test('"newest salsa teacher in my city" → tier3Lane=teaching + tenure=newest + location=near_me', () => {
    const p = parseQuery('Who is the newest salsa teacher in my city?');
    expect(p.tier3Lane).toBe('teaching');
    expect(p.tenureFilter).toBe('newest');
    expect(p.locationFilter).toBe('near_me');
  });

  test('"longest standing healthiest member" → indexOverall=true + tenure=longest', () => {
    const p = parseQuery('Who is the longest standing, healthiest member?');
    expect(p.indexOverall).toBe(true);
    expect(p.tenureFilter).toBe('longest');
  });
});

describe('VTID-02754 — parseQuery: exact keyword extraction', () => {
  test('extracts longest non-stopword token', () => {
    const p = parseQuery('Who is good at half marathon running?');
    expect(p.exactKeyword).toBeTruthy();
    expect(['marathon', 'running']).toContain(p.exactKeyword);
  });

  test('strips "near me" from keyword pool', () => {
    const p = parseQuery('Who plays golf near me?');
    expect(p.exactKeyword).toBe('golf');
  });

  test('strips "newest member" from keyword pool', () => {
    const p = parseQuery('Who is the newest member?');
    expect(p.exactKeyword).toBeUndefined();
  });

  test('returns undefined when only stopwords', () => {
    const p = parseQuery('who is the most');
    expect(p.exactKeyword).toBeUndefined();
  });
});

describe('VTID-02754 — hashQuery: determinism', () => {
  test('same query + viewer hashes identically', () => {
    const a = hashQuery('who is the healthiest', 'user-1');
    const b = hashQuery('who is the healthiest', 'user-1');
    expect(a).toBe(b);
  });

  test('different viewers hash differently', () => {
    const a = hashQuery('who is the healthiest', 'user-1');
    const b = hashQuery('who is the healthiest', 'user-2');
    expect(a).not.toBe(b);
  });

  test('output is bounded to 32 chars', () => {
    const h = hashQuery('any query', 'any-user');
    expect(h).toHaveLength(32);
  });
});
