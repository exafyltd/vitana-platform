/**
 * Community Groups (VTID-02764) + Events/RSVP (VTID-02774) voice tools — unit tests.
 *
 * The handlers talk straight to the live schemas (global_community_groups /
 * global_community_group_members / community_group_invitations /
 * global_community_events / global_event_participants / live_rooms), so the
 * SupabaseClient is mocked with chainable per-table result queues — no
 * network, no real DB. Covered per tool: happy path (ok:true + speakable
 * text containing the actual names/titles), the unauthenticated gate, and
 * the confirm-first flow for destructive actions.
 */

jest.mock('../../src/services/automation-executor', () => ({
  dispatchEvent: jest.fn().mockResolvedValue({ dispatched: [], errors: [] }),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchEvent } from '../../src/services/automation-executor';
import {
  GROUPS_EVENTS_TOOL_HANDLERS,
  GROUPS_EVENTS_TOOL_DECLARATIONS,
  tool_list_my_groups,
  tool_create_group,
  tool_join_group,
  tool_invite_to_group,
  tool_accept_invitation,
  tool_decline_invitation,
  tool_rsvp_event,
  tool_cancel_rsvp,
  tool_list_upcoming_meetups,
  tool_join_live_room,
} from '../../src/services/orb-tools/groups-events-tools';

const IDENT = { user_id: 'a27552a3-0257-4305-8ed0-351a80fd3701', tenant_id: 't-1', role: 'community' };
const ANON = { user_id: '', tenant_id: null, role: null };

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const E1 = '33333333-3333-4333-8333-333333333333';
const U2 = '44444444-4444-4444-8444-444444444444';
const INV1 = '55555555-5555-4555-8555-555555555555';
const R1 = '66666666-6666-4666-8666-666666666666';

interface MockResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

/** Chainable query builder that resolves (await / maybeSingle / single) to one result. */
function makeBuilder(result: MockResult) {
  const resolved = { data: result.data ?? null, error: result.error ?? null };
  const b: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'neq', 'in', 'gte', 'lte', 'ilike', 'or', 'order', 'limit',
    'update', 'insert', 'upsert', 'delete',
  ]) {
    b[m] = jest.fn(() => b);
  }
  b.maybeSingle = jest.fn(async () => resolved);
  b.single = jest.fn(async () => resolved);
  b.then = (onFulfilled: (v: MockResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled, onRejected);
  return b;
}

/**
 * SupabaseClient mock: each from(table) call consumes the next queued result
 * for that table (the last entry repeats when the queue runs out).
 */
function makeSb(tableResults: Record<string, MockResult[]> = {}, rpcResult: MockResult = { data: [] }) {
  const counters: Record<string, number> = {};
  const from = jest.fn((table: string) => {
    const queue = tableResults[table] ?? [{ data: null, error: null }];
    const i = counters[table] ?? 0;
    counters[table] = i + 1;
    return makeBuilder(queue[Math.min(i, queue.length - 1)]);
  });
  const rpc = jest.fn(async () => ({ data: rpcResult.data ?? null, error: rpcResult.error ?? null }));
  const sb = { from, rpc } as unknown as SupabaseClient;
  return { sb, from, rpc };
}

const futureIso = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const walkersGroup = { id: G1, name: 'Morning Walkers', description: 'Daily walks', member_count: 12, is_public: true };
const sleepGroup = { id: G2, name: 'Sleep Better', description: null, member_count: 3, is_public: true };
const yogaEvent = {
  id: E1,
  title: 'Sunrise Yoga',
  start_time: futureIso(3),
  location: 'Berlin Park',
  participant_count: 4,
  max_participants: 20,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Exports / registry shape
// ---------------------------------------------------------------------------

describe('groups+events tools — exports', () => {
  const NAMES = [
    'list_my_groups',
    'create_group',
    'join_group',
    'invite_to_group',
    'accept_invitation',
    'decline_invitation',
    'rsvp_event',
    'cancel_rsvp',
    'list_upcoming_meetups',
    'join_live_room',
  ];

  it.each(NAMES)('%s is in GROUPS_EVENTS_TOOL_HANDLERS', (name) => {
    expect(typeof GROUPS_EVENTS_TOOL_HANDLERS[name]).toBe('function');
  });

  it.each(NAMES)('%s is declared in GROUPS_EVENTS_TOOL_DECLARATIONS', (name) => {
    expect(GROUPS_EVENTS_TOOL_DECLARATIONS.find((d) => d.name === name)).toBeDefined();
  });

  it('declarations use only the Vertex-safe OpenAPI subset (no default/minimum/maximum/format/examples)', () => {
    const raw = JSON.stringify(GROUPS_EVENTS_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
      expect(raw).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// list_my_groups
// ---------------------------------------------------------------------------

describe('list_my_groups', () => {
  it('speaks group names with member counts', async () => {
    const { sb } = makeSb({
      global_community_group_members: [
        { data: [{ group_id: G1, role: 'member', joined_at: '2026-01-01T00:00:00Z' }] },
      ],
      global_community_groups: [
        { data: [walkersGroup] }, // membership details
        { data: [] }, // created-by groups
      ],
    });
    const res = await tool_list_my_groups({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Morning Walkers');
      expect(res.text).toContain('12 members');
      expect((res.result as { groups: unknown[] }).groups).toHaveLength(1);
    }
  });

  it('merges groups the user created (as admin) even without a membership row', async () => {
    const { sb } = makeSb({
      global_community_group_members: [{ data: [] }],
      global_community_groups: [{ data: [sleepGroup] }],
    });
    const res = await tool_list_my_groups({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Sleep Better');
      expect(res.text).toContain("you're an admin");
    }
  });

  it('empty state stays ok:true with an honest line', async () => {
    const { sb } = makeSb({
      global_community_group_members: [{ data: [] }],
      global_community_groups: [{ data: [] }],
    });
    const res = await tool_list_my_groups({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/not in any community groups yet/i);
  });

  it('requires an authenticated user', async () => {
    const { sb, from } = makeSb();
    const res = await tool_list_my_groups({}, ANON, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
    expect(from).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// create_group
// ---------------------------------------------------------------------------

describe('create_group', () => {
  it('asks for confirmation before creating', async () => {
    const { sb, from } = makeSb();
    const res = await tool_create_group({ name: 'Trail Runners', privacy: 'private' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { needs_confirmation: boolean }).needs_confirmation).toBe(true);
      expect(res.text).toContain('Trail Runners');
      expect(res.text).toContain('private');
      expect(res.text).toContain('confirm:true');
    }
    expect(from).not.toHaveBeenCalled();
  });

  it('creates the group on confirm and returns a navigate directive', async () => {
    const { sb } = makeSb({
      global_community_groups: [{ data: { id: G1, name: 'Trail Runners' } }],
      global_community_group_members: [{ data: null }, { data: null }],
    });
    const res = await tool_create_group({ name: 'Trail Runners', confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Trail Runners');
      expect(res.text).toContain('admin');
      const result = res.result as { directive: { route: string; screen_id: string }; redirect: { route: string } };
      expect(result.directive.screen_id).toBe('COMM.GROUP_DETAIL');
      expect(result.redirect.route).toBe(`/comm/groups/${G1}`);
    }
  });

  it('requires a name', async () => {
    const { sb } = makeSb();
    const res = await tool_create_group({ confirm: true }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('name');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_create_group({ name: 'X', confirm: true }, ANON, sb);
    expect(res.ok).toBe(false);
  });

  it('surfaces the insert error as ok:false', async () => {
    const { sb } = makeSb({
      global_community_groups: [{ data: null, error: { message: 'insert denied' } }],
    });
    const res = await tool_create_group({ name: 'X', confirm: true }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('insert denied');
  });
});

// ---------------------------------------------------------------------------
// join_group
// ---------------------------------------------------------------------------

describe('join_group', () => {
  it('joins a fuzzy-matched public group and navigates to it', async () => {
    const { sb } = makeSb({
      global_community_groups: [{ data: [walkersGroup] }],
      global_community_group_members: [{ data: null }, { data: null }],
    });
    const res = await tool_join_group({ query: 'walkers' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Morning Walkers');
      const result = res.result as { joined: boolean; redirect: { route: string } };
      expect(result.joined).toBe(true);
      expect(result.redirect.route).toBe(`/comm/groups/${G1}`);
    }
    // Welcome Squad automation is dispatched with the joiner's user_id.
    expect(dispatchEvent).toHaveBeenCalledWith('t-1', 'community.member.joined', {
      group_id: G1,
      user_id: IDENT.user_id,
    });
  });

  it('already a member — says so without re-joining', async () => {
    const { sb } = makeSb({
      global_community_groups: [{ data: [walkersGroup] }],
      global_community_group_members: [{ data: { id: 'm-1' } }],
    });
    const res = await tool_join_group({ query: 'walkers' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toMatch(/already a member/i);
      expect((res.result as { already_member: boolean }).already_member).toBe(true);
    }
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('private groups cannot be self-joined', async () => {
    const { sb } = makeSb({
      global_community_groups: [{ data: [{ ...walkersGroup, is_public: false }] }],
    });
    const res = await tool_join_group({ query: 'walkers' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/private group/i);
  });

  it('several matches — lists candidates and asks which', async () => {
    const { sb } = makeSb({
      global_community_groups: [{ data: [walkersGroup, sleepGroup] }],
    });
    const res = await tool_join_group({ query: 'group' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Morning Walkers');
      expect(res.text).toContain('Sleep Better');
      expect(res.text).toMatch(/which one/i);
    }
  });

  it('no match — honest ok:true answer', async () => {
    const { sb } = makeSb({ global_community_groups: [{ data: [] }] });
    const res = await tool_join_group({ query: 'chess' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('chess');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_join_group({ query: 'walkers' }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invite_to_group
// ---------------------------------------------------------------------------

describe('invite_to_group', () => {
  // global_community_group_members is queried TWICE: first to verify the
  // CALLER is a member (security gate — see the dedicated test below), then
  // to check whether the INVITEE is already a member. The first entry in
  // the queue below is always the caller-membership check.
  it('resolves member by name via the canonical resolver RPC and sends the invitation', async () => {
    const { sb, rpc } = makeSb(
      {
        global_community_groups: [{ data: [walkersGroup] }],
        global_community_group_members: [{ data: { id: 'm-caller' } }, { data: null }],
        community_group_invitations: [{ data: null }],
      },
      { data: [{ user_id: U2, vitana_id: '@anna', display_name: 'Anna Schmidt', score: 0.95 }] },
    );
    const res = await tool_invite_to_group({ group: 'walkers', member_name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Anna Schmidt');
      expect(res.text).toContain('Morning Walkers');
      expect((res.result as { invited: boolean }).invited).toBe(true);
    }
    expect(rpc).toHaveBeenCalledWith('resolve_recipient_candidates', {
      p_actor: IDENT.user_id,
      p_token: 'Anna',
      p_limit: 3,
      p_global: true,
    });
  });

  it('caller is NOT a member of the group — refuses to invite (security)', async () => {
    const { sb } = makeSb(
      {
        global_community_groups: [{ data: [walkersGroup] }],
        global_community_group_members: [{ data: null }],
      },
      { data: [{ user_id: U2, vitana_id: '@anna', display_name: 'Anna Schmidt', score: 0.95 }] },
    );
    const res = await tool_invite_to_group({ group: 'walkers', member_name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/must be a member/i);
  });

  it('ambiguous member resolution asks which one', async () => {
    const { sb } = makeSb(
      {
        global_community_groups: [{ data: [walkersGroup] }],
        global_community_group_members: [{ data: { id: 'm-caller' } }],
      },
      {
        data: [
          { user_id: U2, vitana_id: '@anna1', display_name: 'Anna Schmidt', score: 0.9 },
          { user_id: G2, vitana_id: '@anna2', display_name: 'Anna Bauer', score: 0.88 },
        ],
      },
    );
    const res = await tool_invite_to_group({ group: 'walkers', member_name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Anna Schmidt');
      expect(res.text).toContain('Anna Bauer');
      expect((res.result as { invited: boolean }).invited).toBe(false);
    }
  });

  it('invitee already a member — says so instead of inviting', async () => {
    const { sb } = makeSb(
      {
        global_community_groups: [{ data: [walkersGroup] }],
        global_community_group_members: [{ data: { id: 'm-caller' } }, { data: { id: 'm-2' } }],
      },
      { data: [{ user_id: U2, vitana_id: '@anna', display_name: 'Anna Schmidt', score: 0.95 }] },
    );
    const res = await tool_invite_to_group({ group: 'walkers', member_name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/already a member/i);
  });

  it('duplicate pending invitation (unique violation) stays ok:true', async () => {
    const { sb } = makeSb(
      {
        global_community_groups: [{ data: [walkersGroup] }],
        global_community_group_members: [{ data: { id: 'm-caller' } }, { data: null }],
        community_group_invitations: [{ data: null, error: { message: 'dup', code: '23505' } }],
      },
      { data: [{ user_id: U2, vitana_id: '@anna', display_name: 'Anna Schmidt', score: 0.95 }] },
    );
    const res = await tool_invite_to_group({ group: 'walkers', member_name: 'Anna' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/pending invitation/i);
  });

  it('requires the member name', async () => {
    const { sb } = makeSb();
    const res = await tool_invite_to_group({ group: 'walkers' }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('name');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_invite_to_group({ group: 'walkers', member_name: 'Anna' }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// accept_invitation / decline_invitation
// ---------------------------------------------------------------------------

const pendingInvitation = {
  id: INV1,
  group_id: G1,
  invited_by: U2,
  message: null,
  created_at: '2026-07-01T00:00:00Z',
};

describe('accept_invitation', () => {
  it('accepts the single pending invitation and joins the group', async () => {
    const { sb } = makeSb({
      community_group_invitations: [{ data: [pendingInvitation] }, { data: null }],
      global_community_groups: [{ data: [{ id: G1, name: 'Morning Walkers' }] }],
      global_community_group_members: [{ data: null }, { data: null }],
    });
    const res = await tool_accept_invitation({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Morning Walkers');
      const result = res.result as { accepted: boolean; redirect: { route: string } };
      expect(result.accepted).toBe(true);
      expect(result.redirect.route).toBe(`/comm/groups/${G1}`);
    }
  });

  it('no pending invitations — honest ok:true answer', async () => {
    const { sb } = makeSb({ community_group_invitations: [{ data: [] }] });
    const res = await tool_accept_invitation({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/don't have any pending/i);
  });

  it('several pending and no id — lists them and asks', async () => {
    const inv2 = { ...pendingInvitation, id: G2, group_id: G2 };
    const { sb } = makeSb({
      community_group_invitations: [{ data: [pendingInvitation, inv2] }],
      global_community_groups: [
        { data: [{ id: G1, name: 'Morning Walkers' }, { id: G2, name: 'Sleep Better' }] },
      ],
    });
    const res = await tool_accept_invitation({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Morning Walkers');
      expect(res.text).toContain('Sleep Better');
      expect(res.text).toMatch(/which one/i);
    }
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_accept_invitation({}, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

describe('decline_invitation', () => {
  it('asks for confirmation first', async () => {
    const { sb } = makeSb({
      community_group_invitations: [{ data: [pendingInvitation] }],
      global_community_groups: [{ data: [{ id: G1, name: 'Morning Walkers' }] }],
    });
    const res = await tool_decline_invitation({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { needs_confirmation: boolean }).needs_confirmation).toBe(true);
      expect(res.text).toContain('Morning Walkers');
      expect(res.text).toContain('confirm:true');
    }
  });

  it('declines on confirm', async () => {
    const { sb } = makeSb({
      community_group_invitations: [{ data: [pendingInvitation] }, { data: null }],
      global_community_groups: [{ data: [{ id: G1, name: 'Morning Walkers' }] }],
    });
    const res = await tool_decline_invitation({ invitation_id: INV1, confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toMatch(/declined/i);
      expect(res.text).toContain('Morning Walkers');
      expect((res.result as { declined: boolean }).declined).toBe(true);
    }
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_decline_invitation({}, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rsvp_event
// ---------------------------------------------------------------------------

describe('rsvp_event', () => {
  it('signs the user up for a fuzzy-matched upcoming event', async () => {
    const { sb, from } = makeSb({
      global_community_events: [{ data: [yogaEvent] }, { data: null }],
      global_event_participants: [{ data: null }, { data: null }],
    });
    const res = await tool_rsvp_event({ query: 'yoga' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Sunrise Yoga');
      expect(res.text).toContain('Berlin Park');
      expect((res.result as { rsvped: boolean }).rsvped).toBe(true);
    }
    // participant row upsert + participant_count sync both happened
    expect(from).toHaveBeenCalledWith('global_event_participants');
    expect(from).toHaveBeenCalledWith('global_community_events');
  });

  it('already attending — says so without double-booking', async () => {
    const { sb } = makeSb({
      global_community_events: [{ data: [yogaEvent] }],
      global_event_participants: [{ data: { id: 'p-1', status: 'attending' } }],
    });
    const res = await tool_rsvp_event({ query: 'yoga' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toMatch(/already signed up/i);
      expect((res.result as { already_attending: boolean }).already_attending).toBe(true);
    }
  });

  it('full event — refuses with capacity info', async () => {
    const fullEvent = { ...yogaEvent, participant_count: 20, max_participants: 20 };
    const { sb } = makeSb({
      global_community_events: [{ data: [fullEvent] }],
      global_event_participants: [{ data: null }],
    });
    const res = await tool_rsvp_event({ query: 'yoga' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toMatch(/full/i);
      expect((res.result as { full: boolean }).full).toBe(true);
    }
  });

  it('several matches — lists candidates', async () => {
    const other = { ...yogaEvent, id: G2, title: 'Evening Yoga' };
    const { sb } = makeSb({ global_community_events: [{ data: [yogaEvent, other] }] });
    const res = await tool_rsvp_event({ query: 'yoga' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Sunrise Yoga');
      expect(res.text).toContain('Evening Yoga');
    }
  });

  it('no match — honest ok:true answer', async () => {
    const { sb } = makeSb({ global_community_events: [{ data: [] }] });
    const res = await tool_rsvp_event({ query: 'opera' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('opera');
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_rsvp_event({ query: 'yoga' }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cancel_rsvp
// ---------------------------------------------------------------------------

describe('cancel_rsvp', () => {
  it('asks for confirmation before cancelling', async () => {
    const { sb } = makeSb({
      global_event_participants: [{ data: [{ event_id: E1 }] }],
      global_community_events: [{ data: [yogaEvent] }],
    });
    const res = await tool_cancel_rsvp({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { needs_confirmation: boolean }).needs_confirmation).toBe(true);
      expect(res.text).toContain('Sunrise Yoga');
      expect(res.text).toContain('confirm:true');
    }
  });

  it('cancels on confirm and speaks the event title', async () => {
    const { sb } = makeSb({
      global_event_participants: [{ data: [{ event_id: E1 }] }, { data: null }],
      global_community_events: [{ data: [yogaEvent] }, { data: null }],
    });
    const res = await tool_cancel_rsvp({ event_id: E1, confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toMatch(/cancelled/i);
      expect(res.text).toContain('Sunrise Yoga');
      expect((res.result as { cancelled: boolean }).cancelled).toBe(true);
    }
  });

  it('no RSVPs at all — honest ok:true answer', async () => {
    const { sb } = makeSb({ global_event_participants: [{ data: [] }] });
    const res = await tool_cancel_rsvp({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/don't have any event RSVPs/i);
  });

  it('several upcoming RSVPs and no query — lists them and asks which', async () => {
    const other = { ...yogaEvent, id: G2, title: 'Evening Run' };
    const { sb } = makeSb({
      global_event_participants: [{ data: [{ event_id: E1 }, { event_id: G2 }] }],
      global_community_events: [{ data: [yogaEvent, other] }],
    });
    const res = await tool_cancel_rsvp({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Sunrise Yoga');
      expect(res.text).toContain('Evening Run');
      expect(res.text).toMatch(/which/i);
    }
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_cancel_rsvp({ confirm: true }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list_upcoming_meetups
// ---------------------------------------------------------------------------

describe('list_upcoming_meetups', () => {
  it('lists titles with dates, near-you flag and attending marker', async () => {
    const remote = { ...yogaEvent, id: G2, title: 'Online Breathwork', location: 'Online' };
    const { sb } = makeSb({
      global_community_events: [{ data: [remote, yogaEvent] }],
      location_preferences: [{ data: { home_city: 'Berlin' } }],
      global_event_participants: [{ data: [{ event_id: G2 }] }],
    });
    const res = await tool_list_upcoming_meetups({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Sunrise Yoga');
      expect(res.text).toContain('Online Breathwork');
      expect(res.text).toContain('(near you)');
      expect(res.text).toContain("you're signed up");
      // Near-user event is ordered first.
      const events = (res.result as { events: Array<{ title: string; near_user: boolean }> }).events;
      expect(events[0].title).toBe('Sunrise Yoga');
      expect(events[0].near_user).toBe(true);
    }
  });

  it('empty state stays ok:true with an honest line', async () => {
    const { sb } = makeSb({ global_community_events: [{ data: [] }] });
    const res = await tool_list_upcoming_meetups({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/no upcoming meetups/i);
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_list_upcoming_meetups({}, ANON, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// join_live_room
// ---------------------------------------------------------------------------

describe('join_live_room', () => {
  const liveRoom = { id: R1, title: 'Longevity Q&A', starts_at: futureIso(0), status: 'live' };

  it('resolves a single room and returns the navigate directive to the viewer screen', async () => {
    const { sb } = makeSb({ live_rooms: [{ data: [liveRoom] }] });
    const res = await tool_join_live_room({ query: 'longevity' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Longevity Q&A');
      expect(res.text).toMatch(/live right now/i);
      const result = res.result as {
        decision: string;
        directive: { screen_id: string; route: string; directive: string };
        redirect: { route: string };
      };
      expect(result.decision).toBe('auto_nav');
      expect(result.directive.directive).toBe('navigate');
      expect(result.directive.screen_id).toBe('COMM.LIVE_ROOM_VIEWER');
      expect(result.redirect.route).toBe(`/comm/live-rooms/${R1}/view`);
    }
  });

  it('several rooms without an exact match — lists candidates', async () => {
    const scheduled = { id: G2, title: 'Sleep Talk', starts_at: futureIso(1), status: 'scheduled' };
    const { sb } = makeSb({ live_rooms: [{ data: [liveRoom, scheduled] }] });
    const res = await tool_join_live_room({ query: 'room' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Longevity Q&A');
      expect(res.text).toContain('Sleep Talk');
      expect((res.result as { decision: string }).decision).toBe('list_only');
    }
  });

  it('with no query, the single live-now room wins over scheduled ones', async () => {
    const scheduled = { id: G2, title: 'Sleep Talk', starts_at: futureIso(1), status: 'scheduled' };
    const { sb } = makeSb({ live_rooms: [{ data: [liveRoom, scheduled] }] });
    const res = await tool_join_live_room({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { room_id: string }).room_id).toBe(R1);
      expect(res.text).toContain('Longevity Q&A');
    }
  });

  it('no rooms — honest ok:true answer', async () => {
    const { sb } = makeSb({ live_rooms: [{ data: [] }] });
    const res = await tool_join_live_room({ query: 'zzz' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('zzz');
  });

  it('missing tenant context stays ok:true with an unavailable line', async () => {
    const { sb, from } = makeSb();
    const res = await tool_join_live_room({ query: 'x' }, { ...IDENT, tenant_id: null }, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/unavailable/i);
    expect(from).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const { sb } = makeSb();
    const res = await tool_join_live_room({ query: 'x' }, ANON, sb);
    expect(res.ok).toBe(false);
  });
});
