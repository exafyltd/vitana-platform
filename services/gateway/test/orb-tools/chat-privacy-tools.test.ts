/**
 * Chat management (VTID-02771) + Privacy (VTID-02776) voice tool tests.
 *
 * Mocked SupabaseClient only — no network, no real DB. Covers per tool the
 * happy path (ok:true + speakable text containing the actual content) and
 * the unauthenticated case where the tool touches user data. The graceful
 * "not supported yet" answers (mute/archive — no backing column exists in
 * the chat schema) are pinned so nobody silently starts pretending a chat
 * was muted/archived without a real column behind it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

jest.mock('../../src/services/orb-tools-shared', () => ({
  tool_send_chat_message: jest.fn(),
}));
jest.mock('../../src/services/social-memory/social-read-tools', () => ({
  runRecentConversations: jest.fn(),
}));

import { tool_send_chat_message } from '../../src/services/orb-tools-shared';
import { runRecentConversations } from '../../src/services/social-memory/social-read-tools';
import {
  CHAT_PRIVACY_TOOL_HANDLERS,
  CHAT_PRIVACY_TOOL_DECLARATIONS,
  tool_start_conversation,
  tool_list_conversations,
  tool_mark_conversation_read,
  tool_mute_conversation,
  tool_archive_conversation,
  tool_update_account_visibility,
  tool_update_privacy_field,
  tool_block_user,
  tool_unblock_user,
} from '../../src/services/orb-tools/chat-privacy-tools';

// ---------------------------------------------------------------------------
// Mock Supabase client
// ---------------------------------------------------------------------------

interface QueryResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

/** Chainable, awaitable (thenable) query-builder mock. */
function makeChain(result: QueryResult) {
  const chain: any = {};
  for (const m of [
    'select',
    'update',
    'insert',
    'upsert',
    'delete',
    'eq',
    'is',
    'or',
    'in',
    'order',
    'limit',
  ]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.maybeSingle = jest.fn(async () => ({ data: null, error: null, ...result }));
  chain.single = jest.fn(async () => ({ data: null, error: null, ...result }));
  chain.then = (resolve: any, reject: any) =>
    Promise.resolve({ data: null, error: null, count: null, ...result }).then(resolve, reject);
  return chain;
}

/**
 * Table results: single result or a sequence (consumed per .from() call;
 * the last entry repeats).
 */
function makeSb(config: {
  rpc?: jest.Mock;
  tables?: Record<string, QueryResult | QueryResult[]>;
}): SupabaseClient {
  const counters: Record<string, number> = {};
  return {
    rpc: config.rpc ?? jest.fn(async () => ({ data: [], error: null })),
    from: jest.fn((table: string) => {
      const conf = config.tables?.[table];
      if (Array.isArray(conf)) {
        counters[table] = (counters[table] ?? -1) + 1;
        return makeChain(conf[Math.min(counters[table], conf.length - 1)]);
      }
      return makeChain(conf ?? {});
    }),
  } as unknown as SupabaseClient;
}

const ID = { user_id: 'a27552a3-0257-4305-8ed0-351a80fd3701', tenant_id: 't-1', role: 'community' };
const ANON = { user_id: '', tenant_id: null, role: null };
const MARIA_UUID = '11111111-2222-4333-8444-555555555555';

const resolveMariaRpc = () =>
  jest.fn(async () => ({
    data: [
      {
        user_id: MARIA_UUID,
        vitana_id: 'maria6',
        display_name: 'Maria Lopez',
        score: 1.0,
        reason: 'vitana_id_exact',
      },
    ],
    error: null,
  }));

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Exports contract
// ---------------------------------------------------------------------------

describe('module exports', () => {
  const NAMES = [
    'start_conversation',
    'list_conversations',
    'mark_conversation_read',
    'mute_conversation',
    'archive_conversation',
    'update_account_visibility',
    'update_privacy_field',
    'block_user',
    'unblock_user',
  ];

  it.each(NAMES)('%s has a handler', (name) => {
    expect(typeof CHAT_PRIVACY_TOOL_HANDLERS[name]).toBe('function');
  });

  it.each(NAMES)('%s has a declaration', (name) => {
    expect(CHAT_PRIVACY_TOOL_DECLARATIONS.find((d) => d.name === name)).toBeDefined();
  });

  it('declarations use only the Vertex-safe OpenAPI subset', () => {
    const json = JSON.stringify(CHAT_PRIVACY_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
      expect(json).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// start_conversation
// ---------------------------------------------------------------------------

describe('start_conversation', () => {
  it('rejects unauthenticated users', async () => {
    const res = await tool_start_conversation({ member: 'Maria' }, ANON, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });

  it('resolves the member and reports an existing conversation (no message)', async () => {
    const sb = makeSb({
      rpc: resolveMariaRpc(),
      tables: {
        chat_messages: {
          data: [{ id: 'm1', content: 'hi', created_at: '2026-07-01T10:00:00Z' }],
        },
      },
    });
    const res = await tool_start_conversation({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Maria Lopez');
      expect(res.text).toContain('already have a conversation');
      expect((res.result as any).recipient_user_id).toBe(MARIA_UUID);
      expect((res.result as any).existing_conversation).toBe(true);
    }
  });

  it('reports a fresh thread when no messages exist yet', async () => {
    const sb = makeSb({
      rpc: resolveMariaRpc(),
      tables: { chat_messages: { data: [] } },
    });
    const res = await tool_start_conversation({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('no conversation yet');
      expect((res.result as any).existing_conversation).toBe(false);
    }
  });

  it('delegates to the canonical send path when a message is provided', async () => {
    (tool_send_chat_message as jest.Mock).mockResolvedValue({
      ok: true,
      text: 'Sent to Maria Lopez.',
    });
    const sb = makeSb({});
    const res = await tool_start_conversation(
      { member: 'Maria', message: 'Hi, how are you?' },
      ID,
      sb,
    );
    expect(tool_send_chat_message).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_label: 'Maria', body: 'Hi, how are you?' }),
      ID,
      sb,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('Sent to Maria Lopez');
  });

  it('asks for clarification when the resolver is ambiguous', async () => {
    const sb = makeSb({
      rpc: jest.fn(async () => ({
        data: [
          { user_id: 'u-a', vitana_id: 'maria1', display_name: 'Maria A', score: 0.7, reason: 'fuzzy_name' },
          { user_id: 'u-b', vitana_id: 'maria2', display_name: 'Maria B', score: 0.68, reason: 'fuzzy_name' },
        ],
        error: null,
      })),
    });
    const res = await tool_start_conversation({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Which one');
  });
});

// ---------------------------------------------------------------------------
// list_conversations
// ---------------------------------------------------------------------------

describe('list_conversations', () => {
  it('rejects unauthenticated users', async () => {
    const res = await tool_list_conversations({}, ANON, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });

  it('delegates to runRecentConversations with the identity tenant', async () => {
    (runRecentConversations as jest.Mock).mockResolvedValue({
      ok: true,
      text: 'The user\'s most recent conversations, newest first: Maria Lopez (2h ago, they wrote last — "see you!").',
      result: { count: 1, contacts: [] },
    });
    const res = await tool_list_conversations({ limit: 5 }, ID, makeSb({}));
    expect(runRecentConversations).toHaveBeenCalledWith(
      { limit: 5 },
      { user_id: ID.user_id, tenant_id: 't-1' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('Maria Lopez');
  });

  it('backfills tenant from app_users when identity has none', async () => {
    (runRecentConversations as jest.Mock).mockResolvedValue({
      ok: true,
      text: 'no conversations',
      result: { count: 0, contacts: [] },
    });
    const sb = makeSb({ tables: { app_users: { data: { tenant_id: 't-9' } } } });
    const res = await tool_list_conversations({}, { ...ID, tenant_id: null }, sb);
    expect(runRecentConversations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenant_id: 't-9' }),
    );
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mark_conversation_read
// ---------------------------------------------------------------------------

describe('mark_conversation_read', () => {
  it('rejects unauthenticated users', async () => {
    const res = await tool_mark_conversation_read({}, ANON, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });

  it('marks a named conversation read and reports the count', async () => {
    const sb = makeSb({
      rpc: resolveMariaRpc(),
      tables: { chat_messages: { count: 3, error: null } },
    });
    const res = await tool_mark_conversation_read({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('3 message(s)');
      expect(res.text).toContain('Maria Lopez');
      expect((res.result as any).updated).toBe(3);
    }
  });

  it('says so when nothing was unread', async () => {
    const sb = makeSb({
      rpc: resolveMariaRpc(),
      tables: { chat_messages: { count: 0, error: null } },
    });
    const res = await tool_mark_conversation_read({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('Nothing was unread from Maria Lopez');
  });

  it('marks everything read when no member is given', async () => {
    const sb = makeSb({ tables: { chat_messages: { count: 7, error: null } } });
    const res = await tool_mark_conversation_read({}, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('7 unread message(s)');
      expect((res.result as any).scope).toBe('all');
    }
  });
});

// ---------------------------------------------------------------------------
// mute_conversation / archive_conversation — honest "not supported"
// ---------------------------------------------------------------------------

describe('mute_conversation', () => {
  it('returns an honest not-supported answer (no mute column exists)', async () => {
    const res = await tool_mute_conversation({ member: 'Maria' }, ID, makeSb({}));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("isn't supported");
      expect(res.text).toContain('block_user');
      expect((res.result as any).supported).toBe(false);
    }
  });
});

describe('archive_conversation', () => {
  it('returns an honest not-supported answer (no archived state exists)', async () => {
    const res = await tool_archive_conversation({}, ID, makeSb({}));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("isn't supported");
      expect((res.result as any).supported).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// update_account_visibility
// ---------------------------------------------------------------------------

describe('update_account_visibility', () => {
  it('rejects unauthenticated users', async () => {
    const res = await tool_update_account_visibility({ visibility: 'private' }, ANON, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });

  it('asks for confirmation before writing', async () => {
    const sb = makeSb({});
    const res = await tool_update_account_visibility({ visibility: 'private' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as any).requires_confirmation).toBe(true);
      expect(res.text).toContain('confirm=true');
    }
    expect((sb.from as jest.Mock)).not.toHaveBeenCalled();
  });

  it('writes every toggleable field on confirm and maps followers_only → connections', async () => {
    let writtenMap: Record<string, string> | null = null;
    const readChain = makeChain({ data: { account_visibility: {} } });
    const writeChain = makeChain({ error: null });
    (writeChain.update as jest.Mock).mockImplementation((payload: any) => {
      writtenMap = payload.account_visibility;
      return writeChain;
    });
    const chains = [readChain, writeChain];
    const sb = {
      rpc: jest.fn(),
      from: jest.fn(() => chains.shift() ?? makeChain({})),
    } as unknown as SupabaseClient;

    const res = await tool_update_account_visibility(
      { visibility: 'followers_only', confirm: true },
      ID,
      sb,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('connections');
    expect(writtenMap).not.toBeNull();
    expect(writtenMap!.dateOfBirth).toBe('connections');
    expect(writtenMap!.city).toBe('connections');
    // Hardcoded safety key must never be written.
    expect(writtenMap!['myPosts.partnerSeek']).toBeUndefined();
  });

  it('rejects an unknown visibility value', async () => {
    const res = await tool_update_account_visibility({ visibility: 'invisible' }, ID, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('public');
  });
});

// ---------------------------------------------------------------------------
// update_privacy_field
// ---------------------------------------------------------------------------

describe('update_privacy_field', () => {
  it('rejects unauthenticated users', async () => {
    const res = await tool_update_privacy_field(
      { field: 'age', visibility: 'private' },
      ANON,
      makeSb({}),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });

  it('maps a spoken field (age) to the real key and writes the tier', async () => {
    let writtenMap: Record<string, string> | null = null;
    const readChain = makeChain({ data: { account_visibility: { city: 'public' } } });
    const writeChain = makeChain({ error: null });
    (writeChain.update as jest.Mock).mockImplementation((payload: any) => {
      writtenMap = payload.account_visibility;
      return writeChain;
    });
    const chains = [readChain, writeChain];
    const sb = {
      rpc: jest.fn(),
      from: jest.fn(() => chains.shift() ?? makeChain({})),
    } as unknown as SupabaseClient;

    const res = await tool_update_privacy_field({ field: 'age', visibility: 'private' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('age');
    expect(writtenMap).not.toBeNull();
    expect(writtenMap!.derivedAgeBand).toBe('private');
    // Untouched keys are preserved.
    expect(writtenMap!.city).toBe('public');
  });

  it('handles health honestly — always private, no setting', async () => {
    const sb = makeSb({});
    const res = await tool_update_privacy_field(
      { field: 'health', visibility: 'private' },
      ID,
      sb,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('always private');
    expect((sb.from as jest.Mock)).not.toHaveBeenCalled();
  });

  it('rejects unknown fields with the list of real ones', async () => {
    const res = await tool_update_privacy_field(
      { field: 'shoe_size', visibility: 'private' },
      ID,
      makeSb({}),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('location');
  });
});

// ---------------------------------------------------------------------------
// block_user
// ---------------------------------------------------------------------------

describe('block_user', () => {
  it('rejects unauthenticated users', async () => {
    const res = await tool_block_user({ member: 'Maria' }, ANON, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });

  it('asks for confirmation with the resolved name first', async () => {
    const sb = makeSb({ rpc: resolveMariaRpc() });
    const res = await tool_block_user({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as any).requires_confirmation).toBe(true);
      expect((res.result as any).member_user_id).toBe(MARIA_UUID);
      expect(res.text).toContain('Maria Lopez');
    }
  });

  it('upserts into user_blocked_authors on confirm', async () => {
    const upsertChain = makeChain({ error: null });
    const sb = {
      rpc: resolveMariaRpc(),
      from: jest.fn((table: string) =>
        table === 'user_blocked_authors' ? upsertChain : makeChain({}),
      ),
    } as unknown as SupabaseClient;

    const res = await tool_block_user({ member: 'Maria', confirm: true }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('Maria Lopez is blocked');
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      { user_id: ID.user_id, author_id: MARIA_UUID },
      { onConflict: 'user_id,author_id' },
    );
  });

  it('refuses to block yourself', async () => {
    const sb = makeSb({
      rpc: jest.fn(async () => ({
        data: [
          { user_id: ID.user_id, vitana_id: 'me', display_name: 'Me', score: 1.0, reason: 'vitana_id_exact' },
        ],
        error: null,
      })),
    });
    const res = await tool_block_user({ member: 'me', confirm: true }, ID, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('yourself');
  });
});

// ---------------------------------------------------------------------------
// unblock_user
// ---------------------------------------------------------------------------

describe('unblock_user', () => {
  it('rejects unauthenticated users', async () => {
    const res = await tool_unblock_user({ member: 'Maria' }, ANON, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });

  it('unblocks a member matched against the own blocked list', async () => {
    const selectChain = makeChain({ data: [{ author_id: MARIA_UUID }] });
    const deleteChain = makeChain({ error: null });
    const blockedChains = [selectChain, deleteChain];
    const sb = {
      rpc: jest.fn(),
      from: jest.fn((table: string) => {
        if (table === 'user_blocked_authors') return blockedChains.shift() ?? makeChain({});
        if (table === 'app_users') {
          return makeChain({
            data: [{ user_id: MARIA_UUID, display_name: 'Maria Lopez', vitana_id: 'maria6' }],
          });
        }
        return makeChain({});
      }),
    } as unknown as SupabaseClient;

    const res = await tool_unblock_user({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Maria Lopez is unblocked');
      expect((res.result as any).unblocked).toBe(true);
    }
    expect(deleteChain.delete).toHaveBeenCalled();
  });

  it('says so when nobody is blocked', async () => {
    const sb = makeSb({ tables: { user_blocked_authors: { data: [] } } });
    const res = await tool_unblock_user({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("haven't blocked anyone");
  });

  it('lists the blocked members when the name does not match', async () => {
    const sb = makeSb({
      tables: {
        user_blocked_authors: { data: [{ author_id: 'u-x' }] },
        app_users: {
          data: [{ user_id: 'u-x', display_name: 'Peter Pan', vitana_id: 'peter1' }],
        },
      },
    });
    const res = await tool_unblock_user({ member: 'Maria' }, ID, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("isn't on your blocked list");
      expect(res.text).toContain('Peter Pan');
      expect((res.result as any).unblocked).toBe(false);
    }
  });
});
