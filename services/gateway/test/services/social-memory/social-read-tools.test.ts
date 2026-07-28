/**
 * Tests for src/services/social-memory/social-read-tools.ts
 * (runViewMessages, runListFollows, runRecentConversations).
 *
 * Mocked at the module boundary:
 *   - ../../lib/supabase (getSupabase) — chat_messages query chain
 *   - ./social-memory-repository (fetchExclusions, fetchFollowEdges,
 *     fetchRecentMessageContacts, fetchPeople) — sibling batch, not
 *     under test here.
 *
 * Every read tool is identity-gated (user_id/tenant_id required) and
 * fails closed if the exclusion (blocked-user) lookup throws — these are
 * the CLAUDE.md "scope memory by tenant + role" / "never mix tenant data"
 * guarantees for this file, asserted explicitly below.
 */
import type { SocialPerson } from '../../../src/services/social-memory/social-memory-types';

// --- chat_messages query-chain mock (used by runViewMessages) --------------
function createChain() {
  let resolved: any = { data: [], error: null };
  const chain: any = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    then: (resolve: (v: any) => any, reject: (e: any) => any) => Promise.resolve(resolved).then(resolve, reject),
    __setResolved(v: any) {
      resolved = v;
    },
  };
  return chain;
}

const chatMessagesChain = createChain();
const mockSupabase = { from: jest.fn(() => chatMessagesChain) };
const mockGetSupabase = jest.fn(() => mockSupabase);

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

const mockFetchExclusions = jest.fn();
const mockFetchFollowEdges = jest.fn();
const mockFetchRecentMessageContacts = jest.fn();
const mockFetchPeople = jest.fn();

jest.mock('../../../src/services/social-memory/social-memory-repository', () => ({
  fetchExclusions: (...args: unknown[]) => mockFetchExclusions(...args),
  fetchFollowEdges: (...args: unknown[]) => mockFetchFollowEdges(...args),
  fetchRecentMessageContacts: (...args: unknown[]) => mockFetchRecentMessageContacts(...args),
  fetchPeople: (...args: unknown[]) => mockFetchPeople(...args),
}));

import { runViewMessages, runListFollows, runRecentConversations } from '../../../src/services/social-memory/social-read-tools';

function person(overrides: Partial<SocialPerson> = {}): SocialPerson {
  return {
    user_id: 'p-1',
    display_name: 'Alice',
    handle: 'alice',
    vitana_id: 'V-1',
    avatar_url: null,
    bio: null,
    city: null,
    country: null,
    visibility: 'public',
    ...overrides,
  };
}

const IDENTITY = { user_id: 'user-1', tenant_id: 'tenant-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSupabase.mockReturnValue(mockSupabase);
  chatMessagesChain.__setResolved({ data: [], error: null });
  mockFetchExclusions.mockResolvedValue({ blocked: new Set(), muted: new Set(), hidden_posts: new Set() });
  mockFetchFollowEdges.mockResolvedValue({ following: [], followers: [] });
  mockFetchRecentMessageContacts.mockResolvedValue([]);
  mockFetchPeople.mockResolvedValue(new Map());
});

// ---------------------------------------------------------------------------
// runViewMessages
// ---------------------------------------------------------------------------

