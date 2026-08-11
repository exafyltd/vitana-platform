/**
 * VTID-03582 — ORB read tools: view_messages / recent_conversations /
 * list_followers / list_following.
 *
 * THE BUGS (docs/CONVERSATION_DEFECTS_FIX_PLAN.md, Defects 1/4/5): Vitana had
 * SEND (send_chat_message) and SEARCH (search_community) but no READ
 * capability for her own inbox or social graph. With an unread-message COUNT
 * in context but no tool to open them, she hallucinated "archived messages"
 * and, separately, told a user to "connect your Google account" to see
 * INTERNAL community messages — which need no external account at all. Asked
 * "who follows me" or "with whom did I last chat", she deflected to "search
 * the member list".
 *
 * These tests pin: every tool is speakable, never raw-JSON/empty-without-
 * saying-so, never fake-fails, and view_messages/recent_conversations never
 * mention Google/Gmail/connected-apps or "archived".
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  tool_view_messages,
  tool_recent_conversations,
  tool_list_followers,
  tool_list_following,
  ORB_TOOL_REGISTRY,
} from '../../../src/services/orb-tools-shared';

const id = { user_id: 'u1', tenant_id: 't1', role: 'community' } as never;
const POSITIVE = /SUCCESS|HANDLED/;
const NO_FAKE_FAIL = /Do NOT say you could not (check|see)/i;
const NO_GOOGLE = /google|gmail|connected app/i;
const NO_ARCHIVED = /archiv/i;

/** Generic chainable Supabase stub — routes by table, honours .is()/.in()/.eq()/.order()/.limit()/.maybeSingle(). */
function makeSb(opts: {
  chatMessages?: Array<Record<string, unknown>>;
  appUsers?: Array<{ user_id: string; display_name: string | null }>;
  rpcRecentConversations?: Array<Record<string, unknown>>;
  followCounts?: { followers_count: number; following_count: number } | null;
  userFollows?: Array<Record<string, unknown>>;
}) {
  return {
    from(table: string) {
      if (table === 'chat_messages') {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.order = () => chain;
        chain.limit = () => Promise.resolve({ data: opts.chatMessages ?? [], error: null });
        return chain;
      }
      if (table === 'app_users') {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.in = () => Promise.resolve({ data: opts.appUsers ?? [] });
        return chain;
      }
      if (table === 'user_follow_counts') {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = () => Promise.resolve({ data: opts.followCounts ?? null });
        return chain;
      }
      if (table === 'user_follows') {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.limit = () => Promise.resolve({ data: opts.userFollows ?? [], error: null });
        return chain;
      }
      return {} as never;
    },
    async rpc(name: string) {
      if (name === 'get_recent_conversations') {
        return { data: opts.rpcRecentConversations ?? [], error: null };
      }
      return { data: null, error: null };
    },
  } as never;
}

