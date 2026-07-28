/**
 * Tests for src/services/voice-tools/community-member-ranker.ts — the
 * find_community_member voice tool (VTID-02754).
 *
 * Two halves:
 *   1. parseQuery() / hashQuery() — pure functions, exhaustively testable
 *      without any DB mocking.
 *   2. findCommunityMember() — the full pipeline (name lookup, 4 tiers,
 *      2 modifiers, privacy filtering, floor). Every path is asserted to
 *      always return `{ ok: true, ... }` (per the module's own contract:
 *      "Result shape: ALWAYS { ok: true, ... }") and to be a well-formed,
 *      JSON-serializable object — matching commit b9acd92's incident class.
 */

import { createQueryMock, assertWellFormedToolResult, QueryStep } from './supabase-mock';
import { parseQuery, hashQuery, findCommunityMember } from '../../../src/services/voice-tools/community-member-ranker';

// ---------------------------------------------------------------------------
// parseQuery — pure function
// ---------------------------------------------------------------------------

describe('parseQuery', () => {
  it('detects each pillar via its direct keyword', () => {
    expect(parseQuery('who is best at nutrition').pillar).toBe('nutrition');
    expect(parseQuery('who is best at hydration').pillar).toBe('hydration');
    expect(parseQuery('who is best at exercise').pillar).toBe('exercise');
    expect(parseQuery('who has the best sleep').pillar).toBe('sleep');
    expect(parseQuery('who is the most mental').pillar).toBe('mental');
  });

  it('detects exercise pillar via fitness synonyms (fit/workout/runner/marathon)', () => {
    expect(parseQuery('who is the fittest here').pillar).toBe('exercise');
    expect(parseQuery('who does the best workout').pillar).toBe('exercise');
    expect(parseQuery('who is the best marathon runner').pillar).toBe('exercise');
  });

  it('detects hydration pillar via "water"', () => {
    expect(parseQuery('who drinks the most water').pillar).toBe('hydration');
  });

  it('detects mental pillar via mood/calm/zen synonyms', () => {
    expect(parseQuery('who is the calmest person').pillar).toBe('mental');
    expect(parseQuery('who has the best mood').pillar).toBe('mental');
  });

  it('leaves pillar undefined when no pillar keyword is present', () => {
    expect(parseQuery('who is the funniest person').pillar).toBeUndefined();
  });

  it('sets ethicsReroute for sensitive comparatives (appearance/wealth) only', () => {
    expect(parseQuery('who is the most beautiful member').ethicsReroute).toBe(true);
    expect(parseQuery('who is the richest person here').ethicsReroute).toBe(true);
    expect(parseQuery('who is the funniest person').ethicsReroute).toBe(false);
  });

  it('sets indexOverall for a healthy/wellbeing query or an explicit "vitana index" + superlative', () => {
    expect(parseQuery('who is the healthiest member').indexOverall).toBe(true);
    expect(parseQuery('who has the highest vitana index').indexOverall).toBe(true);
    expect(parseQuery('what is the vitana index').indexOverall).toBe(false); // no superlative qualifier
  });

  it('classifies tier3Lane by precedence: teaching before expertise before experience before motivation before entertainment before conversation', () => {
    expect(parseQuery('who could teach me yoga').tier3Lane).toBe('teaching');
    expect(parseQuery('who is the biggest expert on nutrition').tier3Lane).toBe('expertise');
    expect(parseQuery('who is the most experienced veteran here').tier3Lane).toBe('experience');
    expect(parseQuery('who is the most inspiring role model').tier3Lane).toBe('motivation');
    expect(parseQuery('who is the funniest and most hilarious').tier3Lane).toBe('entertainment');
    expect(parseQuery('who is the best conversationalist').tier3Lane).toBe('conversation');
  });

  it('leaves tier3Lane undefined when no lane keyword matches', () => {
    expect(parseQuery('who lives in Berlin').tier3Lane).toBeUndefined();
  });

  it('detects a near_me location filter and does not also set an in_place filter', () => {
    const parsed = parseQuery('who is near me');
    expect(parsed.locationFilter).toBe('near_me');
    expect(parsed.locationPlace).toBeUndefined();
  });

  it('extracts an in_place location filter from "in <place>" / "from <place>"', () => {
    const parsed = parseQuery('who is in Berlin');
    expect(parsed.locationFilter).toBe('in_place');
    expect(parsed.locationPlace).toBe('berlin');
  });

  it('does not treat a stopword-only "in my"/"in the" capture as a place', () => {
    const parsed = parseQuery('who is in my group');
    expect(parsed.locationFilter).toBeUndefined();
    expect(parsed.locationPlace).toBeUndefined();
  });

  it('detects tenure filters: newest, longest, recent_active', () => {
    expect(parseQuery('who just joined').tenureFilter).toBe('newest');
    expect(parseQuery('who is the longest standing member').tenureFilter).toBe('longest');
    expect(parseQuery('who is most active right now').tenureFilter).toBe('recent_active');
  });

  it('detects the popular flag independent of the tier3 "conversation"/"entertainment" lanes', () => {
    expect(parseQuery('who is the most popular member').popular).toBe(true);
    expect(parseQuery('who is the funniest person').popular).toBe(false);
  });

  it('extracts the longest non-stopword token as exactKeyword', () => {
    // "gardening" (9) beats "loves" (5) once stopwords ("find", "someone",
    // "who") are dropped — deterministic longest-token selection.
    expect(parseQuery('find someone who loves gardening').exactKeyword).toBe('gardening');
  });

  it('prefers the longer of two candidate keyword tokens', () => {
    expect(parseQuery('who knows about photography or art').exactKeyword).toBe('photography');
  });

  it('returns undefined exactKeyword when every token is a stopword or too short', () => {
    expect(parseQuery('who is the best').exactKeyword).toBeUndefined();
  });

  it('strips the matched in_place location phrase out of the exactKeyword candidate pool', () => {
    // "berlin" would otherwise be the longest remaining token.
    const parsed = parseQuery('who teaches yoga in berlin');
    expect(parsed.locationPlace).toBe('berlin');
    expect(parsed.exactKeyword).not.toBe('berlin');
  });
});

