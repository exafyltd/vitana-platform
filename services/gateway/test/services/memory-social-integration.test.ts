// BOOTSTRAP-SOCIAL-MEMORY — INTEGRATION tests: memory orchestrator × social
// context pack working IN COMBINATION.
//
// Unlike the unit suites, these tests run the REAL chain
//   buildAssistantMemoryContext
//     → detectSocialIntent → buildAssistantSocialContext
//       → social-memory-repository → builders → rankers → prompt renderer
//     → formatMemoryContextForPrompt (sentinel block assembly)
// against a table-aware fake database, and assert on the FINAL prompt block
// the LLM would receive plus the per-turn telemetry.
//
// Covered contracts:
//   1. Social person question → ONE sentinel block containing BOTH personal
//      memory sections AND <social_context> with person intelligence,
//      goals still loaded, self-check last; telemetry social_loaded=true.
//   2. "Wem folge ich?" / followers / matches questions render the right
//      social sections with names, scores, and reasons.
//   3. Non-social question → NO social fetch, telemetry social_loaded=false.
//   4. Developer role → never receives community social context.
//   5. Blocked person → person context absent (as if not found).
//   6. Person-focus queries persist ONE meaningful memory via the existing
//      write path (writeMemoryItemWithIdentity).

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../src/services/context-pack-builder', () => {
  const actual = jest.requireActual('../../src/services/context-pack-builder');
  return { ...actual, buildContextPack: jest.fn() };
});

jest.mock('../../src/services/memory-broker', () => ({
  getMemoryContext: jest.fn().mockResolvedValue({
    ok: true,
    intent: 'community_intent',
    blocks: { GOVERNANCE: { kind: 'GOVERNANCE', dismissals: [], pauses: [], source: '', fetched_at: '' } },
    meta: {},
  }),
}));

