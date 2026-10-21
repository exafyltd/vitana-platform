/**
 * P0 coverage-gap voice tools (BOOTSTRAP-VOICE-P0-GAPS) — unit tests.
 *
 * All external backings are mocked: the social-memory member resolver, the
 * wallet balance-service, and a chainable/thenable SupabaseClient stub. Per
 * tool we cover the happy path (ok:true + speakable text with the actual
 * content), the unauthenticated gate, and the confirm-gate contract for the
 * gated mutations (unfollow_member, update_profile, comment_on_post).
 */

jest.mock('../../src/services/social-memory/social-memory-repository', () => ({
  resolvePersonByName: jest.fn(),
}));
jest.mock('../../src/services/wallet/balance-service', () => ({
  getAccountsForUser: jest.fn(),
  getTransactionsForUser: jest.fn(),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePersonByName } from '../../src/services/social-memory/social-memory-repository';
import {
  getAccountsForUser,
  getTransactionsForUser,
} from '../../src/services/wallet/balance-service';
import {
  P0_GAP_TOOL_HANDLERS,
  P0_GAP_TOOL_DECLARATIONS,
  tool_follow_member,
  tool_unfollow_member,
  tool_get_notifications,
  tool_mark_notifications_read,
  tool_get_wallet_balance,
  tool_update_profile,
  tool_play_podcast,
  tool_like_post,
  tool_comment_on_post,
} from '../../src/services/orb-tools/p0-gap-tools';

const IDENT = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const ANON = { user_id: '', tenant_id: null, role: null };

// ---------------------------------------------------------------------------
// Chainable + thenable Supabase query stub
// ---------------------------------------------------------------------------

interface QResult {
  data?: unknown;
  error?: { message: string } | null;
}

function makeQuery(result: QResult = {}) {
  const q: Record<string, jest.Mock | unknown> = {};
  const chainMethods = [
    'select', 'eq', 'neq', 'is', 'not', 'or', 'in', 'ilike',
    'order', 'limit', 'range', 'update', 'insert', 'delete', 'upsert',
  ];
  for (const m of chainMethods) q[m] = jest.fn(() => q);
  const resolved = { data: result.data ?? null, error: result.error ?? null };
  q.maybeSingle = jest.fn(async () => resolved);
  q.single = jest.fn(async () => resolved);
  (q as { then?: unknown }).then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(resolved).then(onF, onR);
  return q as Record<string, jest.Mock> & PromiseLike<typeof resolved>;
}

/** sb.from(table) pops queued query stubs per table (last one sticks). */
function makeSb(queues: Record<string, Array<ReturnType<typeof makeQuery>>>) {
  return {
    from: jest.fn((table: string) => {
      const queue = queues[table];
      if (!queue || queue.length === 0) throw new Error(`unexpected query on table ${table}`);
      return queue.length > 1 ? queue.shift() : queue[0];
    }),
  } as unknown as SupabaseClient;
}

const person = (user_id: string, display_name: string) => ({
  user_id,
  display_name,
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
});

// ---------------------------------------------------------------------------
// Exports / declarations shape
// ---------------------------------------------------------------------------

describe('p0 gap tools — exports', () => {
  const NAMES = [
    'follow_member',
    'unfollow_member',
    'get_notifications',
    'mark_notifications_read',
    'get_wallet_balance',
    'update_profile',
    'play_podcast',
    'like_post',
    'comment_on_post',
  ];

  it.each(NAMES)('%s is in P0_GAP_TOOL_HANDLERS', (name) => {
    expect(typeof P0_GAP_TOOL_HANDLERS[name]).toBe('function');
  });

  it.each(NAMES)('%s is declared in P0_GAP_TOOL_DECLARATIONS', (name) => {
    expect(P0_GAP_TOOL_DECLARATIONS.find((d) => d.name === name)).toBeDefined();
  });

  it('declarations use only the Vertex-safe OpenAPI subset', () => {
    const raw = JSON.stringify(P0_GAP_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
      expect(raw).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// follow_member
// ---------------------------------------------------------------------------

describe('follow_member', () => {
  it('resolves the member and inserts the follow edge', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const sb = makeSb({
      user_follows: [makeQuery({ data: null }), makeQuery({})],
    });
    const res = await tool_follow_member({ name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Anna Schmidt');
      expect(res.text).toMatch(/following/i);
    }
  });

  it('is idempotent when already following', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const sb = makeSb({ user_follows: [makeQuery({ data: { id: 'f-1' } })] });
    const res = await tool_follow_member({ name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('already follow');
  });

  it('soft-fails when the member is not found', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(null);
    const sb = makeSb({});
    const res = await tool_follow_member({ name: 'Zzyzx' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("couldn't find");
  });

  it('refuses to follow yourself', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-1', 'Me Myself'));
    const sb = makeSb({});
    const res = await tool_follow_member({ name: 'Me' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/cannot follow yourself/i);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_follow_member({ name: 'Anna' }, ANON as never, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });
});

// ---------------------------------------------------------------------------
// unfollow_member
// ---------------------------------------------------------------------------

describe('unfollow_member', () => {
  it('asks for confirmation before deleting the follow edge', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const sb = makeSb({ user_follows: [makeQuery({ data: { id: 'f-1' } })] });
    const res = await tool_unfollow_member({ name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { stage: string }).stage).toBe('awaiting_confirmation');
      expect(res.text).toContain('Anna Schmidt');
      expect(res.text).toContain('confirmed=true');
    }
  });

  it('deletes the edge when confirmed=true', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const del = makeQuery({});
    const sb = makeSb({ user_follows: [makeQuery({ data: { id: 'f-1' } }), del] });
    const res = await tool_unfollow_member({ name: 'Anna', confirmed: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('no longer follow');
    expect(del.delete).toHaveBeenCalled();
  });

  it('soft-fails when not following the member', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const sb = makeSb({ user_follows: [makeQuery({ data: null })] });
    const res = await tool_unfollow_member({ name: 'Anna', confirmed: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('not following');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_unfollow_member({ name: 'Anna' }, ANON as never, makeSb({}));
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_notifications
// ---------------------------------------------------------------------------

describe('get_notifications', () => {
  const rows = [
    { id: 'n-1', type: 'new_match', title: 'New match found', body: 'Anna matches your intent', read_at: '2026-07-05T10:00:00Z', created_at: '2026-07-05T09:00:00Z' },
    { id: 'n-2', type: 'live_room_starting', title: 'Live room starting', body: null, read_at: null, created_at: '2026-07-04T09:00:00Z' },
  ];

  it('speaks the unread count and titles, unread first', async () => {
    const sb = makeSb({ user_notifications: [makeQuery({ data: rows })] });
    const res = await tool_get_notifications({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('1 unread notification');
      expect(res.text).toContain('Live room starting');
      expect(res.text).toContain('New match found');
      const list = (res.result as { notifications: Array<{ id: string }> }).notifications;
      expect(list[0].id).toBe('n-2'); // unread first
    }
  });

  it('answers plainly when there are no notifications', async () => {
    const sb = makeSb({ user_notifications: [makeQuery({ data: [] })] });
    const res = await tool_get_notifications({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/no notifications/i);
  });

  it('requires an authenticated user with tenant', async () => {
    const res = await tool_get_notifications({}, { user_id: 'u-1', tenant_id: null, role: null } as never, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });
});

// ---------------------------------------------------------------------------
// mark_notifications_read
// ---------------------------------------------------------------------------

describe('mark_notifications_read', () => {
  it('marks all unread and speaks the count', async () => {
    const q = makeQuery({ data: [{ id: 'n-1' }, { id: 'n-2' }] });
    const sb = makeSb({ user_notifications: [q] });
    const res = await tool_mark_notifications_read({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('all 2 unread notifications');
      expect((res.result as { marked: number }).marked).toBe(2);
    }
    expect(q.update).toHaveBeenCalledWith(expect.objectContaining({ read_at: expect.any(String) }));
    expect(q.ilike).not.toHaveBeenCalled();
  });

  it('scopes to a title reference when given', async () => {
    const q = makeQuery({ data: [{ id: 'n-1' }] });
    const sb = makeSb({ user_notifications: [q] });
    const res = await tool_mark_notifications_read({ reference: 'match' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('"match"');
    expect(q.ilike).toHaveBeenCalledWith('title', '%match%');
  });

  it('stays ok when nothing was unread', async () => {
    const sb = makeSb({ user_notifications: [makeQuery({ data: [] })] });
    const res = await tool_mark_notifications_read({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/no unread/i);
  });

  it('requires an authenticated user with tenant', async () => {
    const res = await tool_mark_notifications_read({}, ANON as never, makeSb({}));
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_wallet_balance
// ---------------------------------------------------------------------------

describe('get_wallet_balance', () => {
  it('speaks balances, subscription and recent transactions (read-only)', async () => {
    (getAccountsForUser as jest.Mock).mockResolvedValue([
      { currency: 'EUR', balance_minor: 12550, status: 'active', updated_at: 'x' },
    ]);
    (getTransactionsForUser as jest.Mock).mockResolvedValue({
      entries: [
        { id: 'l-1', entry_type: 'deposit', direction: 'credit', amount_minor: 5000, currency: 'EUR', description: 'Top-up', created_at: '2026-07-01T00:00:00Z' },
      ],
      next_cursor: null,
    });
    const sb = makeSb({
      user_subscriptions: [makeQuery({ data: { plan_key: 'premium', status: 'active', current_period_end: '2026-08-01T00:00:00Z' } })],
    });
    const res = await tool_get_wallet_balance({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('125.50 EUR');
      expect(res.text).toContain('premium');
      expect(res.text).toContain('Top-up');
      expect(res.text).toMatch(/read-only/i);
    }
    expect(getTransactionsForUser).toHaveBeenCalledWith({ user_id: 'u-1', limit: 3 });
  });

  it('handles an empty wallet honestly', async () => {
    (getAccountsForUser as jest.Mock).mockResolvedValue([]);
    (getTransactionsForUser as jest.Mock).mockResolvedValue({ entries: [], next_cursor: null });
    const sb = makeSb({ user_subscriptions: [makeQuery({ data: null })] });
    const res = await tool_get_wallet_balance({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/zero/i);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_get_wallet_balance({}, ANON as never, makeSb({}));
    expect(res.ok).toBe(false);
    expect(getAccountsForUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// update_profile
// ---------------------------------------------------------------------------

describe('update_profile', () => {
  it('asks for confirmation with a verbatim read-back first', async () => {
    const res = await tool_update_profile({ bio: 'Longevity nerd', city: 'Berlin' }, IDENT, makeSb({}));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { stage: string }).stage).toBe('awaiting_confirmation');
      expect(res.text).toContain('Longevity nerd');
      expect(res.text).toContain('Berlin');
      expect(res.text).toContain('confirmed=true');
    }
  });

  it('updates the profiles row when confirmed', async () => {
    const q = makeQuery({});
    const sb = makeSb({ profiles: [q] });
    const res = await tool_update_profile({ display_name: 'Anna S.', confirmed: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('Anna S.');
    expect(q.update).toHaveBeenCalledWith({ display_name: 'Anna S.' });
    expect(q.eq).toHaveBeenCalledWith('user_id', 'u-1');
  });

  it('never accepts role or visibility fields', async () => {
    const res = await tool_update_profile({ role: 'admin', account_visibility: 'x' } as never, IDENT, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/display_name, bio, city, country or location/);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_update_profile({ bio: 'x' }, ANON as never, makeSb({}));
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// play_podcast
// ---------------------------------------------------------------------------

describe('play_podcast', () => {
  it('returns an open_url directive and speaks the title', async () => {
    const sb = makeSb({
      media_uploads: [
        makeQuery({
          data: [
            {
              id: 'm-1',
              title: 'Longevity Foundations',
              description: 'Sleep deep dive',
              file_url: 'https://cdn/x.mp3',
              thumbnail_url: null,
              duration: 1800,
              podcast_metadata: { host_name: 'Dr. Weber', series_name: 'Vitana Talks' },
            },
          ],
        }),
      ],
    });
    const res = await tool_play_podcast({ query: 'longevity' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Longevity Foundations');
      expect(res.text).toContain('Dr. Weber');
      const result = res.result as { directive: { directive: string; url: string } };
      expect(result.directive.directive).toBe('open_url');
      expect(result.directive.url).toBe('https://cdn/x.mp3');
    }
  });

  it('soft-fails with a Media Hub nudge when nothing matches', async () => {
    const sb = makeSb({ media_uploads: [makeQuery({ data: [] })] });
    const res = await tool_play_podcast({ query: 'zzz' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("couldn't find");
      expect((res.result as { played: boolean }).played).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// like_post
// ---------------------------------------------------------------------------

describe('like_post', () => {
  const posts = [
    { id: 'p-2', user_id: 'u-9', content: 'Morning run done, feeling great!', created_at: '2026-07-05T08:00:00Z' },
    { id: 'p-1', user_id: 'u-9', content: 'Older post about supplements', created_at: '2026-07-01T08:00:00Z' },
  ];

  it("likes the author's most recent public post", async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const insertQ = makeQuery({});
    const sb = makeSb({
      profile_posts: [makeQuery({ data: posts })],
      profile_post_likes: [makeQuery({ data: null }), insertQ],
    });
    const res = await tool_like_post({ author_name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Anna Schmidt');
      expect(res.text).toContain('Morning run');
    }
    expect(insertQ.insert).toHaveBeenCalledWith({ post_id: 'p-2', user_id: 'u-1' });
  });

  it('picks a specific post via post_reference', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const insertQ = makeQuery({});
    const sb = makeSb({
      profile_posts: [makeQuery({ data: posts })],
      profile_post_likes: [makeQuery({ data: null }), insertQ],
    });
    const res = await tool_like_post({ author_name: 'Anna', post_reference: 'supplements' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(insertQ.insert).toHaveBeenCalledWith({ post_id: 'p-1', user_id: 'u-1' });
  });

  it('is idempotent when already liked', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const sb = makeSb({
      profile_posts: [makeQuery({ data: posts })],
      profile_post_likes: [makeQuery({ data: { id: 'l-1' } })],
    });
    const res = await tool_like_post({ author_name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('already liked');
  });

  it('soft-fails when the author has no public posts', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const sb = makeSb({ profile_posts: [makeQuery({ data: [] })] });
    const res = await tool_like_post({ author_name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('no public posts');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_like_post({ author_name: 'Anna' }, ANON as never, makeSb({}));
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// comment_on_post
// ---------------------------------------------------------------------------

describe('comment_on_post', () => {
  const posts = [
    { id: 'p-2', user_id: 'u-9', content: 'Morning run done!', created_at: '2026-07-05T08:00:00Z' },
  ];

  it('reads the comment back before posting (confirm gate)', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const sb = makeSb({ profile_posts: [makeQuery({ data: posts })] });
    const res = await tool_comment_on_post({ author_name: 'Anna', text: 'Great pace!' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { stage: string }).stage).toBe('awaiting_confirmation');
      expect(res.text).toContain('Great pace!');
      expect(res.text).toContain('confirmed=true');
    }
  });

  it('inserts the comment when confirmed', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(person('u-9', 'Anna Schmidt'));
    const insertQ = makeQuery({});
    const sb = makeSb({
      profile_posts: [makeQuery({ data: posts })],
      profile_post_comments: [insertQ],
    });
    const res = await tool_comment_on_post(
      { author_name: 'Anna', text: 'Great pace!', confirmed: true },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/comment is live/i);
    expect(insertQ.insert).toHaveBeenCalledWith({ post_id: 'p-2', user_id: 'u-1', content: 'Great pace!' });
  });

  it('requires comment text', async () => {
    const res = await tool_comment_on_post({ author_name: 'Anna' }, IDENT, makeSb({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('text');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_comment_on_post({ author_name: 'Anna', text: 'x' }, ANON as never, makeSb({}));
    expect(res.ok).toBe(false);
  });
});