describe('runViewMessages', () => {
  it('refuses when user_id is missing (no supabase call made)', async () => {
    const result = await runViewMessages({}, { tenant_id: 'tenant-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/authenticated user/);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('refuses when tenant_id is missing (no supabase call made)', async () => {
    const result = await runViewMessages({}, { user_id: 'user-1' });
    expect(result.ok).toBe(false);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('fails closed when getSupabase() returns null', async () => {
    mockGetSupabase.mockReturnValueOnce(null as any);
    const result = await runViewMessages({}, IDENTITY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/storage unavailable/);
  });

  it('fails closed when fetchExclusions throws (never returns message data)', async () => {
    mockFetchExclusions.mockRejectedValue(new Error('exclusions_read_failed: boom'));
    const result = await runViewMessages({}, IDENTITY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/privacy filters unavailable/);
      expect(result.error).toMatch(/boom/);
    }
    // Must never reach the message query after a failed exclusion fetch.
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('defaults to scope=unread and filters read_at IS NULL', async () => {
    chatMessagesChain.__setResolved({ data: [], error: null });
    await runViewMessages({}, IDENTITY);
    expect(chatMessagesChain.is).toHaveBeenCalledWith('read_at', null);
    expect(chatMessagesChain.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
    expect(chatMessagesChain.eq).toHaveBeenCalledWith('receiver_id', 'user-1');
  });

  it('scope=all does not filter on read_at', async () => {
    chatMessagesChain.__setResolved({ data: [], error: null });
    await runViewMessages({ scope: 'all' }, IDENTITY);
    expect(chatMessagesChain.is).toHaveBeenCalledWith('group_id', null);
    expect(chatMessagesChain.is).not.toHaveBeenCalledWith('read_at', null);
  });

  it('clamps an out-of-range limit back to the 30 default', async () => {
    await runViewMessages({ limit: 999 }, IDENTITY);
    expect(chatMessagesChain.limit).toHaveBeenCalledWith(30);
  });

  it('uses a valid explicit limit', async () => {
    await runViewMessages({ limit: 5 }, IDENTITY);
    expect(chatMessagesChain.limit).toHaveBeenCalledWith(5);
  });

  it('reports zero unread messages plainly when there are none', async () => {
    chatMessagesChain.__setResolved({ data: [], error: null });
    const result = await runViewMessages({}, IDENTITY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('NO unread messages');
      expect(result.result).toEqual({ scope: 'unread', total: 0, senders: [] });
    }
  });

  it('excludes messages from blocked senders from the result', async () => {
    mockFetchExclusions.mockResolvedValue({ blocked: new Set(['blocked-user']), muted: new Set(), hidden_posts: new Set() });
    chatMessagesChain.__setResolved({
      data: [
        { sender_id: 'blocked-user', content: 'spam', created_at: '2026-07-01T00:00:00.000Z', read_at: null },
        { sender_id: 'good-user', content: 'hi', created_at: '2026-07-01T01:00:00.000Z', read_at: null },
      ],
      error: null,
    });
    mockFetchPeople.mockResolvedValue(new Map([['good-user', person({ user_id: 'good-user', display_name: 'Good' })]]));

    const result = await runViewMessages({}, IDENTITY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.total).toBe(1);
      expect((result.result.senders as any[]).map((s) => s.user_id)).toEqual(['good-user']);
      expect(result.text).not.toContain('spam');
    }
  });

  it('groups multiple messages from the same sender and counts them', async () => {
    chatMessagesChain.__setResolved({
      data: [
        { sender_id: 'a', content: 'second (newest)', created_at: '2026-07-02T00:00:00.000Z', read_at: null },
        { sender_id: 'a', content: 'first (older)', created_at: '2026-07-01T00:00:00.000Z', read_at: null },
      ],
      error: null,
    });
    mockFetchPeople.mockResolvedValue(new Map([['a', person({ user_id: 'a', display_name: 'Ann' })]]));

    const result = await runViewMessages({}, IDENTITY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.total).toBe(2);
      const senders = result.result.senders as any[];
      expect(senders).toHaveLength(1);
      expect(senders[0].count).toBe(2);
      // The row processed first (rows are newest-first) sets the "latest" snippet.
      expect(result.text).toContain('second (newest)');
      expect(result.text).not.toContain('first (older)');
    }
  });

  it('surfaces a DB error from the query', async () => {
    chatMessagesChain.__setResolved({ data: null, error: { message: 'db exploded' } });
    const result = await runViewMessages({}, IDENTITY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('db exploded');
  });

  it('includes the internal-message guardrail (never-say-archived, no-Google directive)', async () => {
    const result = await runViewMessages({}, IDENTITY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toMatch(/NEVER mention Google/);
      expect(result.text).toMatch(/NEVER offer or mention "archived"/);
    }
  });
});

// ---------------------------------------------------------------------------
// runListFollows
// ---------------------------------------------------------------------------

describe('runListFollows', () => {
  it('refuses when user_id is missing (no repository call made)', async () => {
    const result = await runListFollows('followers', {});
    expect(result.ok).toBe(false);
    expect(mockFetchFollowEdges).not.toHaveBeenCalled();
  });

  it('fails closed when fetchExclusions throws', async () => {
    mockFetchExclusions.mockRejectedValue(new Error('boom'));
    const result = await runListFollows('followers', { user_id: 'user-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/privacy filters unavailable/);
    expect(mockFetchFollowEdges).not.toHaveBeenCalled();
  });

  it('passes the blocked set and a limit of 50 to fetchFollowEdges', async () => {
    const blocked = new Set(['x']);
    mockFetchExclusions.mockResolvedValue({ blocked, muted: new Set(), hidden_posts: new Set() });
    await runListFollows('following', { user_id: 'user-1' });
    expect(mockFetchFollowEdges).toHaveBeenCalledWith('user-1', blocked, 50);
  });

  it('reports zero followers with a discovery suggestion', async () => {
    mockFetchFollowEdges.mockResolvedValue({ following: [], followers: [] });
    const result = await runListFollows('followers', { user_id: 'user-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toMatch(/Nobody follows the user/);
      expect(result.result).toEqual({ direction: 'followers', count: 0, names: [] });
    }
  });

  it('reports zero following with an offer to find members', async () => {
    mockFetchFollowEdges.mockResolvedValue({ following: [], followers: [] });
    const result = await runListFollows('following', { user_id: 'user-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toMatch(/does not follow anyone yet/);
  });

  it('computes mutuals correctly between followers and following', async () => {
    const alice = person({ user_id: 'alice' });
    const bob = person({ user_id: 'bob' });
    mockFetchFollowEdges.mockResolvedValue({
      following: [{ person: alice, since: '2026-01-01' }, { person: bob, since: '2026-01-02' }],
      followers: [{ person: alice, since: '2026-01-01' }],
    });
    const result = await runListFollows('following', { user_id: 'user-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.mutual_count).toBe(1);
      expect(result.text).toContain('1 of them are mutual');
    }
  });

  it('caps the spoken name list at 12 and reports the remainder', async () => {
    const list = Array.from({ length: 15 }, (_, i) => ({ person: person({ user_id: `f${i}`, display_name: `F${i}` }), since: '2026-01-01' }));
    mockFetchFollowEdges.mockResolvedValue({ following: [], followers: list });
    const result = await runListFollows('followers', { user_id: 'user-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.count).toBe(15);
      expect((result.result.names as string[])).toHaveLength(12);
      expect(result.text).toContain('and 3 more');
    }
  });
});

// ---------------------------------------------------------------------------
// runRecentConversations
// ---------------------------------------------------------------------------

describe('runRecentConversations', () => {
  it('refuses when tenant_id is missing (no repository call made)', async () => {
    const result = await runRecentConversations({}, { user_id: 'user-1' });
    expect(result.ok).toBe(false);
    expect(mockFetchRecentMessageContacts).not.toHaveBeenCalled();
  });

  it('fails closed when fetchExclusions throws', async () => {
    mockFetchExclusions.mockRejectedValue(new Error('boom'));
    const result = await runRecentConversations({}, IDENTITY);
    expect(result.ok).toBe(false);
    expect(mockFetchRecentMessageContacts).not.toHaveBeenCalled();
  });

  it('defaults the limit to 8 and clamps an out-of-range limit', async () => {
    await runRecentConversations({}, IDENTITY);
    expect(mockFetchRecentMessageContacts).toHaveBeenCalledWith('user-1', 'tenant-1', expect.any(Set), 8);

    mockFetchRecentMessageContacts.mockClear();
    await runRecentConversations({ limit: 999 }, IDENTITY);
    expect(mockFetchRecentMessageContacts).toHaveBeenCalledWith('user-1', 'tenant-1', expect.any(Set), 8);

    mockFetchRecentMessageContacts.mockClear();
    await runRecentConversations({ limit: 3 }, IDENTITY);
    expect(mockFetchRecentMessageContacts).toHaveBeenCalledWith('user-1', 'tenant-1', expect.any(Set), 3);
  });

  it('reports no conversations plainly when there are none', async () => {
    mockFetchRecentMessageContacts.mockResolvedValue([]);
    const result = await runRecentConversations({}, IDENTITY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ count: 0, contacts: [] });
      expect(result.text).toMatch(/no direct-message conversations/);
    }
  });

  it('renders direction correctly for sent vs received, newest first', async () => {
    mockFetchRecentMessageContacts.mockResolvedValue([
      { person: person({ user_id: 'a', display_name: 'Ann' }), last_message_at: '2026-07-02T00:00:00.000Z', last_direction: 'sent', last_snippet: 'see you soon', messages_30d: 2 },
      { person: person({ user_id: 'b', display_name: 'Ben' }), last_message_at: '2026-07-01T00:00:00.000Z', last_direction: 'received', last_snippet: null, messages_30d: 1 },
    ]);
    const result = await runRecentConversations({}, IDENTITY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('Ann (');
      expect(result.text).toContain('user wrote last');
      expect(result.text).toContain('they wrote last');
      expect(result.text).toContain('see you soon');
      const contacts = result.result.contacts as any[];
      expect(contacts[0].user_id).toBe('a');
      expect(contacts[0].last_direction).toBe('sent');
    }
  });
});