jest.mock('../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

import { buildAssistantMemoryContext, MEMORY_CONTEXT_SENTINEL, MEMORY_CONTEXT_END_SENTINEL } from '../../src/services/memory-orchestrator';
import { buildContextPack } from '../../src/services/context-pack-builder';
import { getSupabase } from '../../src/lib/supabase';
import { writeMemoryItemWithIdentity } from '../../src/services/orb-memory-bridge';
import type { ContextPack } from '../../src/types/conversation';

const mockedBuildContextPack = buildContextPack as jest.MockedFunction<typeof buildContextPack>;
const mockedGetSupabase = getSupabase as jest.MockedFunction<any>;
const mockedWriteMemory = writeMemoryItemWithIdentity as jest.MockedFunction<any>;

// ---------------------------------------------------------------------------
// Fixture identities
// ---------------------------------------------------------------------------

const ME = 'me-0000';
const MARIIA = 'mariia-0000';
const ANNA = 'anna-0000';
const TENANT = 'tenant-0000';

const PROFILES = [
  { user_id: ME, display_name: 'Test User', handle: 'test', vitana_id: '@test', avatar_url: null, bio: null, city: 'Berlin', country: 'DE', account_visibility: null, full_name: 'Test User' },
  { user_id: MARIIA, display_name: 'Mariia Maksina', handle: 'mariia', vitana_id: '@mariia', avatar_url: null, bio: 'Dance & longevity', city: 'Berlin', country: 'DE', account_visibility: null, full_name: 'Mariia Maksina' },
  { user_id: ANNA, display_name: 'Anna Schmidt', handle: 'anna', vitana_id: '@anna', avatar_url: null, bio: null, city: 'Hamburg', country: 'DE', account_visibility: null, full_name: 'Anna Schmidt' },
];

/**
 * Table-aware fake supabase: chainable query builder that records the table
 * and selected columns, then resolves rows from the handler. Filters are not
 * evaluated (queries are already user-scoped in the repository); direction-
 * dependent reads (user_follows) are disambiguated by the SELECT column list.
 */
function makeFakeSupabase(overrides: Record<string, (select: string) => any[]> = {}) {
  const tables: Record<string, (select: string) => any[]> = {
    profiles: () => PROFILES,
    profile_privacy_settings: () => [{ searchable: true }],
    user_follows: (select) =>
      select.includes('following_id')
        ? [{ following_id: MARIIA, created_at: '2026-07-01T00:00:00Z', id: 'f1' }]
        : [{ follower_id: ANNA, created_at: '2026-07-02T00:00:00Z', id: 'f2' }],
    daily_matches: () => [
      {
        matched_user_id: ANNA,
        match_score: '87.00',
        match_reasons: ["You're both strong in Sleep"],
        action: null,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
      },
    ],
    user_matches: () => [],
    chat_messages: (select) =>
      select === 'created_at'
        ? [{ created_at: '2026-07-01T10:00:00Z' }]
        : [
            { sender_id: MARIIA, receiver_id: ME, content: 'Hallo! Kommst du zum Dance Event?', created_at: new Date().toISOString() },
            { sender_id: ME, receiver_id: MARIIA, content: 'Ja, gerne!', created_at: new Date(Date.now() - 3600000).toISOString() },
          ],
    chat_group_members: (select) =>
      select.includes('joined_at')
        ? [{ group_id: 'g1', joined_at: '2026-06-01T00:00:00Z' }]
        : [{ group_id: 'g1' }, { group_id: 'g1' }],
    chat_groups: () => [{ id: 'g1', name: 'Maxina Fitness Chat', is_system: false }],
    profile_posts: () => [
      {
        id: 'p1',
        user_id: MARIIA,
        content: 'New dance session for longevity fans this weekend!',
        image_url: null,
        video_url: null,
        likes_count: 12,
        comments_count: 3,
        created_at: new Date(Date.now() - 7200000).toISOString(),
      },
    ],
    global_community_events: () => [
      {
        id: 'e1',
        title: 'Dance Night Berlin',
        description: 'Dance and longevity meetup',
        event_type: 'meetup',
        start_time: new Date(Date.now() + 2 * 86400000).toISOString(),
        location: 'Berlin',
        slug: 'dance-night-berlin',
        participant_count: 12,
      },
    ],
    global_event_participants: () => [
      { event_id: 'e1', user_id: MARIIA, status: 'registered', registered_at: new Date().toISOString() },
    ],
    global_community_group_members: () => [
      { group_id: 'cg1', user_id: ME, joined_at: '2026-06-01T00:00:00Z' },
      { group_id: 'cg1', user_id: MARIIA, joined_at: '2026-06-02T00:00:00Z' },
    ],
    global_community_groups: () => [{ id: 'cg1', name: 'Maxina Fitness' }],
    user_interests: () => [
      { user_id: ME, interest: 'dance', confidence_score: 0.9 },
      { user_id: ME, interest: 'fitness', confidence_score: 0.8 },
      { user_id: MARIIA, interest: 'dance', confidence_score: 0.9 },
    ],
    user_blocked_authors: () => [],
    user_muted_authors: () => [],
    user_hidden_posts: () => [],
    life_compass: () => [{ primary_goal: 'Improve sleep quality', category: 'sleep' }],
    user_preferences: () => [],
    user_inferred_preferences: () => [],
    ...overrides,
  };

  return {
    from: (table: string) => {
      let selectCols = '';
      const chain: any = {};
      chain.select = (cols: string) => {
        selectCols = cols;
        return chain;
      };
      for (const m of ['eq', 'in', 'or', 'gte', 'lt', 'is', 'neq', 'order', 'limit']) {
        chain[m] = () => chain;
      }
      const resolve = () => {
        const handler = tables[table];
        return { data: handler ? handler(selectCols) : [], error: null };
      };
      chain.maybeSingle = async () => {
        const r = resolve();
        return { data: (r.data && r.data[0]) || null, error: null };
      };
      chain.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej);
      return chain;
    },
  };
}

