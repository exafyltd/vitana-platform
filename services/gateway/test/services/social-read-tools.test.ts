/**
 * BOOTSTRAP-SOCIAL-READ-TOOLS — walls + logic for the READ capabilities
 * (docs/CONVERSATION_DEFECTS_FIX_PLAN.md defects 1, 4, 5).
 *
 * Walls (anti-regression, same style as the get_social_context suite):
 *   1. all four tools are in the shared ORB registry
 *   2. the Vertex live catalog declares them with the internal-vs-external
 *      and no-"archived" contracts
 *   3. orb-live.ts routes their case arms to the shared dispatcher
 *
 * Logic: speakable output, blocked-sender exclusion, fail-closed privacy,
 * empty states that answer plainly instead of deflecting.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));
jest.mock('../../src/services/social-memory/social-memory-repository', () => ({
  fetchExclusions: jest.fn(),
  fetchFollowEdges: jest.fn(),
  fetchRecentMessageContacts: jest.fn(),
  fetchPeople: jest.fn(),
}));

import { getSupabase } from '../../src/lib/supabase';
import {
  fetchExclusions,
  fetchFollowEdges,
  fetchRecentMessageContacts,
  fetchPeople,
} from '../../src/services/social-memory/social-memory-repository';
import {
  runViewMessages,
  runListFollows,
  runRecentConversations,
} from '../../src/services/social-memory/social-read-tools';
import { ORB_TOOL_REGISTRY } from '../../src/services/orb-tools-shared';
import { buildLiveApiTools } from '../../src/orb/live/tools/live-tool-catalog';

const SRC = path.join(__dirname, '..', '..', 'src');
const READ_TOOLS = ['view_messages', 'list_followers', 'list_following', 'recent_conversations'];
const IDENT = { user_id: 'u-1', tenant_id: 't-1' };

const person = (id: string, name: string) => ({
  user_id: id,
  display_name: name,
  handle: null,
  vitana_id: null,
  avatar_url: null,
  bio: null,
  city: null,
  country: null,
  visibility: 'public',
});

beforeEach(() => {
  jest.clearAllMocks();
  (fetchExclusions as jest.Mock).mockResolvedValue({
    blocked: new Set<string>(),
    muted: new Set<string>(),
    hidden_posts: new Set<string>(),
  });
});

// ---------------------------------------------------------------------------
// Wall 1 — shared registry
// ---------------------------------------------------------------------------

describe('social read tools — shared registry', () => {
  it.each(READ_TOOLS)('%s is registered in ORB_TOOL_REGISTRY', (name) => {
    expect(typeof ORB_TOOL_REGISTRY[name]).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Wall 2 — Vertex live catalog declarations + contracts
// ---------------------------------------------------------------------------

describe('social read tools — Vertex live catalog declaration', () => {
  function collectDeclarations(): any[] {
    const out: any[] = [];
    for (const t of buildLiveApiTools() as any[]) {
      if (t?.name) out.push(t);
      // Vertex BidiGenerate uses snake_case function_declarations.
      for (const fd of t?.function_declarations || t?.functionDeclarations || []) out.push(fd);
    }
    return out;
  }

  it.each(READ_TOOLS)('%s is declared', (name) => {
    expect(collectDeclarations().find((d) => d.name === name)).toBeDefined();
  });

  it('view_messages carries the internal-vs-external and no-archived contracts', () => {
    const decl = collectDeclarations().find((d) => d.name === 'view_messages');
    expect(decl.description).toContain('NEVER mention Google');
    expect(decl.description).toContain('archived');
    expect(decl.description).toContain('Zeig mir meine Nachrichten');
    expect(decl.description).toContain('send_chat_message');
  });

  it('list_followers forbids deflection', () => {
    const decl = collectDeclarations().find((d) => d.name === 'list_followers');
    expect(decl.description).toContain('Wer folgt mir?');
    expect(decl.description).toContain('NEVER say you cannot tell');
  });

  it('recent_conversations binds the last-chat question', () => {
    const decl = collectDeclarations().find((d) => d.name === 'recent_conversations');
    expect(decl.description).toContain('Mit wem habe ich zuletzt geschrieben?');
    expect(decl.description).toContain('no Google account');
  });
});

// ---------------------------------------------------------------------------
// Wall 3 — Vertex case arms delegate to the shared dispatcher
// ---------------------------------------------------------------------------

describe('social read tools — Vertex wiring (source wall)', () => {
  it('orb-live.ts routes all four case arms to dispatchOrbToolForVertex', () => {
    const src = fs.readFileSync(path.join(SRC, 'routes', 'orb-live.ts'), 'utf8');
    for (const name of READ_TOOLS) {
      expect(src).toContain(`case '${name}':`);
    }
    const idx = src.indexOf("case 'view_messages':");
    expect(src.slice(idx, idx + 2500)).toContain('dispatchOrbToolForVertex');
  });
});

// ---------------------------------------------------------------------------
// view_messages logic
// ---------------------------------------------------------------------------

function fakeChatSupabase(rows: Array<Record<string, unknown>>) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
  };
  return { from: jest.fn(() => builder) };
}

describe('runViewMessages', () => {
  it('groups by sender, excludes blocked senders, and is speakable', async () => {
    (getSupabase as jest.Mock).mockReturnValue(
      fakeChatSupabase([
        { sender_id: 'p-1', content: 'Hallo Dragan, wie geht es dir?', created_at: new Date().toISOString(), read_at: null },
        { sender_id: 'p-1', content: 'Bist du morgen dabei?', created_at: new Date().toISOString(), read_at: null },
        { sender_id: 'p-2', content: 'Danke für gestern!', created_at: new Date().toISOString(), read_at: null },
        { sender_id: 'p-blocked', content: 'spam', created_at: new Date().toISOString(), read_at: null },
      ]),
    );
    (fetchExclusions as jest.Mock).mockResolvedValue({
      blocked: new Set(['p-blocked']),
      muted: new Set(),
      hidden_posts: new Set(),
    });
    (fetchPeople as jest.Mock).mockResolvedValue(
      new Map([
        ['p-1', person('p-1', 'Mariia Maksina')],
        ['p-2', person('p-2', 'Kemal')],
      ]),
    );
    const res = await runViewMessages({}, IDENT);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('3 unread message(s) from 2 person(s)');
    expect(res.text).toContain('Mariia Maksina (2');
    expect(res.text).toContain('Kemal (1');
    expect(res.text).not.toContain('spam');
    // The guardrails ride along on every answer.
    expect(res.text).toContain('NEVER mention Google');
    expect(res.text).toContain('NEVER offer or mention "archived"');
  });

  it('empty inbox answers plainly (no invented categories)', async () => {
    (getSupabase as jest.Mock).mockReturnValue(fakeChatSupabase([]));
    const res = await runViewMessages({}, IDENT);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('NO unread messages');
    expect(res.result).toMatchObject({ total: 0 });
  });

  it('fails CLOSED when privacy filters cannot be loaded', async () => {
    (getSupabase as jest.Mock).mockReturnValue(fakeChatSupabase([]));
    (fetchExclusions as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await runViewMessages({}, IDENT);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('do not guess');
  });

  it('requires an authenticated identity', async () => {
    const res = await runViewMessages({}, { user_id: 'u-1' });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list_followers / list_following logic
// ---------------------------------------------------------------------------

describe('runListFollows', () => {
  it('answers followers with count, names, and mutuals', async () => {
    (fetchFollowEdges as jest.Mock).mockResolvedValue({
      followers: [
        { person: person('p-1', 'Mariia Maksina'), since: '2026-06-01' },
        { person: person('p-2', 'Kemal'), since: '2026-06-02' },
      ],
      following: [{ person: person('p-1', 'Mariia Maksina'), since: '2026-06-01' }],
    });
    const res = await runListFollows('followers', IDENT);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('2 member(s) follow the user');
    expect(res.text).toContain('Mariia Maksina');
    expect(res.text).toContain('1 of them are mutual');
    expect(res.text).toContain('NEVER say you cannot tell');
  });

  it('zero followers answers plainly instead of deflecting', async () => {
    (fetchFollowEdges as jest.Mock).mockResolvedValue({ followers: [], following: [] });
    const res = await runListFollows('followers', IDENT);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Nobody follows the user yet');
    expect(res.text).toContain('never deflect');
  });

  it('fails CLOSED on privacy-filter errors', async () => {
    (fetchExclusions as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await runListFollows('following', IDENT);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('do not guess');
  });
});

// ---------------------------------------------------------------------------
// recent_conversations logic
// ---------------------------------------------------------------------------

describe('runRecentConversations', () => {
  it('lists conversations newest first with the last-chat answer', async () => {
    (fetchRecentMessageContacts as jest.Mock).mockResolvedValue([
      {
        person: person('p-1', 'Mariia Maksina'),
        last_message_at: new Date().toISOString(),
        last_direction: 'received',
        last_snippet: 'Bis morgen!',
        messages_30d: 5,
      },
      {
        person: person('p-2', 'Kemal'),
        last_message_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        last_direction: 'sent',
        last_snippet: null,
        messages_30d: 2,
      },
    ]);
    const res = await runRecentConversations({}, IDENT);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Mariia Maksina');
    expect((res.text as string).indexOf('Mariia')).toBeLessThan((res.text as string).indexOf('Kemal'));
    expect(res.text).toContain('The FIRST entry answers "who did I last chat with"');
    expect(res.text).toContain('no Google involved');
  });

  it('no conversations answers plainly', async () => {
    (fetchRecentMessageContacts as jest.Mock).mockResolvedValue([]);
    const res = await runRecentConversations({}, IDENT);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('no direct-message conversations');
  });

  it('fails CLOSED on privacy-filter errors', async () => {
    (fetchExclusions as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await runRecentConversations({}, IDENT);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('do not guess');
  });
});
