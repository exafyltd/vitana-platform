/**
 * Tests for src/services/social-memory/social-memory-service.ts
 * (buildAssistantSocialContext — the top-level orchestrator).
 *
 * Mocked at the module boundary (sibling batch, not under test here):
 *   - ./social-context-builder (buildSocialContextPack)
 *   - ../oasis-event-service   (emitOasisEvent)
 *   - ../orb-memory-bridge     (writeMemoryItemWithIdentity, dynamic import)
 *
 * social-memory-prompts (detectSocialIntent / formatSocialContextForPrompt)
 * is used FOR REAL — it is pure, in-scope, and already covered directly in
 * social-memory-prompts.test.ts, so exercising it here also verifies the
 * wiring between the two files.
 */
import type { SocialContextPack, SocialPerson } from '../../../src/services/social-memory/social-memory-types';

const mockBuildSocialContextPack = jest.fn();
jest.mock('../../../src/services/social-memory/social-context-builder', () => ({
  buildSocialContextPack: (...args: unknown[]) => mockBuildSocialContextPack(...args),
}));

const mockEmitOasisEvent = jest.fn();
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

const mockWriteMemoryItemWithIdentity = jest.fn();
jest.mock('../../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: (...args: unknown[]) => mockWriteMemoryItemWithIdentity(...args),
}));

import { buildAssistantSocialContext } from '../../../src/services/social-memory/social-memory-service';

