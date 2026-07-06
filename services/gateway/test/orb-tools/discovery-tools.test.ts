/**
 * Discovery voice tools (VTID-02773 / 02775 / 02777 / 02780) — unit tests.
 *
 * The handlers adapt existing backings (social-memory repository, the
 * autopilot_recommendations snooze/reject RPCs, user_intents board/PATCH/close
 * semantics, intent-dispute-service, intent-find-match) into speakable
 * OrbToolResults — so those service modules are mocked here and the direct
 * table reads go through a chainable fake SupabaseClient.
 *
 * Covered per tool: happy path (ok:true + speakable text containing the real
 * content), the unauthenticated gate, and the confirm-flow stages for the
 * destructive tools.
 */

jest.mock('../../src/services/social-memory/social-memory-repository', () => ({
  fetchExclusions: jest.fn(),
  fetchFollowEdges: jest.fn(),
  fetchCandidatePosts: jest.fn(),
  fetchPeople: jest.fn(),
}));
jest.mock('../../src/services/intent-find-match', () => ({
  runFindMatch: jest.fn(),
}));
jest.mock('../../src/services/intent-dispute-service', () => ({
  raiseDispute: jest.fn(),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchExclusions,
  fetchFollowEdges,
  fetchCandidatePosts,
  fetchPeople,
} from '../../src/services/social-memory/social-memory-repository';
import { runFindMatch } from '../../src/services/intent-find-match';
import { raiseDispute } from '../../src/services/intent-dispute-service';
import {
  DISCOVERY_TOOL_HANDLERS,
  DISCOVERY_TOOL_DECLARATIONS,
  tool_global_search,
  tool_browse_news_feed,
  tool_snooze_recommendation,
  tool_dismiss_recommendation,
  tool_explain_recommendation,
  tool_update_intent,
  tool_delete_intent,
  tool_browse_intent_board,
  tool_dispute_match,
  tool_find_perfect_match,
} from '../../src/services/orb-tools/discovery-tools';

const IDENT = { user_id: 'u-1', tenant_id: 't-1', role: 'community', vitana_id: '@dragan' };
const ANON = { user_id: '', tenant_id: null, role: null };

const UUID = '11111111-2222-3333-4444-555555555555';

// ---------------------------------------------------------------------------
// Chainable Supabase fake: per-table FIFO queues of {data, error} results.
// ---------------------------------------------------------------------------

type QResult = { data: unknown; error: { message: string } | null };

interface SbLogEntry {
  table: string;
  method: string;
  args: unknown[];
}

function makeSb(queues: Record<string, QResult[]>, rpcResults: Record<string, QResult> = {}) {
  const log: SbLogEntry[] = [];
  const from = jest.fn((table: string) => {
    const q = queues[table];
    const result: QResult = q && q.length > 0 ? q.shift()! : { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const m of [
      'select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'gte', 'lte',
      'order', 'limit', 'contains', 'update', 'insert',
    ]) {
      builder[m] = jest.fn((...args: unknown[]) => {
        log.push({ table, method: m, args });
        return builder;
      });
    }
    builder.maybeSingle = jest.fn(async () => result);
    builder.single = jest.fn(async () => result);
    (builder as { then: unknown }).then = (
      resolve: (v: QResult) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });
  const rpc = jest.fn(async (name: string) => rpcResults[name] ?? { data: { ok: true }, error: null });
  return { sb: { from, rpc } as unknown as SupabaseClient, from, rpc, log };
}

const noExclusions = { blocked: new Set<string>(), muted: new Set<string>(), hidden_posts: new Set<string>() };

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
  (fetchExclusions as jest.Mock).mockResolvedValue(noExclusions);
  (fetchPeople as jest.Mock).mockResolvedValue(new Map());
});

// ---------------------------------------------------------------------------
// Exports / declarations wall
// ---------------------------------------------------------------------------

describe('discovery tools — exports', () => {
  const NAMES = [
    'global_search',
    'browse_news_feed',
    'snooze_recommendation',
    'dismiss_recommendation',
    'explain_recommendation',
    'update_intent',
    'delete_intent',
    'browse_intent_board',
    'dispute_match',
    'find_perfect_match',
  ];

  it.each(NAMES)('%s is in DISCOVERY_TOOL_HANDLERS', (name) => {
    expect(typeof DISCOVERY_TOOL_HANDLERS[name]).toBe('function');
  });

  it.each(NAMES)('%s is declared in DISCOVERY_TOOL_DECLARATIONS', (name) => {
    expect(DISCOVERY_TOOL_DECLARATIONS.find((d) => d.name === name)).toBeDefined();
  });

  it('declarations use only the Vertex-safe OpenAPI subset (no default/minimum/maximum/format/examples)', () => {
    const raw = JSON.stringify(DISCOVERY_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
      expect(raw).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// global_search
// ---------------------------------------------------------------------------

describe('global_search', () => {
  it('returns grouped speakable results across categories', async () => {
    (fetchPeople as jest.Mock).mockResolvedValue(new Map([['p-2', person('p-2', 'Kemal')]]));
    const { sb } = makeSb({
      profiles: [{ data: [{ user_id: 'p-9', display_name: 'Mariia Maksina', handle: 'mariia', vitana_id: '@mariia', city: 'Berlin' }], error: null }],
      profile_posts: [{ data: [{ id: 'post-1', user_id: 'p-2', content: 'Yoga in the park was amazing today', created_at: new Date().toISOString() }], error: null }],
      global_community_events: [{ data: [{ id: 'e-1', title: 'Sunrise Yoga', start_time: '2026-08-01T08:00:00Z', location: 'Berlin' }], error: null }],
      community_groups: [{ data: [{ id: 'g-1', name: 'Yoga Lovers', topic_key: 'yoga', description: 'Weekly yoga sessions' }], error: null }],
      products_catalog: [{ data: [{ id: 'pr-1', name: 'Yoga Mat Pro', product_type: 'device' }], error: null }],
      services_catalog: [{ data: [{ id: 's-1', name: 'Yoga Coaching', service_type: 'coach', provider_name: 'Anna' }], error: null }],
    });
    const res = await tool_global_search({ query: 'yoga' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Mariia Maksina');
      expect(res.text).toContain('Kemal');
      expect(res.text).toContain('Sunrise Yoga');
      expect(res.text).toContain('Yoga Lovers');
      expect(res.text).toContain('Yoga Mat Pro');
      expect(res.text).toContain('Yoga Coaching');
      const r = res.result as { people: unknown[]; events: unknown[] };
      expect(r.people).toHaveLength(1);
      expect(r.events).toHaveLength(1);
    }
  });

  it('excludes blocked authors and the viewer from people results', async () => {
    (fetchExclusions as jest.Mock).mockResolvedValue({
      blocked: new Set(['p-blocked']),
      muted: new Set(),
      hidden_posts: new Set(),
    });
    const { sb } = makeSb({
      profiles: [{
        data: [
          { user_id: 'p-blocked', display_name: 'Blocked Person', handle: null, vitana_id: null, city: null },
          { user_id: 'u-1', display_name: 'Me Myself', handle: null, vitana_id: null, city: null },
          { user_id: 'p-3', display_name: 'Visible Friend', handle: null, vitana_id: null, city: null },
        ],
        error: null,
      }],
    });
    const res = await tool_global_search({ query: 'person' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Visible Friend');
      expect(res.text).not.toContain('Blocked Person');
      expect(res.text).not.toContain('Me Myself');
    }
  });

  it('answers plainly when nothing matches', async () => {
    const { sb } = makeSb({});
    const res = await tool_global_search({ query: 'zzz-nothing' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('Nothing in the community matched');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_global_search({ query: 'yoga' }, ANON, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });

  it('rejects too-short queries', async () => {
    const { sb } = makeSb({});
    const res = await tool_global_search({ query: 'a' }, IDENT, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// browse_news_feed
// ---------------------------------------------------------------------------

describe('browse_news_feed', () => {
  const post = (id: string, userId: string, content: string, agoMs: number, likes = 0) => ({
    id,
    user_id: userId,
    content,
    image_url: null,
    video_url: null,
    likes_count: likes,
    comments_count: 0,
    created_at: new Date(Date.now() - agoMs).toISOString(),
  });

  it('speaks the top posts with author names, newest first', async () => {
    (fetchFollowEdges as jest.Mock).mockResolvedValue({
      following: [{ person: person('p-2', 'Kemal'), since: '2026-06-01' }],
      followers: [],
    });
    (fetchCandidatePosts as jest.Mock).mockResolvedValue([
      post('post-old', 'p-3', 'An older post about hiking', 86400000, 2),
      post('post-new', 'p-2', 'Just finished a 5k run, feeling great!', 3600000, 7),
    ]);
    (fetchPeople as jest.Mock).mockResolvedValue(
      new Map([
        ['p-2', person('p-2', 'Kemal')],
        ['p-3', person('p-3', 'Mariia Maksina')],
      ]),
    );
    const { sb } = makeSb({});
    const res = await tool_browse_news_feed({ limit: 5 }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Kemal');
      expect(res.text).toContain('5k run');
      expect(res.text).toContain('Mariia Maksina');
      // Newest first: the run post is more recent than the hiking post.
      expect(res.text!.indexOf('5k run')).toBeLessThan(res.text!.indexOf('hiking'));
    }
  });

  it('scope=following filters to followed authors only', async () => {
    (fetchFollowEdges as jest.Mock).mockResolvedValue({
      following: [{ person: person('p-2', 'Kemal'), since: '2026-06-01' }],
      followers: [],
    });
    (fetchCandidatePosts as jest.Mock).mockResolvedValue([
      post('post-1', 'p-2', 'Followed author post', 3600000),
      post('post-2', 'p-3', 'Stranger post', 1800000),
    ]);
    (fetchPeople as jest.Mock).mockResolvedValue(new Map([['p-2', person('p-2', 'Kemal')]]));
    const { sb } = makeSb({});
    const res = await tool_browse_news_feed({ scope: 'following' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Followed author post');
      expect(res.text).not.toContain('Stranger post');
    }
  });

  it('scope=following with no follows answers plainly', async () => {
    (fetchFollowEdges as jest.Mock).mockResolvedValue({ following: [], followers: [] });
    const { sb } = makeSb({});
    const res = await tool_browse_news_feed({ scope: 'following' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('does not follow anyone yet');
  });

  it('fails CLOSED when privacy filters cannot be loaded', async () => {
    (fetchExclusions as jest.Mock).mockRejectedValue(new Error('db down'));
    const { sb } = makeSb({});
    const res = await tool_browse_news_feed({}, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('do not guess');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_browse_news_feed({}, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// snooze_recommendation
// ---------------------------------------------------------------------------

const REC = {
  id: UUID,
  title: 'Implement Sleep Quality Tracking',
  summary: 'Track sleep patterns for personalized improvements.',
  domain: 'health',
  risk_level: 'low',
  impact_score: 9,
  effort_score: 3,
  status: 'new',
  snoozed_until: null,
  user_id: 'u-1',
  source_type: 'community',
  contribution_vector: { sleep: 0.7, mental: 0.2 },
  economic_axis: 'none',
  created_at: '2026-07-01T00:00:00Z',
};

describe('snooze_recommendation', () => {
  it('snoozes by id via the Command Hub RPC and speaks the title', async () => {
    const { sb, rpc } = makeSb(
      { autopilot_recommendations: [{ data: REC, error: null }] },
      { snooze_autopilot_recommendation: { data: { ok: true, snoozed_until: '2026-07-07T10:00:00Z' }, error: null } },
    );
    const res = await tool_snooze_recommendation({ recommendation: UUID, hours: 48 }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Implement Sleep Quality Tracking');
      expect(res.text).toContain('48 hours');
    }
    expect(rpc).toHaveBeenCalledWith('snooze_autopilot_recommendation', {
      p_recommendation_id: UUID,
      p_hours: 48,
    });
  });

  it('resolves a spoken title fragment when only one row matches', async () => {
    const { sb, rpc } = makeSb(
      { autopilot_recommendations: [{ data: [REC], error: null }] },
      { snooze_autopilot_recommendation: { data: { ok: true }, error: null } },
    );
    const res = await tool_snooze_recommendation({ recommendation: 'sleep tracking' }, IDENT, sb);
    expect(res.ok).toBe(true);
    // Default + clamped hours.
    expect(rpc).toHaveBeenCalledWith('snooze_autopilot_recommendation', {
      p_recommendation_id: UUID,
      p_hours: 24,
    });
  });

  it('refuses to touch another user\'s recommendation', async () => {
    const { sb, rpc } = makeSb({
      autopilot_recommendations: [{ data: { ...REC, user_id: 'someone-else' }, error: null }],
    });
    const res = await tool_snooze_recommendation({ recommendation: UUID }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('another_user');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('stays ok:true with an honest empty state when nothing matches', async () => {
    const { sb, rpc } = makeSb({ autopilot_recommendations: [{ data: [], error: null }] });
    const res = await tool_snooze_recommendation({ recommendation: 'nonexistent thing' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('No open recommendation matched');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_snooze_recommendation({ recommendation: UUID }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dismiss_recommendation
// ---------------------------------------------------------------------------

describe('dismiss_recommendation', () => {
  it('asks for confirmation first (no RPC call)', async () => {
    const { sb, rpc } = makeSb({ autopilot_recommendations: [{ data: REC, error: null }] });
    const res = await tool_dismiss_recommendation({ recommendation: UUID }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Confirm with the user first');
      expect(res.text).toContain('Implement Sleep Quality Tracking');
      expect((res.result as { stage: string }).stage).toBe('awaiting_confirmation');
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('dismisses via the reject RPC after confirm=true', async () => {
    const { sb, rpc } = makeSb(
      { autopilot_recommendations: [{ data: REC, error: null }] },
      { reject_autopilot_recommendation: { data: { ok: true }, error: null } },
    );
    const res = await tool_dismiss_recommendation(
      { recommendation: UUID, confirm: true, reason: 'not relevant' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('dismissed');
    expect(rpc).toHaveBeenCalledWith('reject_autopilot_recommendation', {
      p_recommendation_id: UUID,
      p_reason: 'not relevant',
    });
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_dismiss_recommendation({ recommendation: UUID }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// explain_recommendation
// ---------------------------------------------------------------------------

describe('explain_recommendation', () => {
  it('narrates why: summary, pillars, impact vs effort, source', async () => {
    const { sb } = makeSb({ autopilot_recommendations: [{ data: REC, error: null }] });
    const res = await tool_explain_recommendation({ recommendation: UUID }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Implement Sleep Quality Tracking');
      expect(res.text).toContain('sleep');
      expect(res.text).toContain('9/10');
      expect(res.text).toContain('3/10');
      const r = res.result as { contribution_vector: Record<string, number> };
      expect(r.contribution_vector.sleep).toBe(0.7);
    }
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_explain_recommendation({ recommendation: UUID }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// update_intent
// ---------------------------------------------------------------------------

const INTENT = {
  intent_id: UUID,
  intent_kind: 'activity_seek',
  category: 'sport.tennis',
  title: 'Tennis partner in Berlin',
  scope: 'Weekly tennis, intermediate level',
  status: 'open',
  created_at: '2026-07-01T00:00:00Z',
};

describe('update_intent', () => {
  it('updates the resolved intent and confirms the change', async () => {
    const { sb, log } = makeSb({
      user_intents: [
        { data: INTENT, error: null }, // resolve by uuid (maybeSingle)
        { data: { intent_id: UUID, title: 'Tennis partner in Berlin', scope: 'Weekends only, intermediate level', category: 'sport.tennis' }, error: null }, // update
      ],
    });
    const res = await tool_update_intent(
      { intent: UUID, new_text: 'Weekends only, intermediate level' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('Weekends only');
    const upd = log.find((l) => l.table === 'user_intents' && l.method === 'update');
    expect(upd).toBeDefined();
    expect(upd!.args[0]).toEqual({ scope: 'Weekends only, intermediate level' });
  });

  it('refuses when no field changes were given', async () => {
    const { sb } = makeSb({});
    const res = await tool_update_intent({ intent: UUID }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('new_title');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_update_intent({ intent: UUID, new_title: 'x' }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// delete_intent
// ---------------------------------------------------------------------------

describe('delete_intent', () => {
  it('asks for confirmation first (no write)', async () => {
    const { sb, log } = makeSb({ user_intents: [{ data: INTENT, error: null }] });
    const res = await tool_delete_intent({ intent: UUID }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Tennis partner in Berlin');
      expect((res.result as { stage: string }).stage).toBe('awaiting_confirmation');
    }
    expect(log.find((l) => l.method === 'update')).toBeUndefined();
  });

  it('closes the intent after confirm=true (status=closed, owner-scoped)', async () => {
    const { sb, log } = makeSb({
      user_intents: [
        { data: INTENT, error: null },
        { data: { intent_id: UUID }, error: null },
      ],
    });
    const res = await tool_delete_intent({ intent: UUID, confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('taken down');
    const upd = log.find((l) => l.table === 'user_intents' && l.method === 'update');
    expect(upd!.args[0]).toEqual({ status: 'closed' });
    // Owner scoping: an .eq('requester_user_id', 'u-1') is applied after update.
    const eqCalls = log.filter((l) => l.method === 'eq').map((l) => l.args);
    expect(eqCalls).toEqual(expect.arrayContaining([['requester_user_id', 'u-1']]));
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_delete_intent({ intent: UUID }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// browse_intent_board
// ---------------------------------------------------------------------------

describe('browse_intent_board', () => {
  it('speaks open asks with titles and kind labels', async () => {
    const { sb } = makeSb({
      user_intents: [{
        data: [
          { intent_id: 'i-1', intent_kind: 'commercial_buy', category: 'gear.bike', title: 'Looking for a used e-bike', scope: 'Budget 800', created_at: new Date().toISOString() },
          { intent_id: 'i-2', intent_kind: 'activity_seek', category: 'sport.running', title: 'Morning running buddy', scope: '5k pace', created_at: new Date().toISOString() },
        ],
        error: null,
      }],
    });
    const res = await tool_browse_intent_board({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Looking for a used e-bike');
      expect(res.text).toContain('looking to buy');
      expect(res.text).toContain('Morning running buddy');
      expect(res.text).toContain('activity partner wanted');
    }
  });

  it('answers plainly when the board is empty', async () => {
    const { sb } = makeSb({ user_intents: [{ data: [], error: null }] });
    const res = await tool_browse_intent_board({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('no open asks');
  });

  it('requires an authenticated user with tenant', async () => {
    const { sb } = makeSb({});
    const res = await tool_browse_intent_board({}, ANON, sb);
    expect(res.ok).toBe(false);
    const noTenant = await tool_browse_intent_board({}, { ...IDENT, tenant_id: null }, sb);
    expect(noTenant.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispute_match
// ---------------------------------------------------------------------------

describe('dispute_match', () => {
  it('collects the reason before anything else', async () => {
    const { sb } = makeSb({});
    const res = await tool_dispute_match({ match_id: 'm-1' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { stage: string }).stage).toBe('needs_reason');
      expect(res.text).toContain('what went wrong');
    }
    expect(raiseDispute).not.toHaveBeenCalled();
  });

  it('reads the dispute back before filing (no write without confirm)', async () => {
    const { sb } = makeSb({});
    const res = await tool_dispute_match(
      { match_id: 'm-1', reason: 'The seller never showed up', reason_category: 'no_show' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { stage: string }).stage).toBe('awaiting_confirmation');
      expect(res.text).toContain('never showed up');
    }
    expect(raiseDispute).not.toHaveBeenCalled();
  });

  it('files via raiseDispute after confirm=true', async () => {
    (raiseDispute as jest.Mock).mockResolvedValue({ dispute_id: 'd-1', status: 'open' });
    const { sb } = makeSb({});
    const res = await tool_dispute_match(
      { match_id: 'm-1', reason: 'No-show at the court', reason_category: 'no_show', confirm: true },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('filed');
      expect((res.result as { dispute_id: string }).dispute_id).toBe('d-1');
    }
    expect(raiseDispute).toHaveBeenCalledWith({
      match_id: 'm-1',
      raised_by: 'u-1',
      reason_category: 'no_show',
      reason_detail: 'No-show at the court',
      vitana_id_hint: '@dragan',
    });
  });

  it('auto-detects the match when the user has exactly one', async () => {
    (raiseDispute as jest.Mock).mockResolvedValue({ dispute_id: 'd-2', status: 'open' });
    const { sb } = makeSb({
      user_intents: [{ data: [{ intent_id: 'i-1' }], error: null }],
      intent_matches: [{ data: [{ match_id: 'm-only', intent_a_id: 'i-1', intent_b_id: 'i-9', state: 'surfaced', created_at: new Date().toISOString() }], error: null }],
    });
    const res = await tool_dispute_match({ reason: 'misrepresented offer', confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((raiseDispute as jest.Mock).mock.calls[0][0].match_id).toBe('m-only');
  });

  it('disambiguates when the user has several matches', async () => {
    const { sb } = makeSb({
      user_intents: [{ data: [{ intent_id: 'i-1' }], error: null }],
      intent_matches: [{
        data: [
          { match_id: 'm-1', intent_a_id: 'i-1', intent_b_id: 'i-8', state: 'surfaced', created_at: new Date().toISOString() },
          { match_id: 'm-2', intent_a_id: 'i-1', intent_b_id: 'i-9', state: 'mutual_interest', created_at: new Date().toISOString() },
        ],
        error: null,
      }],
    });
    const res = await tool_dispute_match({ reason: 'issue' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { ambiguous: boolean }).ambiguous).toBe(true);
      expect(res.text).toContain('several matches');
    }
    expect(raiseDispute).not.toHaveBeenCalled();
  });

  it('maps not_a_party to a clear error', async () => {
    (raiseDispute as jest.Mock).mockRejectedValue(new Error('not_a_party'));
    const { sb } = makeSb({});
    const res = await tool_dispute_match(
      { match_id: 'm-1', reason: 'x', confirm: true },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('not a participant');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_dispute_match({ match_id: 'm-1', reason: 'x' }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// find_perfect_match
// ---------------------------------------------------------------------------

describe('find_perfect_match', () => {
  const compassQueues = () => ({
    life_compass: [{ data: { primary_goal: 'Run a marathon at 60', category: 'longevity' }, error: null }],
    vitana_index_scores: [{ data: { pillars: { exercise: 40, sleep: 85, nutrition: 70 } }, error: null }],
  });

  it('fuses the ask with Life Compass goal + weakest pillar and reuses the find-match engine', async () => {
    (runFindMatch as jest.Mock).mockResolvedValue({
      ok: true,
      stage: 'matched',
      text: 'MATCHES FOUND — recommend Kemal for tennis.',
      data: { matches: [{ match_id: 'm-1', score: 0.91 }] },
    });
    const { sb } = makeSb(compassQueues());
    const res = await tool_find_perfect_match({ ask: 'a workout partner for mornings' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Run a marathon at 60');
      expect(res.text).toContain('exercise');
      expect(res.text).toContain('MATCHES FOUND');
      const r = res.result as { weakest_pillar: string; compass_goal: string; stage: string };
      expect(r.weakest_pillar).toBe('exercise');
      expect(r.compass_goal).toBe('Run a marathon at 60');
      expect(r.stage).toBe('matched');
    }
    expect(runFindMatch).toHaveBeenCalledWith(
      expect.objectContaining({ utterance: 'a workout partner for mornings' }),
      expect.objectContaining({ user_id: 'u-1', tenant_id: 't-1' }),
    );
  });

  it('derives a default ask from the weakest pillar when the user is vague', async () => {
    (runFindMatch as jest.Mock).mockResolvedValue({
      ok: true,
      stage: 'awaiting_confirmation',
      text: 'Read back the summary and confirm.',
      data: {},
    });
    const { sb } = makeSb(compassQueues());
    const res = await tool_find_perfect_match({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((runFindMatch as jest.Mock).mock.calls[0][0].utterance).toContain('workout partner');
    if (res.ok) {
      expect((res.result as { ask_derived_from_pillar: boolean }).ask_derived_from_pillar).toBe(true);
    }
  });

  it('asks what the user wants when there is no ask and no pillar data', async () => {
    const { sb } = makeSb({
      life_compass: [{ data: null, error: null }],
      vitana_index_scores: [{ data: null, error: null }],
    });
    const res = await tool_find_perfect_match({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { stage: string }).stage).toBe('needs_ask');
      expect(res.text).toContain('what kind of person');
    }
    expect(runFindMatch).not.toHaveBeenCalled();
  });

  it('propagates engine failures as ok:false', async () => {
    (runFindMatch as jest.Mock).mockResolvedValue({ ok: false, stage: 'incomplete', text: '', data: {}, error: 'insert_failed' });
    const { sb } = makeSb(compassQueues());
    const res = await tool_find_perfect_match({ ask: 'a mentor' }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('insert_failed');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb({});
    const res = await tool_find_perfect_match({ ask: 'a mentor' }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});
