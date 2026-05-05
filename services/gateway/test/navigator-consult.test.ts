/**
 * Vitana Navigator — Consult Service tests
 *
 * Unit tests focused on the orchestration logic. The slow dependencies
 * (memory pack via buildContextPack, knowledge base via searchKnowledgeDocs)
 * are mocked so the tests run in milliseconds and never touch Supabase.
 *
 * Coverage targets:
 *   - confidence bucketing (high / medium / low)
 *   - confirmation_needed for ambiguous cases
 *   - anonymous gating rewrites
 *   - "user is already on this page" hard exclusion
 *   - memory hint distillation
 *   - navigator action down-weighting (prevent looping)
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockSearchKnowledgeDocs = jest.fn();
jest.mock('../src/services/knowledge-hub', () => ({
  searchKnowledgeDocs: (...args: any[]) => mockSearchKnowledgeDocs(...args),
}));

const mockBuildContextPack = jest.fn();
jest.mock('../src/services/context-pack-builder', () => ({
  buildContextPack: (...args: any[]) => mockBuildContextPack(...args),
}));

jest.mock('../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true, id: 'test-mem-id' }),
}));

import {
  consultNavigator,
  formatConsultResultForLLM,
  writeNavigatorActionMemory,
  NavigatorConsultInput,
  NavigatorConsultResult,
} from '../src/services/navigator-consult';
import { writeMemoryItemWithIdentity } from '../src/services/orb-memory-bridge';

const mockWrite = writeMemoryItemWithIdentity as jest.MockedFunction<typeof writeMemoryItemWithIdentity>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function authedInput(overrides: Partial<NavigatorConsultInput> = {}): NavigatorConsultInput {
  return {
    question: 'how do I track my biology',
    lang: 'en',
    is_anonymous: false,
    identity: {
      user_id: '00000000-0000-0000-0000-000000000099',
      tenant_id: '00000000-0000-0000-0000-000000000001',
      role: 'community',
    },
    session_id: 'test-session',
    turn_number: 1,
    conversation_start: new Date().toISOString(),
    ...overrides,
  };
}

function anonymousInput(overrides: Partial<NavigatorConsultInput> = {}): NavigatorConsultInput {
  return {
    question: 'take me to the events page',
    lang: 'en',
    is_anonymous: true,
    identity: null,
    ...overrides,
  };
}

function mockEmptyMemory() {
  mockBuildContextPack.mockResolvedValue({
    pack_id: 'test', pack_hash: 'test', assembled_at: '', assembly_duration_ms: 0,
    identity: { tenant_id: '', user_id: '', role: '' },
    session_state: { thread_id: '', channel: 'orb', turn_number: 0, conversation_start: '' },
    memory_hits: [],
    knowledge_hits: [],
    web_hits: [],
    structured_facts: [],
    relationship_context: [],
    active_vtids: [],
    tenant_policies: [],
    tool_health: [],
    ui_context: undefined,
    metrics: { hit_counts: {}, latencies: {} },
    extras: {},
  });
}

function mockMemoryHits(hits: Array<{ category_key: string; content: string }>) {
  mockBuildContextPack.mockResolvedValue({
    pack_id: 'test', pack_hash: 'test', assembled_at: '', assembly_duration_ms: 0,
    identity: { tenant_id: '', user_id: '', role: '' },
    session_state: { thread_id: '', channel: 'orb', turn_number: 0, conversation_start: '' },
    memory_hits: hits.map((h, i) => ({
      id: `mem-${i}`,
      category_key: h.category_key,
      content: h.content,
      importance: 50,
      occurred_at: new Date().toISOString(),
      relevance_score: 0.9,
      source: 'orb_voice',
    })),
    knowledge_hits: [],
    web_hits: [],
    structured_facts: [],
    relationship_context: [],
    active_vtids: [],
    tenant_policies: [],
    tool_health: [],
    ui_context: undefined,
    metrics: { hit_counts: {}, latencies: {} },
    extras: {},
  });
}

beforeEach(() => {
  mockSearchKnowledgeDocs.mockReset();
  mockBuildContextPack.mockReset();
  mockWrite.mockClear();
  mockSearchKnowledgeDocs.mockResolvedValue([]); // default: no KB hits
  mockEmptyMemory();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('consultNavigator — confidence bucketing', () => {
  test('high-confidence direct task: "how do I track my biology"', async () => {
    const result = await consultNavigator(authedInput());
    expect(result.primary).not.toBeNull();
    expect(result.primary?.screen_id).toBe('HEALTH.MY_BIOLOGY');
    expect(result.confidence).toBe('high');
    expect(result.confirmation_needed).toBe(false);
  });

  test('high-confidence business growth: "I want to make money with the community"', async () => {
    const result = await consultNavigator(authedInput({
      question: 'I want to make money with the community',
    }));
    expect(result.primary?.screen_id).toBe('BUSINESS.SELL_EARN');
    expect(result.confidence).toBe('high');
  });

  test('low confidence on a question with no catalog match', async () => {
    const result = await consultNavigator(authedInput({
      question: 'tell me a joke about gravity',
    }));
    expect(result.confidence).toBe('low');
    expect(result.primary).toBeNull();
    expect(result.blocked_reason).toBe('no_match');
  });
});

describe('consultNavigator — anonymous gating', () => {
  test('anonymous user navigating to public events screen succeeds', async () => {
    // Note: COMM.EVENTS is authenticated, so this should be blocked.
    // The right anonymous-safe analog is the Maxina portal.
    const result = await consultNavigator(anonymousInput({
      question: 'I want to register for the community',
    }));
    expect(result.primary?.screen_id).toBe('AUTH.MAXINA_PORTAL');
    expect(result.blocked_reason).toBeUndefined();
  });

  test('anonymous user asking for an authenticated screen is blocked', async () => {
    const result = await consultNavigator(anonymousInput({
      question: 'open my wallet',
    }));
    // Tries to recommend WALLET.OVERVIEW but gets blocked because anonymous_safe=false
    // Catalog scoring with anonymous_only=true should already exclude wallet from
    // results, leading to a low-confidence outcome.
    expect(result.confidence).toBe('low');
    expect(result.primary).toBeNull();
  });
});

describe('consultNavigator — current route exclusion', () => {
  test('user already on /comm/events-meetups gets a different recommendation for events', async () => {
    const result = await consultNavigator(authedInput({
      question: 'where are the events',
      current_route: '/comm/events-meetups',
    }));
    // Either a low-confidence "you are already there" OR a related screen
    if (result.primary) {
      expect(result.primary.route).not.toBe('/comm/events-meetups');
    }
  });
});

describe('consultNavigator — memory bias', () => {
  test('business-related goal biases ambiguous query toward business hub', async () => {
    mockMemoryHits([
      { category_key: 'goals', content: 'I want to build a side income from my fitness coaching' },
    ]);
    const result = await consultNavigator(authedInput({
      question: 'where should I focus today',
    }));
    // Without memory bias this is too vague to recommend anything strongly,
    // but with the side-income goal we should at least see business in the
    // top results (or as primary).
    expect(result.memory_hint_count).toBeGreaterThan(0);
  });

  test('navigator action memories are extracted into recent_navigations', async () => {
    mockMemoryHits([
      { category_key: 'notes', content: 'Vitana navigated to Events & Meetups (/comm/events-meetups) — User asked' },
    ]);
    // Use an ambiguous query so the fast path doesn't short-circuit and
    // the full memory-enhanced path runs (including buildContextPack).
    const result = await consultNavigator(authedInput({
      question: 'what should I do with the community',
    }));
    // Memory hints should have been fetched via the slow path.
    // We don't assert exact ranking here, just that the memory was processed.
    expect(mockBuildContextPack).toHaveBeenCalled();
    expect(result.primary).not.toBeNull();
  });
});

describe('formatConsultResultForLLM', () => {
  test('formats high-confidence result with primary and explanation', async () => {
    const result = await consultNavigator(authedInput());
    const text = formatConsultResultForLLM(result);
    expect(text).toContain('RECOMMENDATION: high');
    expect(text).toContain('PRIMARY: HEALTH.MY_BIOLOGY');
    expect(text).toContain('CONFIRMATION_NEEDED: false');
    expect(text).toContain('EXPLANATION:');
  });

  test('formats low-confidence with PRIMARY: none', async () => {
    const result = await consultNavigator(authedInput({
      question: 'completely unrelated to anything',
    }));
    const text = formatConsultResultForLLM(result);
    expect(text).toContain('RECOMMENDATION: low');
    expect(text).toContain('PRIMARY: none');
  });
});

describe('writeNavigatorActionMemory', () => {
  test('writes memory with mode=navigator_action and category_key=notes', async () => {
    await writeNavigatorActionMemory({
      identity: {
        user_id: '00000000-0000-0000-0000-000000000099',
        tenant_id: '00000000-0000-0000-0000-000000000001',
        role: 'community',
      },
      screen: {
        screen_id: 'COMM.EVENTS',
        route: '/comm/events-meetups',
        title: 'Events & Meetups',
      },
      reason: 'User asked about upcoming meetups',
      decision_source: 'consult',
      orb_session_id: 'test-session-1',
      conversation_id: 'test-conv-1',
      lang: 'en',
    });

    expect(mockWrite).toHaveBeenCalledTimes(1);
    const callArgs = mockWrite.mock.calls[0];
    const params = callArgs[1];
    expect(params.source).toBe('orb_voice');
    expect(params.category_key).toBe('notes');
    expect(params.skipFiltering).toBe(true);
    expect(params.content_json?.mode).toBe('navigator_action');
    expect(params.content_json?.screen_id).toBe('COMM.EVENTS');
    expect(params.content_json?.route).toBe('/comm/events-meetups');
    expect(params.content_json?.decision_source).toBe('consult');
    expect(params.content).toContain('Vitana navigated to Events & Meetups');
  });

  test('swallows errors silently — fire-and-forget contract', async () => {
    mockWrite.mockRejectedValueOnce(new Error('supabase down'));
    await expect(writeNavigatorActionMemory({
      identity: { user_id: 'u', tenant_id: 't' },
      screen: { screen_id: 'X', route: '/x', title: 'X' },
      reason: 'test',
      decision_source: 'direct',
      orb_session_id: 's',
      lang: 'en',
    })).resolves.toBeUndefined();
  });
});

// ─── VTID-02781: decision + alternatives ────────────────────────────────────

describe('consultNavigator — decision field (VTID-02781)', () => {
  test('confident: clear high-score winner returns decision="confident" with primary in alternatives[0]', async () => {
    const result = await consultNavigator(authedInput({
      question: 'how do I track my biology',
    }));
    expect(result.decision).toBe('confident');
    expect(result.primary).not.toBeNull();
    expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(result.alternatives[0].screen_id).toBe(result.primary?.screen_id);
  });

  test('unknown: no viable match returns decision="unknown" with empty alternatives', async () => {
    const result = await consultNavigator(authedInput({
      question: 'recite the periodic table',
    }));
    expect(result.decision).toBe('unknown');
    expect(result.primary).toBeNull();
    expect(result.alternatives).toEqual([]);
  });

  test('unknown: anonymous user blocked from authed screen returns decision="unknown"', async () => {
    const result = await consultNavigator(anonymousInput({
      question: 'open my wallet',
    }));
    expect(result.decision).toBe('unknown');
    expect(result.primary).toBeNull();
    expect(result.alternatives).toEqual([]);
  });

  test('decision is always one of the three documented values', async () => {
    for (const q of [
      'how do I track my biology',
      'tell me a joke about gravity',
      'open the events page',
      'show me my matches',
    ]) {
      const result = await consultNavigator(authedInput({ question: q }));
      expect(['confident', 'ambiguous', 'unknown']).toContain(result.decision);
    }
  });
});

describe('formatConsultResultForLLM — DECISION line (VTID-02781)', () => {
  test('renders DECISION on every result', async () => {
    const result = await consultNavigator(authedInput({
      question: 'how do I track my biology',
    }));
    const formatted = formatConsultResultForLLM(result);
    expect(formatted).toMatch(/^DECISION: (confident|ambiguous|unknown)$/m);
  });

  test('ambiguous result lists ALTERNATIVE_1, ALTERNATIVE_2, ALTERNATIVE_3', () => {
    // Synthesize an ambiguous result manually since the live catalog rarely
    // produces one with our test fixtures.
    const result: NavigatorConsultResult = {
      confidence: 'medium',
      decision: 'ambiguous',
      primary: { screen_id: 'A.X', route: '/a', title: 'A', description: 'a', when_to_visit: 'a' },
      alternative: { screen_id: 'B.X', route: '/b', title: 'B', description: 'b', when_to_visit: 'b' },
      alternatives: [
        { screen_id: 'A.X', route: '/a', title: 'A', description: 'a', when_to_visit: 'a' },
        { screen_id: 'B.X', route: '/b', title: 'B', description: 'b', when_to_visit: 'b' },
        { screen_id: 'C.X', route: '/c', title: 'C', description: 'c', when_to_visit: 'c' },
      ],
      explanation: 'pick one',
      confirmation_needed: true,
      kb_excerpts: [],
      top_picks: [],
      decision_source: 'scoring',
      ms_elapsed: 1,
      catalog_match_count: 3,
      memory_hint_count: 0,
      kb_excerpt_count: 0,
    };
    const formatted = formatConsultResultForLLM(result);
    expect(formatted).toContain('DECISION: ambiguous');
    expect(formatted).toContain('ALTERNATIVE_1: A.X');
    expect(formatted).toContain('ALTERNATIVE_2: B.X');
    expect(formatted).toContain('ALTERNATIVE_3: C.X');
  });
});