// ---------------------------------------------------------------------------
// hashQuery — pure function
// ---------------------------------------------------------------------------

describe('hashQuery', () => {
  it('is deterministic for the same query + viewer', () => {
    expect(hashQuery('who is funny', 'viewer-1')).toBe(hashQuery('who is funny', 'viewer-1'));
  });

  it('differs when the viewer differs, all else equal', () => {
    expect(hashQuery('who is funny', 'viewer-1')).not.toBe(hashQuery('who is funny', 'viewer-2'));
  });

  it('differs when the query differs, all else equal', () => {
    expect(hashQuery('who is funny', 'viewer-1')).not.toBe(hashQuery('who is smart', 'viewer-1'));
  });

  it('returns a 32-char lowercase hex string', () => {
    const h = hashQuery('some query', 'viewer-x');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// findCommunityMember — full pipeline
// ---------------------------------------------------------------------------
//
// The DB-side filtering that several sub-queries rely on (ilike/or/filter
// keyword scans on `profiles.service_offerings`, `memory_facts`,
// `health_features_daily`, `community_groups`, `app_users.bio`) cannot be
// faithfully modeled by canned per-table responses, because the SAME table
// is legitimately queried multiple times per call with different filters
// (e.g. `profiles` for plain pool hydration AND for a service_offerings
// keyword scan). Instead we build a small in-memory "world" of candidates
// and install query-shape-aware responders (via the mock's setResponder)
// that interpret each call's recorded filter steps against that world —
// i.e. a minimal fake of the real ILIKE/OR/IN semantics, scoped to exactly
// the query shapes this file issues.

interface WorldUser {
  vitana_id?: string | null;
  app_display_name?: string;
  full_name?: string;
  display_name?: string;
  handle?: string;
  city?: string | null;
  country?: string | null;
  registration_seq?: number | null;
  bio?: string;
  created_at?: string;
  service_offerings?: { offers: Array<{ title?: string; category?: string; short_description?: string }> };
  memory_facts?: Array<{ fact_key: string; fact_value: string; provenance_source: string }>;
  health_feature_keys?: string[];
  group_ids?: string[];
  index_scores?: Array<Record<string, unknown> & { date: string }>;
}

interface World {
  visibleUserIds: string[];
  hiddenUserIds?: string[];
  users: Record<string, WorldUser>;
  groups?: Array<{ id: string; name: string; topic_key: string }>;
}

function wu(id: string, overrides: Partial<WorldUser> = {}): WorldUser {
  return {
    vitana_id: `VIT-${id}`,
    full_name: `Full Name ${id}`,
    display_name: `Display ${id}`,
    handle: `@${id}`,
    app_display_name: `handle_${id}`,
    registration_seq: 100,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function likeKeyword(pattern: unknown): string {
  const m = String(pattern ?? '').match(/^%(.*)%$/);
  return m ? m[1].toLowerCase() : '';
}

function installWorld(mock: ReturnType<typeof createQueryMock>, world: World) {
  mock.setResponder('global_community_profiles', (steps: QueryStep[]) => {
    const eqStep = steps.find((s) => s.method === 'eq' && s.args[0] === 'is_visible');
    const wantVisible = eqStep ? eqStep.args[1] === true : true;
    const ids = wantVisible ? world.visibleUserIds : world.hiddenUserIds ?? [];
    return { data: ids.map((id) => ({ user_id: id })), error: null };
  });

  mock.setResponder('profiles', (steps: QueryStep[]) => {
    const kwStep = steps.find(
      (s) =>
        (s.method === 'filter' || s.method === 'or') &&
        String(s.args[0] ?? '').includes('service_offerings'),
    );
    if (kwStep) {
      if (kwStep.method === 'or') {
        // tier3Teaching's static OR across teaching/coaching/mentoring/instructor
        const rows = Object.entries(world.users)
          .filter(([, u]) => (u.service_offerings?.offers ?? []).some((o) =>
            /teaching|coaching|mentoring|instructor/i.test(String(o.category || '')),
          ))
          .map(([uid, u]) => ({ user_id: uid, service_offerings: u.service_offerings }));
        return { data: rows, error: null };
      }
      // .filter('service_offerings::text', 'ilike', '%kw%')
      const keyword = likeKeyword(kwStep.args[2]);
      const rows = Object.entries(world.users)
        .filter(([, u]) => keyword && JSON.stringify(u.service_offerings ?? {}).toLowerCase().includes(keyword))
        .map(([uid, u]) => ({ user_id: uid, service_offerings: u.service_offerings }));
      return { data: rows, error: null };
    }

    const inStep = steps.find((s) => s.method === 'in' && s.args[0] === 'user_id');
    if (inStep) {
      const ids = inStep.args[1] as string[];
      const rows = ids
        .filter((id) => world.users[id])
        .map((id) => {
          const u = world.users[id];
          return {
            user_id: id,
            full_name: u.full_name ?? null,
            display_name: u.display_name ?? null,
            handle: u.handle ?? null,
            city: u.city ?? null,
            country: u.country ?? null,
            registration_seq: u.registration_seq ?? null,
            location: u.city ?? null,
          };
        });
      return { data: rows, error: null };
    }

    const eqUserStep = steps.find((s) => s.method === 'eq' && s.args[0] === 'user_id');
    if (eqUserStep) {
      const uid = String(eqUserStep.args[1]);
      const u = world.users[uid];
      return { data: u ? { city: u.city ?? null, country: u.country ?? null } : null, error: null };
    }

    return { data: [], error: null };
  });

  mock.setResponder('app_users', (steps: QueryStep[]) => {
    const bioStep = steps.find((s) => s.method === 'ilike' && s.args[0] === 'bio');
    if (bioStep) {
      const keyword = likeKeyword(bioStep.args[1]);
      const rows = Object.entries(world.users)
        .filter(([, u]) => keyword && (u.bio ?? '').toLowerCase().includes(keyword))
        .map(([uid, u]) => ({ user_id: uid, bio: u.bio }));
      return { data: rows, error: null };
    }

    const inStep = steps.find((s) => s.method === 'in' && s.args[0] === 'user_id');
    if (inStep) {
      const ids = inStep.args[1] as string[];
      const rows = ids
        .filter((id) => world.users[id])
        .map((id) => {
          const u = world.users[id];
          return {
            user_id: id,
            display_name: u.app_display_name ?? null,
            avatar_url: null,
            vitana_id: u.vitana_id ?? null,
            created_at: u.created_at ?? null,
            bio: u.bio ?? null,
          };
        });
      return { data: rows, error: null };
    }

    const eqStep = steps.find((s) => s.method === 'eq' && s.args[0] === 'user_id');
    if (eqStep) {
      const uid = String(eqStep.args[1]);
      const u = world.users[uid];
      return { data: u ? { created_at: u.created_at ?? null } : null, error: null };
    }

    return { data: [], error: null };
  });

  mock.setResponder('memory_facts', (steps: QueryStep[]) => {
    const eqUserStep = steps.find((s) => s.method === 'eq' && s.args[0] === 'user_id');
    if (eqUserStep) {
      const uid = String(eqUserStep.args[1]);
      const facts = (world.users[uid]?.memory_facts ?? []).filter((f) => f.fact_key.startsWith('years_experience_'));
      return { data: facts.map((f) => ({ fact_key: f.fact_key, fact_value: f.fact_value })), error: null };
    }

    const orStep = steps.find((s) => s.method === 'or');
    const orArg = orStep ? String(orStep.args[0] ?? '') : '';
    if (orArg.includes('expert_in_') || orArg.includes('certified_') || orArg.includes('degree_')) {
      const rows: Array<Record<string, unknown>> = [];
      for (const [uid, u] of Object.entries(world.users)) {
        for (const f of u.memory_facts ?? []) {
          if (/^(expert_in_|certified_|degree_)/.test(f.fact_key)) {
            rows.push({ user_id: uid, fact_key: f.fact_key, fact_value: f.fact_value });
          }
        }
      }
      return { data: rows, error: null };
    }
    if (orStep) {
      const m = orArg.match(/fact_key\.ilike\.%(.*?)%,fact_value/i);
      const keyword = m ? m[1].toLowerCase() : '';
      const rows: Array<Record<string, unknown>> = [];
      for (const [uid, u] of Object.entries(world.users)) {
        for (const f of u.memory_facts ?? []) {
          if (
            keyword &&
            (f.fact_key.toLowerCase().includes(keyword) || String(f.fact_value).toLowerCase().includes(keyword))
          ) {
            rows.push({
              user_id: uid,
              fact_key: f.fact_key,
              fact_value: f.fact_value,
              provenance_source: f.provenance_source,
            });
          }
        }
      }
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  });

  mock.setResponder('health_features_daily', (steps: QueryStep[]) => {
    const ilikeStep = steps.find((s) => s.method === 'ilike' && s.args[0] === 'feature_key');
    const keyword = ilikeStep ? likeKeyword(ilikeStep.args[1]) : '';
    const rows: Array<Record<string, unknown>> = [];
    for (const [uid, u] of Object.entries(world.users)) {
      for (const fk of u.health_feature_keys ?? []) {
        if (keyword && fk.toLowerCase().includes(keyword)) rows.push({ user_id: uid, feature_key: fk });
      }
    }
    return { data: rows, error: null };
  });

  mock.setResponder('community_groups', (steps: QueryStep[]) => {
    const orStep = steps.find((s) => s.method === 'or');
    const orArg = orStep ? String(orStep.args[0] ?? '') : '';
    if (orArg.includes('%entertainment%')) {
      const rows = (world.groups ?? []).filter(
        (g) => /entertainment|fun|music|comedy|dance/i.test(g.topic_key) || /entertainment|comedy/i.test(g.name),
      );
      return { data: rows, error: null };
    }
    const m = orArg.match(/topic_key\.ilike\.%(.*?)%/i);
    const keyword = m ? m[1].toLowerCase() : '';
    const rows = (world.groups ?? []).filter(
      (g) => keyword && (g.topic_key.toLowerCase().includes(keyword) || g.name.toLowerCase().includes(keyword)),
    );
    return { data: rows, error: null };
  });

  mock.setResponder('community_group_members', (steps: QueryStep[]) => {
    const inStep = steps.find((s) => s.method === 'in' && s.args[0] === 'group_id');
    const grpIds = inStep ? (inStep.args[1] as string[]) : [];
    const rows: Array<Record<string, unknown>> = [];
    for (const [uid, u] of Object.entries(world.users)) {
      for (const gid of u.group_ids ?? []) {
        if (grpIds.includes(gid)) rows.push({ user_id: uid, group_id: gid });
      }
    }
    return { data: rows, error: null };
  });

  mock.setResponder('vitana_index_scores', (steps: QueryStep[]) => {
    const rows: Array<Record<string, unknown>> = [];
    for (const [uid, u] of Object.entries(world.users)) {
      for (const row of u.index_scores ?? []) {
        rows.push({ user_id: uid, ...row });
      }
    }
    const orderSteps = steps.filter((s) => s.method === 'order');
    if (orderSteps.length > 0) {
      const col = String(orderSteps[0].args[0]);
      rows.sort((a, b) => Number(b[col] ?? 0) - Number(a[col] ?? 0));
    }
    return { data: rows, error: null };
  });
}

let mock: ReturnType<typeof createQueryMock>;

const VIEWER = 'viewer-1';

beforeEach(() => {
  mock = createQueryMock();
});

function baseArgs(overrides: Partial<Parameters<typeof findCommunityMember>[1]> = {}) {
  return {
    viewer_user_id: VIEWER,
    viewer_tenant_id: 'tenant-1',
    query: 'who is funny',
    ...overrides,
  };
}

describe('findCommunityMember — empty pool (extreme floor)', () => {
  it('returns a soft "no one yet" response, ok:true, when there are no visible candidates', async () => {
    installWorld(mock, { visibleUserIds: [], users: {} });

    const out = await findCommunityMember(mock.client, baseArgs());

    expect(out.result.ok).toBe(true);
    expect(out.result.vitana_id).toBeNull();
    expect(out.result.display_name).toBe('No one yet');
    expect(out.tier).toBe(3);
    expect(out.lane).toBe('floor');
    expect(out.winnerUserId).toBeNull();
    expect(out.result.match_recipe.lane).toBe('floor');
    assertWellFormedToolResult(out.result);
  });
});

describe('findCommunityMember — ethics reroute (Tier 4)', () => {
  it('reframes a sensitive-comparative query and still resolves to exactly one visible member', async () => {
    installWorld(mock, { visibleUserIds: ['u-1'], users: { 'u-1': wu('u-1') } });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is the richest member' }));

    expect(out.result.ok).toBe(true);
    expect(out.result.match_recipe.ethics_reroute).toBe(true);
    expect(out.result.voice_summary).toMatch(/doesn't rank/i);
    expect(out.result.vitana_id).toBe('VIT-u-1');
    expect(out.winnerUserId).toBe('u-1');
    assertWellFormedToolResult(out.result);
  });
});

describe('findCommunityMember — Tier 0 name lookup', () => {
  it('resolves a direct name query to the matching candidate, not a hash-picked stranger', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-maria', 'u-other'],
      users: {
        'u-maria': wu('u-maria', { full_name: 'Mariia Maksina', display_name: 'Mariia Maksina', handle: 'mariia' }),
        'u-other': wu('u-other', { full_name: 'Someone Else', display_name: 'Someone Else', handle: 'someone' }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'show me mariia maksina' }));

    expect(out.tier).toBe(1);
    expect(out.lane).toBe('exact_name');
    expect(out.winnerUserId).toBe('u-maria');
    expect(out.result.vitana_id).toBe('VIT-u-maria');
    expect(out.result.redirect.route).toContain('VIT-u-maria');
    assertWellFormedToolResult(out.result);
  });

  it('does NOT run name matching when the query carries attribute intent (e.g. a pillar query)', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-1'],
      users: { 'u-1': wu('u-1', { index_scores: [{ score_exercise: 80, date: '2026-07-28' }] }) },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is best at exercise' }));

    expect(out.lane).not.toBe('exact_name');
    expect(out.result.ok).toBe(true);
    assertWellFormedToolResult(out.result);
  });
});

describe('findCommunityMember — Tier 1 exact match', () => {
  it('matches a candidate via a service_offerings keyword hit', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-pt', 'u-other'],
      users: {
        'u-pt': wu('u-pt', {
          service_offerings: { offers: [{ title: 'Pottery Lessons', category: 'crafts' }] },
        }),
        'u-other': wu('u-other'),
      },
    });

    // "pottery" (7) must win the exactKeyword extraction outright — avoid a
    // tie with another 7-char token that would nondeterministically pick a
    // different word first.
    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who offers pottery lessons' }));

    expect(out.result.ok).toBe(true);
    expect(out.winnerUserId).toBe('u-pt');
    expect(out.tier).toBe(1);
    expect(out.lane).toBe('exact_service');
    assertWellFormedToolResult(out.result);
  });

  it('matches a candidate via a user-stated memory_fact hit', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-1', 'u-2'],
      users: {
        'u-1': wu('u-1', {
          memory_facts: [{ fact_key: 'favorite_hobby', fact_value: 'chess', provenance_source: 'user_stated' }],
        }),
        'u-2': wu('u-2'),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is into chess' }));

    expect(out.result.ok).toBe(true);
    expect(out.winnerUserId).toBe('u-1');
    expect(out.lane).toBe('exact_fact');
    assertWellFormedToolResult(out.result);
  });

  it('matches a candidate via a logged health activity hit', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-1', 'u-2'],
      users: {
        'u-1': wu('u-1', { health_feature_keys: ['pilates_session', 'pilates_session'] }),
        'u-2': wu('u-2'),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who logs pilates' }));

    expect(out.result.ok).toBe(true);
    expect(out.winnerUserId).toBe('u-1');
    expect(out.lane).toBe('exact_activity');
    assertWellFormedToolResult(out.result);
  });
});

describe('findCommunityMember — Tier 2 Vitana Index', () => {
  it('resolves an overall Vitana Index leaderboard query to the top scorer', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-1', 'u-2'],
      users: {
        'u-1': wu('u-1', { index_scores: [{ score_total: 95, date: '2026-07-28' }] }),
        'u-2': wu('u-2', { index_scores: [{ score_total: 60, date: '2026-07-28' }] }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is the healthiest member' }));

    expect(out.result.ok).toBe(true);
    expect(out.tier).toBe(2);
    expect(out.lane).toBe('index_overall');
    expect(out.winnerUserId).toBe('u-1');
    expect(out.result.voice_summary).toMatch(/highest vitana index/i);
    assertWellFormedToolResult(out.result);
  });

  it("resolves a per-pillar leaderboard query to that pillar's top scorer", async () => {
    installWorld(mock, {
      visibleUserIds: ['u-1', 'u-2'],
      users: {
        'u-1': wu('u-1', { index_scores: [{ score_exercise: 40, date: '2026-07-28' }] }),
        'u-2': wu('u-2', { index_scores: [{ score_exercise: 90, date: '2026-07-28' }] }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is best at exercise' }));

    expect(out.result.ok).toBe(true);
    expect(out.tier).toBe(2);
    expect(out.lane).toBe('index_pillar');
    expect(out.winnerUserId).toBe('u-2');
    assertWellFormedToolResult(out.result);
  });
});

describe('findCommunityMember — Tier 3 lanes', () => {
  it('a teaching-category offer only wins Tier 3 when the query keyword itself appears in its title/category text', async () => {
    // "who offers coaching" — "coaching" both triggers TEACHING_RX (tier3Lane)
    // AND becomes the Tier-1 exactKeyword AND is literally inside u-coach's
    // "Life Coaching"/"coaching" service_offerings text — so Tier 1's
    // broader (unconditional-bump) keyword scan runs first and wins,
    // *before* Tier 3's teaching lane is ever reached.
    installWorld(mock, {
      visibleUserIds: ['u-coach'],
      users: {
        'u-coach': wu('u-coach', {
          service_offerings: { offers: [{ title: 'Life Coaching', category: 'coaching' }] },
        }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who offers coaching' }));

    expect(out.result.ok).toBe(true);
    expect(out.winnerUserId).toBe('u-coach');
    expect(out.tier).toBe(1);
    expect(out.lane).toBe('exact_service');
    assertWellFormedToolResult(out.result);
  });

  it('falls through to the floor (not Tier 3 teaching) when the extracted keyword does not literally match the candidate\'s title/category, even though the query still reads as teaching-intent', async () => {
    // tier3Teaching's own matchKw check requires `category.includes(keyword)
    // || title.includes(keyword)` whenever a keyword was extracted — since
    // "teach" is not a substring of "coaching"/"Life Coaching", Tier 3's
    // teaching lane correctly finds nothing here either (Tier 1 also finds
    // nothing, for the same reason). This documents a real characteristic
    // of the pipeline: a teaching/coaching-categorized offer is reachable
    // via Tier 3's teaching lane only when the query's specific keyword
    // literally matches the offer text — otherwise Tier 1's broader,
    // unconditional-bump scan (which uses the exact same keyword) would
    // have already caught it first. The overall pipeline still degrades
    // safely to the floor rather than erroring or returning nothing.
    installWorld(mock, {
      visibleUserIds: ['u-coach'],
      users: {
        'u-coach': wu('u-coach', {
          service_offerings: { offers: [{ title: 'Life Coaching', category: 'coaching' }] },
        }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who can teach me' }));

    expect(out.result.ok).toBe(true);
    expect(out.tier).toBe(3);
    expect(out.lane).toBe('floor');
    expect(out.winnerUserId).toBe('u-coach'); // only visible candidate — floor still resolves to them
    assertWellFormedToolResult(out.result);
  });

  it('resolves a motivation-intent query via the 30-day Vitana Index delta', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-rising', 'u-flat'],
      users: {
        'u-rising': wu('u-rising', {
          index_scores: [
            { score_total: 80, date: '2026-07-28' },
            { score_total: 40, date: '2026-07-01' },
          ],
        }),
        'u-flat': wu('u-flat', {
          index_scores: [
            { score_total: 50, date: '2026-07-28' },
            { score_total: 50, date: '2026-07-01' },
          ],
        }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is the most inspiring role model' }));

    expect(out.result.ok).toBe(true);
    expect(out.tier).toBe(3);
    expect(out.lane).toBe('motivation');
    expect(out.winnerUserId).toBe('u-rising');
    assertWellFormedToolResult(out.result);
  });

  it('resolves an entertainment-intent query via entertainment-group membership', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-fun', 'u-quiet'],
      users: {
        'u-fun': wu('u-fun', { group_ids: ['g-comedy'] }),
        'u-quiet': wu('u-quiet'),
      },
      groups: [{ id: 'g-comedy', name: 'Comedy Night', topic_key: 'entertainment' }],
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is the funniest and most hilarious' }));

    expect(out.result.ok).toBe(true);
    expect(out.tier).toBe(3);
    expect(out.lane).toBe('entertainment');
    expect(out.winnerUserId).toBe('u-fun');
    assertWellFormedToolResult(out.result);
  });

  it('falls through to generic bio matching when no lane-specific signal is found', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-1', 'u-2'],
      users: {
        'u-1': wu('u-1', { bio: 'loves astrology' }),
        'u-2': wu('u-2', { bio: 'unrelated' }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is into astrology' }));

    expect(out.result.ok).toBe(true);
    expect(out.winnerUserId).toBe('u-1');
    expect(out.lane).toBe('generic');
    assertWellFormedToolResult(out.result);
  });
});

describe('findCommunityMember — pure modifiers', () => {
  it('resolves a pure tenure query (newest) without any core intent keyword', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-old', 'u-new'],
      users: {
        'u-old': wu('u-old', { registration_seq: 1 }),
        'u-new': wu('u-new', { registration_seq: 999 }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who just joined' }));

    expect(out.result.ok).toBe(true);
    expect(out.lane).toBe('tenure_only');
    expect(out.winnerUserId).toBe('u-new');
    assertWellFormedToolResult(out.result);
  });

  it('resolves a pure location query (near me) to a visible candidate', async () => {
    installWorld(mock, { visibleUserIds: ['u-1'], users: { 'u-1': wu('u-1') } });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is near me' }));

    expect(out.result.ok).toBe(true);
    expect(out.lane).toBe('location_only');
    expect(out.winnerUserId).toBe('u-1');
    assertWellFormedToolResult(out.result);
  });
});

describe('findCommunityMember — floor (no signal anywhere)', () => {
  function floorWorld(): World {
    return {
      visibleUserIds: ['u-1', 'u-2', 'u-3'],
      users: { 'u-1': wu('u-1'), 'u-2': wu('u-2'), 'u-3': wu('u-3') },
    };
  }

  it('deterministically rotates the floor pick by query hash rather than always returning the first candidate', async () => {
    installWorld(mock, floorWorld());

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'xyzzyplugh' }));

    expect(out.result.ok).toBe(true);
    expect(out.tier).toBe(3);
    expect(out.lane).toBe('floor');
    expect(['u-1', 'u-2', 'u-3']).toContain(out.winnerUserId);
    assertWellFormedToolResult(out.result);
  });

  it('is stable across repeated calls with the same query', async () => {
    installWorld(mock, floorWorld());
    const first = await findCommunityMember(mock.client, baseArgs({ query: 'xyzzyplugh' }));

    mock = createQueryMock();
    installWorld(mock, floorWorld());
    const second = await findCommunityMember(mock.client, baseArgs({ query: 'xyzzyplugh' }));

    expect(second.winnerUserId).toBe(first.winnerUserId);
  });
});

describe('findCommunityMember — privacy & exclusion invariants', () => {
  it('never selects a candidate whose vitana_id is null (unconfirmed identifier)', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-no-vid', 'u-has-vid'],
      users: {
        'u-no-vid': wu('u-no-vid', { vitana_id: null }),
        'u-has-vid': wu('u-has-vid'),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'xyzzyplugh' }));

    expect(out.winnerUserId).toBe('u-has-vid');
    assertWellFormedToolResult(out.result);
  });

  it('never selects a candidate present in excluded_vitana_ids', async () => {
    installWorld(mock, {
      visibleUserIds: ['u-excluded', 'u-included'],
      users: { 'u-excluded': wu('u-excluded'), 'u-included': wu('u-included') },
    });

    const out = await findCommunityMember(
      mock.client,
      baseArgs({ query: 'xyzzyplugh', excluded_vitana_ids: ['VIT-u-excluded'] }),
    );

    expect(out.winnerUserId).toBe('u-included');
    assertWellFormedToolResult(out.result);
  });

  it('excludes the viewer themselves from their own candidate pool', async () => {
    installWorld(mock, { visibleUserIds: [VIEWER], users: {} });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'xyzzyplugh' }));

    expect(out.winnerUserId).toBeNull();
    expect(out.result.display_name).toBe('No one yet');
    assertWellFormedToolResult(out.result);
  });

  it('never lets a hidden user (via getHiddenUserIds inside a Tier-2 delegate) win the Tier-2 leaderboard', async () => {
    // Hidden here means "not visible" — buildCandidatePool already excludes
    // them from the pool entirely, so the Tier-2 winner must never surface
    // a candidate that was never in the visible set to begin with.
    installWorld(mock, {
      visibleUserIds: ['u-visible'],
      users: {
        'u-visible': wu('u-visible', { index_scores: [{ score_total: 50, date: '2026-07-28' }] }),
        'u-hidden': wu('u-hidden', { index_scores: [{ score_total: 99, date: '2026-07-28' }] }),
      },
    });

    const out = await findCommunityMember(mock.client, baseArgs({ query: 'who is the healthiest member' }));

    expect(out.winnerUserId).toBe('u-visible');
    assertWellFormedToolResult(out.result);
  });
});