describe('view_messages', () => {
  it('unread present → speakable, names senders, no Google/archived mention', async () => {
    const sb = makeSb({
      chatMessages: [
        { id: 'm1', sender_id: 's1', sender_vitana_id: 'mariia3', content: 'Hey, are you free?', created_at: '2026-06-30T10:00:00Z', read_at: null },
      ],
      appUsers: [{ user_id: 's1', display_name: 'Mariia Maksina' }],
    });
    const r = await tool_view_messages({}, id, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(POSITIVE);
    expect(r.text).toMatch(/Mariia Maksina/);
    expect(r.text).toMatch(NO_FAKE_FAIL);
    expect(r.text).not.toMatch(NO_GOOGLE);
    expect(r.text).not.toMatch(NO_ARCHIVED);
    expect(r.text!.trim().startsWith('{')).toBe(false);
  });

  it('no unread → HANDLED, never offers "archived", never mentions Google', async () => {
    const sb = makeSb({ chatMessages: [] });
    const r = await tool_view_messages({}, id, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/HANDLED/);
    expect(r.text).not.toMatch(NO_ARCHIVED);
    expect(r.text).not.toMatch(NO_GOOGLE);
  });

  it('never mentions Google/Gmail/connected-apps even when messages exist (Defect 4)', async () => {
    const sb = makeSb({
      chatMessages: [{ id: 'm1', sender_id: 's1', sender_vitana_id: 'x', content: 'hi', created_at: '2026-06-30T10:00:00Z', read_at: null }],
      appUsers: [{ user_id: 's1', display_name: 'X' }],
    });
    const r = await tool_view_messages({}, id, sb);
    // Explicit internal/external guard the model is told to speak.
    expect(r.text).toMatch(/INTERNAL/);
    expect(r.text).toMatch(/NEVER mention Google/i);
  });

  it('missing auth → ok:false', async () => {
    const r = await tool_view_messages({}, { user_id: '', tenant_id: null } as never, makeSb({}));
    expect(r.ok).toBe(false);
  });
});

describe('recent_conversations', () => {
  it('with history → names last contact, uses the existing RPC, never fake-fails', async () => {
    const sb = makeSb({
      rpcRecentConversations: [
        { peer_id: 'p1', sender_id: 'p1', content: 'see you then', created_at: '2026-06-30T12:00:00Z' },
        { peer_id: 'p2', sender_id: 'u1', content: 'ok!', created_at: '2026-06-28T09:00:00Z' },
      ],
      appUsers: [
        { user_id: 'p1', display_name: 'Mariia Maksina' },
        { user_id: 'p2', display_name: 'Alex' },
      ],
    });
    const r = await tool_recent_conversations({}, id, sb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toMatch(POSITIVE);
    expect(r.text).toMatch(/Mariia Maksina/);
    expect(r.text).toMatch(NO_FAKE_FAIL);
    const result = r.result as { last_contact: { peer_name: string } };
    expect(result.last_contact.peer_name).toBe('Mariia Maksina');
  });

  it('no conversations yet → HANDLED, not a failure', async () => {
    const sb = makeSb({ rpcRecentConversations: [] });
    const r = await tool_recent_conversations({}, id, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/HANDLED/);
  });
});

describe('list_followers / list_following', () => {
  it('followers present → names them, states the total, never deflects to search', async () => {
    const sb = makeSb({
      followCounts: { followers_count: 2, following_count: 0 },
      userFollows: [
        { follower_id: 'f1', created_at: '2026-06-30T10:00:00Z' },
        { follower_id: 'f2', created_at: '2026-06-29T10:00:00Z' },
      ],
      appUsers: [
        { user_id: 'f1', display_name: 'Sam' },
        { user_id: 'f2', display_name: 'Jo' },
      ],
    });
    const r = await tool_list_followers({}, id, sb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toMatch(POSITIVE);
    expect(r.text).toMatch(/Sam/);
    expect(r.text).toMatch(NO_FAKE_FAIL);
    const result = r.result as { total: number };
    expect(result.total).toBe(2);
  });

  it('zero followers → HANDLED, not "I cannot tell you"', async () => {
    const sb = makeSb({ followCounts: { followers_count: 0, following_count: 0 } });
    const r = await tool_list_followers({}, id, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/HANDLED/);
    expect(r.text).not.toMatch(/cannot tell/i);
  });

  it('list_following queries the follower_id side, not following_id', async () => {
    const sb = makeSb({
      followCounts: { followers_count: 0, following_count: 1 },
      userFollows: [{ following_id: 'g1', created_at: '2026-06-30T10:00:00Z' }],
      appUsers: [{ user_id: 'g1', display_name: 'Greta' }],
    });
    const r = await tool_list_following({}, id, sb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toMatch(/Greta/);
  });
});

describe('registration', () => {
  it('all four tools are registered in ORB_TOOL_REGISTRY', () => {
    expect(ORB_TOOL_REGISTRY.view_messages).toBe(tool_view_messages);
    expect(ORB_TOOL_REGISTRY.recent_conversations).toBe(tool_recent_conversations);
    expect(ORB_TOOL_REGISTRY.list_followers).toBe(tool_list_followers);
    expect(ORB_TOOL_REGISTRY.list_following).toBe(tool_list_following);
  });
});