function makePack(): ContextPack {
  return {
    pack_id: 'pack-1',
    pack_hash: 'hash',
    assembled_at: new Date().toISOString(),
    assembly_duration_ms: 5,
    identity: { tenant_id: TENANT, user_id: ME, role: 'community', display_name: 'Test User' },
    session_state: { thread_id: 't-1', channel: 'operator', turn_number: 1, conversation_start: new Date().toISOString() },
    memory_hits: [
      { id: 'f1', category_key: 'fact:self', content: 'preferred_language: German', importance: 95, occurred_at: new Date().toISOString(), source: 'system_observed', relevance_score: 1 },
    ],
    knowledge_hits: [],
    web_hits: [],
    active_vtids: [],
    tenant_policies: [],
    tool_health: [],
    retrieval_trace: {
      router_decision: { sources_to_query: ['memory_garden'], query_order: ['memory_garden'], limits: { memory_garden: 8, knowledge_hub: 0, web_search: 0, calendar: 0 }, matched_rule: 'test', decided_at: '', rationale: '' },
      sources_queried: ['memory_garden'],
      latencies: { memory_garden: 1, knowledge_hub: 0, web_search: 0, calendar: 0 },
      hit_counts: { memory_garden: 1, knowledge_hub: 0, web_search: 0, calendar: 0 },
    },
    token_budget: { total_budget: 6000, used: 100, remaining: 5900 },
  } as ContextPack;
}

const BASE = {
  tenant_id: TENANT,
  user_id: ME,
  role: 'community',
  channel: 'operator' as const,
  thread_id: 't-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MEMORY_ORCHESTRATOR_ENFORCEMENT;
  mockedBuildContextPack.mockResolvedValue(makePack());
  mockedGetSupabase.mockReturnValue(makeFakeSupabase());
});

// ---------------------------------------------------------------------------

describe('orchestrator × social — combined prompt block', () => {
  it('person question: ONE sentinel block with personal memory + social context + person intelligence + goals + self-check', async () => {
    const result = await buildAssistantMemoryContext({
      ...BASE,
      message: 'Erzähl mir mehr über Mariia Maksina.',
    });

    const block = result.memory_prompt_block;
    // One coherent block, correctly ordered.
    expect(block.indexOf(MEMORY_CONTEXT_SENTINEL)).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('<social_context>')).toBeGreaterThan(block.indexOf(MEMORY_CONTEXT_SENTINEL));
    expect(block.indexOf('MANDATORY SELF-CHECK')).toBeGreaterThan(block.indexOf('</social_context>'));
    expect(block.indexOf(MEMORY_CONTEXT_END_SENTINEL)).toBeGreaterThan(block.indexOf('MANDATORY SELF-CHECK'));

    // Personal memory still present alongside social.
    expect(block).toContain('preferred_language: German');
    expect(block).toContain('<user_goals>');
    expect(block).toContain('Improve sleep quality');

    // Person intelligence for Mariia with relationship + shared context.
    expect(block).toContain('Person in focus — Mariia Maksina');
    // The fake DB returns follow edges in both directions → mutual follow.
    expect(block).toContain('you follow each other');
    expect(block).toContain('Shared interests: dance');
    expect(block).toContain('Shared groups: Maxina Fitness');
    expect(block).toContain('New dance session for longevity fans');

    // Telemetry proves the combination ran.
    expect(result.telemetry.social_loaded).toBe(true);
    expect(result.telemetry.social_intent_kinds).toContain('person_query');
    expect(result.telemetry.goals_loaded).toBe(1);
    expect(result.telemetry.memory_injected_to_prompt).toBe(true);
  });

  it('"Wem folge ich?" renders the follow list; "Wer folgt mir?" the followers', async () => {
    const follows = await buildAssistantMemoryContext({ ...BASE, message: 'Wem folge ich eigentlich?' });
    expect(follows.telemetry.social_loaded).toBe(true);
    expect(follows.memory_prompt_block).toMatch(/Follows \(1\): Mariia Maksina/);

    const followers = await buildAssistantMemoryContext({ ...BASE, message: 'Wer folgt mir?' });
    expect(followers.memory_prompt_block).toMatch(/Followers \(1\): Anna Schmidt/);
  });

  it('matches question renders score + reasons and chat/group/event context', async () => {
    const result = await buildAssistantMemoryContext({
      ...BASE,
      message: 'Welche Matches habe ich und welche Events sollte ich besuchen?',
    });
    const block = result.memory_prompt_block;
    expect(block).toContain('Anna Schmidt (score 87)');
    expect(block).toContain("You're both strong in Sleep");
    expect(block).toContain('Dance Night Berlin');
    expect(block).toContain('person you follow is attending');
    expect(block).toContain('Link: https://vitanaland.com/e/dance-night-berlin');
    expect(block).toContain('Maxina Fitness Chat');
  });

  it('anti-hallucination guidance is always attached to social turns', async () => {
    const result = await buildAssistantMemoryContext({ ...BASE, message: 'Who should I contact today?' });
    expect(result.memory_prompt_block).toContain('never invent people');
    expect(result.memory_prompt_block).toContain('state the reason from the context');
  });
});