function person(overrides: Partial<SocialPerson> = {}): SocialPerson {
  return {
    user_id: 'person-1',
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

function basePack(overrides: Partial<SocialContextPack> = {}): SocialContextPack {
  return {
    user: null,
    relationships: { following: [], followers: [], following_count: 2, followers_count: 3, mutual_ids: [] },
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
      latency_ms: 42,
      sections_loaded: ['relationships'],
      degraded_sections: [],
      privacy_filters_applied: [],
    },
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockBuildSocialContextPack.mockResolvedValue(basePack());
  mockEmitOasisEvent.mockResolvedValue(undefined);
  mockWriteMemoryItemWithIdentity.mockResolvedValue({ ok: true });
});

describe('buildAssistantSocialContext', () => {
  it('detects intent from the question and forwards it to buildSocialContextPack', async () => {
    await buildAssistantSocialContext({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      question: 'who do I follow',
      surface: 'vitana_assistant',
    });

    expect(mockBuildSocialContextPack).toHaveBeenCalledTimes(1);
    const arg = mockBuildSocialContextPack.mock.calls[0][0];
    expect(arg.tenant_id).toBe('tenant-1');
    expect(arg.user_id).toBe('user-1');
    expect(arg.question).toBe('who do I follow');
    expect(arg.surface).toBe('vitana_assistant');
    expect(arg.intent.is_social).toBe(true);
    expect(arg.intent.kinds).toContain('follows');
  });

  it('does NOT force social intent when force is falsy and the question has no social trigger', async () => {
    await buildAssistantSocialContext({
      tenant_id: 't1',
      user_id: 'u1',
      question: 'what is the weather like',
    });
    const arg = mockBuildSocialContextPack.mock.calls[0][0];
    expect(arg.intent.is_social).toBe(false);
    expect(arg.intent.kinds).toEqual([]);
  });

  it('forces social intent to general_social when force=true and question has no trigger', async () => {
    const result = await buildAssistantSocialContext({
      tenant_id: 't1',
      user_id: 'u1',
      question: 'hello there',
      force: true,
    });
    expect(result.intent.is_social).toBe(true);
    expect(result.intent.kinds).toEqual(['general_social']);
    const arg = mockBuildSocialContextPack.mock.calls[0][0];
    expect(arg.intent.kinds).toEqual(['general_social']);
  });

  it('does not override an already-detected intent when force=true', async () => {
    const result = await buildAssistantSocialContext({
      tenant_id: 't1',
      user_id: 'u1',
      question: 'who do I follow',
      force: true,
    });
    expect(result.intent.kinds).toContain('follows');
    expect(result.intent.kinds).not.toContain('general_social');
  });

  it('returns ok=true and a rendered prompt_block when there are no degraded sections', async () => {
    mockBuildSocialContextPack.mockResolvedValue(basePack({ meta: { built_at: 'x', latency_ms: 1, sections_loaded: [], degraded_sections: [], privacy_filters_applied: [] } }));
    const result = await buildAssistantSocialContext({ tenant_id: 't1', user_id: 'u1', question: 'who do I follow' });
    expect(result.ok).toBe(true);
    expect(result.prompt_block).toContain('<social_context>');
    expect(result.prompt_block).toContain('Follows (2)');
  });

  it('returns ok=false when the pack has degraded sections', async () => {
    mockBuildSocialContextPack.mockResolvedValue(
      basePack({ meta: { built_at: 'x', latency_ms: 1, sections_loaded: [], degraded_sections: ['matches'], privacy_filters_applied: [] } }),
    );
    const result = await buildAssistantSocialContext({ tenant_id: 't1', user_id: 'u1', question: 'who do I follow' });
    expect(result.ok).toBe(false);
  });

  it('emits an OASIS event with status=info and correct counts when nothing degraded', async () => {
    mockBuildSocialContextPack.mockResolvedValue(
      basePack({
        matches: [{ person: person(), score: 80, reasons: [], source: 'daily_match', matched_at: null, action: null, conversation_started: false, is_current: true }],
        meta: { built_at: 'x', latency_ms: 5, sections_loaded: ['matches'], degraded_sections: [], privacy_filters_applied: [] },
      }),
    );
    await buildAssistantSocialContext({ tenant_id: 'tenant-9', user_id: 'user-9', question: 'my matches', conversation_id: 'conv-1', surface: 'profile' });

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const event = mockEmitOasisEvent.mock.calls[0][0];
    expect(event.status).toBe('info');
    expect(event.type).toBe('memory.social.context_built');
    expect(event.source).toBe('social-memory-profile');
    expect(event.payload.tenant_id).toBe('tenant-9');
    expect(event.payload.user_id).toBe('user-9');
    expect(event.payload.conversation_id).toBe('conv-1');
    expect(event.payload.matches_count).toBe(1);
  });

  it('emits status=warning when the pack reports degraded sections', async () => {
    mockBuildSocialContextPack.mockResolvedValue(
      basePack({ meta: { built_at: 'x', latency_ms: 1, sections_loaded: [], degraded_sections: ['messages'], privacy_filters_applied: [] } }),
    );
    await buildAssistantSocialContext({ tenant_id: 't1', user_id: 'u1', question: 'who do I follow' });
    const event = mockEmitOasisEvent.mock.calls[0][0];
    expect(event.status).toBe('warning');
    expect(event.payload.degraded_sections).toEqual(['messages']);
  });

  it('defaults the OASIS event source to vitana_assistant when no surface is given', async () => {
    await buildAssistantSocialContext({ tenant_id: 't1', user_id: 'u1', question: 'who do I follow' });
    const event = mockEmitOasisEvent.mock.calls[0][0];
    expect(event.source).toBe('social-memory-vitana_assistant');
    expect(event.payload.surface).toBe('vitana_assistant');
  });

  it('swallows an emitOasisEvent rejection without throwing', async () => {
    mockEmitOasisEvent.mockRejectedValue(new Error('oasis down'));
    await expect(
      buildAssistantSocialContext({ tenant_id: 't1', user_id: 'u1', question: 'who do I follow' }),
    ).resolves.toBeDefined();
  });

  describe('person-focus memory persistence', () => {
    const personContext = (privacy_limited: boolean) => ({
      person: person({ display_name: 'Mariia Maksina', user_id: 'mariia-id' }),
      you_follow: true,
      follows_you: false,
      match: { person: person(), score: 91, reasons: [], source: 'daily_match' as const, matched_at: null, action: null, conversation_started: false, is_current: true },
      shared_interests: [],
      shared_groups: [],
      shared_events: [],
      latest_posts: [],
      upcoming_events: [],
      last_chat_at: null,
      privacy_limited,
      recommended_next_action: null,
      relevance_summary: 'summary',
    });

    it('persists a person-focus memory when person_context + person_hint are both present', async () => {
      mockBuildSocialContextPack.mockResolvedValue(basePack({ person_context: personContext(false) }));

      await buildAssistantSocialContext({
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        question: 'tell me about Mariia Maksina',
        surface: 'profile',
      });
      await flush();

      expect(mockWriteMemoryItemWithIdentity).toHaveBeenCalledTimes(1);
      const [identityArg, itemArg] = mockWriteMemoryItemWithIdentity.mock.calls[0];
      expect(identityArg).toEqual({ user_id: 'user-1', tenant_id: 'tenant-1' });
      expect(itemArg.category_key).toBe('network_relationships');
      expect(itemArg.source).toBe('orb_text');
      expect(itemArg.content).toContain('Mariia Maksina');
      expect(itemArg.content).toContain('match score 91');
      expect(itemArg.content).toContain('follows them');
      expect(itemArg.content_json).toMatchObject({ kind: 'person_focus', person_id: 'mariia-id', surface: 'profile' });
    });

    it('does NOT persist when the focused person is privacy_limited', async () => {
      mockBuildSocialContextPack.mockResolvedValue(basePack({ person_context: personContext(true) }));

      await buildAssistantSocialContext({
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        question: 'tell me about Mariia Maksina',
      });
      await flush();

      expect(mockWriteMemoryItemWithIdentity).not.toHaveBeenCalled();
    });

    it('does NOT persist when there is no person_hint even if person_context is present', async () => {
      mockBuildSocialContextPack.mockResolvedValue(basePack({ person_context: personContext(false) }));

      // No name in the question → detectSocialIntent produces person_hint=null.
      await buildAssistantSocialContext({
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        question: 'what changed since yesterday',
      });
      await flush();

      expect(mockWriteMemoryItemWithIdentity).not.toHaveBeenCalled();
    });

    it('does NOT persist when there is no person_context even if a name is present', async () => {
      mockBuildSocialContextPack.mockResolvedValue(basePack({ person_context: null }));

      await buildAssistantSocialContext({
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        question: 'tell me about Mariia Maksina',
      });
      await flush();

      expect(mockWriteMemoryItemWithIdentity).not.toHaveBeenCalled();
    });

    it('swallows a writeMemoryItemWithIdentity failure without rejecting the overall call', async () => {
      mockBuildSocialContextPack.mockResolvedValue(basePack({ person_context: personContext(false) }));
      mockWriteMemoryItemWithIdentity.mockRejectedValue(new Error('db down'));

      await expect(
        buildAssistantSocialContext({
          tenant_id: 'tenant-1',
          user_id: 'user-1',
          question: 'tell me about Mariia Maksina',
        }),
      ).resolves.toBeDefined();
      await flush();

      expect(mockWriteMemoryItemWithIdentity).toHaveBeenCalledTimes(1);
    });
  });
});