describe('orchestrator × social — gating', () => {
  it('non-social question: no social fetch, telemetry social_loaded=false', async () => {
    const result = await buildAssistantMemoryContext({ ...BASE, message: 'Wie kann ich besser schlafen?' });
    expect(result.telemetry.social_loaded).toBe(false);
    expect(result.telemetry.social_intent_kinds).toEqual([]);
    expect(result.memory_prompt_block).not.toContain('<social_context>');
    // Personal memory unchanged.
    expect(result.memory_prompt_block).toContain(MEMORY_CONTEXT_SENTINEL);
    expect(result.memory_prompt_block).toContain('preferred_language: German');
  });

  it('developer role never receives community social context, even for social questions', async () => {
    const result = await buildAssistantMemoryContext({
      ...BASE,
      role: 'developer',
      message: 'Who follows me in the community?',
    });
    expect(result.telemetry.social_loaded).toBe(false);
    expect(result.memory_prompt_block).not.toContain('<social_context>');
  });
});

describe('orchestrator × social — privacy', () => {
  it('blocked person: person context absent, as if not found', async () => {
    mockedGetSupabase.mockReturnValue(
      makeFakeSupabase({
        user_blocked_authors: () => [{ author_id: MARIIA }],
      }),
    );
    const result = await buildAssistantMemoryContext({
      ...BASE,
      message: 'Erzähl mir mehr über Mariia Maksina.',
    });
    expect(result.memory_prompt_block).not.toContain('Person in focus — Mariia Maksina');
    // Blocked author's posts must not be recommended either.
    expect(result.memory_prompt_block).not.toContain('New dance session for longevity fans');
  });

  it('private profile without relationship: name-only + explicit privacy instruction', async () => {
    mockedGetSupabase.mockReturnValue(
      makeFakeSupabase({
        profiles: () =>
          PROFILES.map((p) =>
            p.user_id === MARIIA ? { ...p, account_visibility: 'private' } : p,
          ),
        // no follow edges, no matches, no chats → no relationship
        user_follows: () => [],
        daily_matches: () => [],
        chat_messages: () => [],
      }),
    );
    const result = await buildAssistantMemoryContext({
      ...BASE,
      message: 'Tell me more about Mariia Maksina.',
    });
    expect(result.memory_prompt_block).toContain('PRIVACY: profile is private');
    expect(result.memory_prompt_block).toContain('do NOT speculate');
  });
});

describe('orchestrator × social — meaningful memory persistence', () => {
  it('person-focus question writes ONE network_relationships memory via the existing path', async () => {
    await buildAssistantMemoryContext({ ...BASE, message: 'Erzähl mir mehr über Mariia Maksina.' });
    // fire-and-forget → flush microtasks
    await new Promise((r) => setImmediate(r));
    expect(mockedWriteMemory).toHaveBeenCalledTimes(1);
    const [identity, item] = mockedWriteMemory.mock.calls[0];
    expect(identity).toEqual({ user_id: ME, tenant_id: TENANT });
    expect(item.category_key).toBe('network_relationships');
    expect(item.content).toContain('Mariia Maksina');
    expect(item.content_json.person_id).toBe(MARIIA);
  });

  it('generic social questions do NOT write person-focus memory', async () => {
    await buildAssistantMemoryContext({ ...BASE, message: 'Welche Events sollte ich besuchen?' });
    await new Promise((r) => setImmediate(r));
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });
});
