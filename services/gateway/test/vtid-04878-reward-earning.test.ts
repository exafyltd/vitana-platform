/**
 * VTID-04878 — VTNA earning actually pays.
 *
 * Covers: the milestone row the table accepts (no tenant_id, CHECK-valid
 * values), credit_wallet business failures counted, quiet backfill emits no
 * celebration, a scan catches up several tiers at once, onboarding pays at
 * signup, first_event_rsvp reads global_event_participants, the capped claim
 * takes amount/cap/window from the rule table, the sweep refuses off
 * production before any query, the route's auth + staging gate, and the
 * Autopilot completion payout (owner decision 2026-10-05).
 */

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role';

jest.mock('../src/services/milestone-service-repository', () => ({
  fetchAchievedMilestoneRefs: jest.fn(),
  insertAchievedMilestone: jest.fn(),
  fetchAppUserForProfileCheck: jest.fn(),
  countUserTopicProfileRows: jest.fn(),
  countDiaryMemoryItems: jest.fn(),
  countConnectedRelationshipEdges: jest.fn(),
  countGroupRelationshipEdges: jest.fn(),
  countRsvpMeetupAttendance: jest.fn(),
  countPrimaryMemberships: jest.fn(),
  countAcceptedDailyMatches: jest.fn(),
  fetchRecentDiaryEntryDates: jest.fn(),
  countVitanaIndexScoreRows: jest.fn(),
  countSuccessfulReferrals: jest.fn(),
  creditWalletForMilestone: jest.fn(),
}));

import * as msRepo from '../src/services/milestone-service-repository';
import { scanUserMilestonesDetailed, checkMilestonesForAction } from '../src/services/milestone-service';
import { claimCappedReward } from '../src/services/rewards/capped-reward';
import {
  VTNA_REWARD_RULES, capRewardKey, capWindowStart, cappedRules, getRewardRule,
} from '../src/services/rewards/vtna-reward-rules';
import { buildRewardOverview, ruleIdForKey } from '../src/services/rewards/reward-overview-service';
import {
  rewardSweepAllowed, rewardSweepLoopAllowed, runRewardSweep,
} from '../src/services/rewards/reward-sweep';

const m = msRepo as jest.Mocked<typeof msRepo>;
const U = '11111111-1111-1111-1111-111111111111';
const T = 'aaaaaaaa-0000-0000-0000-000000000000';
const sb = {} as any;

function nothingAchieved() {
  m.fetchAchievedMilestoneRefs.mockResolvedValue({ data: [], error: null } as any);
  m.insertAchievedMilestone.mockResolvedValue({ error: null } as any);
  m.fetchAppUserForProfileCheck.mockResolvedValue({ data: null } as any);
  m.countUserTopicProfileRows.mockResolvedValue({ count: 0, error: null } as any);
  m.countDiaryMemoryItems.mockResolvedValue({ count: 0 } as any);
  m.countConnectedRelationshipEdges.mockResolvedValue({ count: 0 } as any);
  m.countGroupRelationshipEdges.mockResolvedValue({ count: 0 } as any);
  m.countRsvpMeetupAttendance.mockResolvedValue({ count: 0 } as any);
  m.countPrimaryMemberships.mockResolvedValue({ count: 0 } as any);
  m.countAcceptedDailyMatches.mockResolvedValue({ count: 0 } as any);
  m.fetchRecentDiaryEntryDates.mockResolvedValue({ data: [] } as any);
  m.countVitanaIndexScoreRows.mockResolvedValue({ count: 0 } as any);
  m.countSuccessfulReferrals.mockResolvedValue({ count: 0 } as any);
  m.creditWalletForMilestone.mockResolvedValue({ data: { ok: true, transaction_id: 'tx' }, error: null } as any);
}

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  nothingAchieved();
  fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: true } as any);
});
afterEach(() => fetchSpy.mockRestore());

const milestoneEvents = () =>
  fetchSpy.mock.calls.filter(([url, init]) => String(url).endsWith('/rest/v1/oasis_events')
    && String((init as any)?.body ?? '').includes('user.milestone.reached'));

describe('milestone recording (VTID-04878 root cause)', () => {
  test('the row has no tenant_id and satisfies the table CHECKs', async () => {
    m.countPrimaryMemberships.mockResolvedValue({ count: 1 } as any);
    await scanUserMilestonesDetailed(sb, U, T);
    const row = m.insertAchievedMilestone.mock.calls[0][1] as Record<string, unknown>;
    expect(row).not.toHaveProperty('tenant_id');
    // VTID-04931: exactly the live columns the row may use; any other key
    // (tenant_id, metadata, …) makes PostgREST reject the whole insert.
    expect(Object.keys(row).sort()).toEqual([
      'activated_at', 'completed_at', 'domain', 'effort_score', 'impact_score', 'risk_level',
      'source_ref', 'source_type', 'status', 'summary', 'title', 'user_id',
    ]);
    expect(['low', 'medium', 'high', 'critical']).toContain(row.risk_level);
    for (const k of ['impact_score', 'effort_score'] as const) {
      expect(row[k]).toBeGreaterThanOrEqual(1);
      expect(row[k]).toBeLessThanOrEqual(10);
    }
    expect(row).toMatchObject({ user_id: U, source_type: 'milestone', source_ref: 'onboarding_complete', status: 'completed' });
  });

  test('onboarding_complete pays 50 at signup with the key AP-1301 also uses', async () => {
    m.countPrimaryMemberships.mockResolvedValue({ count: 1 } as any);
    const r = await scanUserMilestonesDetailed(sb, U, T);
    expect(r.milestones).toEqual(['onboarding_complete']);
    expect(m.creditWalletForMilestone).toHaveBeenCalledWith(sb, expect.objectContaining({
      p_amount: 50, p_type: 'reward', p_source_event_id: `milestone_onboarding_complete_${U}`,
    }));
    expect(r.vtna_credited).toBe(50);
  });

  test('a recording failure is counted, payment is still attempted, no event is emitted', async () => {
    m.countPrimaryMemberships.mockResolvedValue({ count: 1 } as any);
    m.insertAchievedMilestone.mockResolvedValue({ error: { message: 'violates check constraint' } } as any);
    const r = await scanUserMilestonesDetailed(sb, U, T);
    expect(r.record_failures).toBe(1);
    expect(m.creditWalletForMilestone).toHaveBeenCalledTimes(1);
    expect(milestoneEvents()).toHaveLength(0);
  });

  test('credit_wallet ok=false is counted as a failure, not as credited', async () => {
    m.countPrimaryMemberships.mockResolvedValue({ count: 1 } as any);
    m.creditWalletForMilestone.mockResolvedValue({ data: { ok: false, error: 'UNSUPPORTED_TYPE' }, error: null } as any);
    const r = await scanUserMilestonesDetailed(sb, U, T);
    expect(r.credit_failures).toBe(1);
    expect(r.vtna_credited).toBe(0);
  });

  test('a duplicate credit is neither a failure nor new VTNA', async () => {
    m.countPrimaryMemberships.mockResolvedValue({ count: 1 } as any);
    m.creditWalletForMilestone.mockResolvedValue({ data: { ok: true, duplicate: true }, error: null } as any);
    const r = await scanUserMilestonesDetailed(sb, U, T);
    expect(r).toMatchObject({ credit_failures: 0, vtna_credited: 0 });
  });

  test('quiet (backfill) emits no celebration; default emits once recorded', async () => {
    m.countPrimaryMemberships.mockResolvedValue({ count: 1 } as any);
    await scanUserMilestonesDetailed(sb, U, T, { quiet: true });
    expect(milestoneEvents()).toHaveLength(0);
    fetchSpy.mockClear();
    await scanUserMilestonesDetailed(sb, U, T);
    expect(milestoneEvents()).toHaveLength(1);
  });

  test('one scan catches up several tiers (five_connections and first_connection)', async () => {
    m.countConnectedRelationshipEdges.mockResolvedValue({ count: 5 } as any);
    const r = await scanUserMilestonesDetailed(sb, U, T);
    expect(r.milestones.sort()).toEqual(['first_connection', 'five_connections']);
    expect(r.vtna_credited).toBe(20 + 30);
  });

  test('already-achieved milestones are not paid again', async () => {
    m.countPrimaryMemberships.mockResolvedValue({ count: 1 } as any);
    m.fetchAchievedMilestoneRefs.mockResolvedValue({ data: [{ source_ref: 'onboarding_complete' }], error: null } as any);
    const r = await scanUserMilestonesDetailed(sb, U, T);
    expect(r.milestones).toEqual([]);
    expect(m.creditWalletForMilestone).not.toHaveBeenCalled();
  });

  test('the inline action check pays and announces a new first event RSVP', async () => {
    m.countRsvpMeetupAttendance.mockResolvedValue({ count: 1 } as any);
    const got = await checkMilestonesForAction(sb, U, T, 'event_rsvp');
    expect(got).toEqual(['first_event_rsvp']);
    expect(m.creditWalletForMilestone).toHaveBeenCalledWith(sb, expect.objectContaining({ p_amount: 15 }));
    expect(milestoneEvents()).toHaveLength(1);
  });
});

describe('first_event_rsvp reads the live RSVP table', () => {
  test('global_event_participants, status attending', async () => {
    const real = jest.requireActual('../src/services/milestone-service-repository');
    const calls: Array<[string, ...unknown[]]> = [];
    const chain: any = {
      select: (...a: unknown[]) => { calls.push(['select', ...a]); return chain; },
      eq: (...a: unknown[]) => { calls.push(['eq', ...a]); return chain; },
    };
    const client: any = { from: (t: string) => { calls.push(['from', t]); return chain; } };
    await real.countRsvpMeetupAttendance(client, U);
    expect(calls[0]).toEqual(['from', 'global_event_participants']);
    expect(calls).toContainEqual(['eq', 'status', 'attending']);
  });
});

describe('rule table — owner decision 2026-10-05', () => {
  test('the three capped rules, amounts, caps and windows', () => {
    expect(getRewardRule('autopilot_action_done')).toMatchObject({ amount: 5, cap: { count: 2, days: 1 }, window: 'day', live: true, once: false });
    expect(getRewardRule('live_room_15min')).toMatchObject({ amount: 20, cap: { count: 3, days: 7 }, window: 'week', live: true });
    expect(getRewardRule('index_new_best')).toMatchObject({ amount: 50, cap: { count: 1, days: 7 }, window: 'week', live: true });
    expect(cappedRules().map((r) => r.id).sort()).toEqual(['autopilot_action_done', 'index_new_best', 'live_room_15min']);
    expect(getRewardRule('onboarding_complete')?.amount).toBe(50);
    expect(new Set(VTNA_REWARD_RULES.map((r) => r.id)).size).toBe(VTNA_REWARD_RULES.length);
  });

  test('UTC windows match Postgres date_trunc (day / ISO week from Monday)', () => {
    const wed = new Date('2026-10-07T15:30:00Z');
    expect(capWindowStart('day', wed).toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(capWindowStart('week', wed).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(capWindowStart('week', new Date('2026-10-11T23:59:00Z')).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(capWindowStart('week', new Date('2026-10-05T00:00:00Z')).toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  test('the Wallet overview reports each capped rule with its window and count', () => {
    // VTID-04899: autopilot_action_done is listed only while its switch is exactly 'true'.
    const o = buildRewardOverview(U, { earnedKeys: [], windowCounts: { autopilot_action_done: 1 }, recent: [] }, 0, { AUTOPILOT_ACTION_REWARD_ENABLED: 'true' } as any);
    const all = o.groups.flatMap((g) => g.rules);
    expect(all.find((r) => r.id === 'autopilot_action_done')).toMatchObject({ amount: 5, window: 'day', cap: { count: 2, days: 1 }, used_in_window: 1 });
    expect(all.find((r) => r.id === 'live_room_15min')).toMatchObject({ window: 'week', used_in_window: 0 });
    expect(all.find((r) => r.id === 'invite_friend_joined')).toMatchObject({ window: null });
    expect(all.find((r) => r.id === 'first_diary')).toMatchObject({ window: null, cap: null });
  });

  test('the Wallet history maps capped keys back to their rule', () => {
    expect(ruleIdForKey(capRewardKey('autopilot_action_done', 'rec-1'), U)).toBe('autopilot_action_done');
    expect(ruleIdForKey(capRewardKey('live_room_15min', 'att'), U)).toBe('live_room_15min');
    expect(ruleIdForKey(capRewardKey('index_new_best', '2026-10-05'), U)).toBe('index_new_best');
    expect(ruleIdForKey(`milestone_first_diary_${U}`, U)).toBe('first_diary');
  });
});

describe('claimCappedReward', () => {
  const rpcClient = (result: { data?: unknown; error?: unknown }) => {
    const rpc = jest.fn().mockResolvedValue(result);
    return { client: { rpc } as any, rpc };
  };

  test('amount, cap and window come from the rule table, never the caller', async () => {
    const { client, rpc } = rpcClient({ data: { ok: true, claimed: true, amount: 5 }, error: null });
    const r = await claimCappedReward(client, { tenantId: T, userId: U, ruleId: 'autopilot_action_done', ref: 'rec-1' }, { AUTOPILOT_ACTION_REWARD_ENABLED: 'true' } as any);
    expect(rpc).toHaveBeenCalledWith('claim_capped_reward', {
      p_tenant_id: T, p_user_id: U, p_rule: 'autopilot_action_done', p_ref: 'rec-1',
      p_amount: 5, p_cap: 2, p_window: 'day',
    });
    expect(r).toEqual({ outcome: 'claimed', credited: 5 });
  });

  test.each([
    [{ ok: true, claimed: false, reason: 'capped' }, 'capped'],
    [{ ok: true, claimed: false, reason: 'duplicate' }, 'duplicate'],
    [{ ok: false, error: 'NOT_ELIGIBLE' }, 'not_eligible'],
    [{ ok: false, error: 'CREDIT_FAILED' }, 'failed'],
  ])('%j -> %s, nothing credited', async (data, outcome) => {
    const { client } = rpcClient({ data, error: null });
    const r = await claimCappedReward(client, { tenantId: T, userId: U, ruleId: 'live_room_15min', ref: 'a' });
    expect(r).toMatchObject({ outcome, credited: 0 });
  });

  test('a transport error or a throw is reported, never thrown', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'boom' } });
    expect(await claimCappedReward(client, { tenantId: T, userId: U, ruleId: 'index_new_best', ref: 'd' })).toMatchObject({ outcome: 'failed', credited: 0 });
    const throwing = { rpc: jest.fn().mockRejectedValue(new Error('net')) } as any;
    expect(await claimCappedReward(throwing, { tenantId: T, userId: U, ruleId: 'index_new_best', ref: 'd' })).toMatchObject({ outcome: 'failed' });
  });

  test('a once-only rule is not claimable through the capped path', async () => {
    const { client, rpc } = rpcClient({ data: { ok: true, claimed: true }, error: null });
    expect(await claimCappedReward(client, { tenantId: T, userId: U, ruleId: 'first_diary', ref: 'x' })).toMatchObject({ outcome: 'not_capped_rule' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('reward sweep — production only', () => {
  test('staging refuses before any query; the switch turns it off', async () => {
    expect(rewardSweepAllowed({ VITANA_ENV: 'staging' } as any)).toEqual({ ok: false, error: 'NOT_PRODUCTION' });
    expect(rewardSweepAllowed({ REWARD_SWEEP_ENABLED: 'false' } as any)).toEqual({ ok: false, error: 'DISABLED' });
    expect(rewardSweepAllowed({} as any)).toEqual({ ok: true });
    const client = { rpc: jest.fn() } as any;
    const r = await runRewardSweep(client, { quiet: true, env: { VITANA_ENV: 'staging' } as any });
    expect(r).toMatchObject({ ok: false, error: 'NOT_PRODUCTION', members_scanned: 0 });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  test('the loop only runs inside AWS ECS on production', () => {
    expect(rewardSweepLoopAllowed({} as any)).toBe(false);
    expect(rewardSweepLoopAllowed({ ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x' } as any)).toBe(true);
    expect(rewardSweepLoopAllowed({ ECS_CONTAINER_METADATA_URI_V4: 'x', VITANA_ENV: 'staging' } as any)).toBe(false);
  });

  test('scans every member page, then claims live rooms and Index bests from this week', async () => {
    m.countPrimaryMemberships.mockResolvedValue({ count: 1 } as any);
    const page1 = Array.from({ length: 100 }, (_, i) => ({ user_id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, tenant_id: T }));
    const page2 = [{ user_id: 'ffffffff-0000-0000-0000-000000000000', tenant_id: T }];
    const rpc = jest.fn(async (fn: string, args: any) => {
      if (fn === 'reward_sweep_members') return { data: args.p_after ? page2 : page1, error: null };
      if (fn === 'reward_sweep_live_room_candidates') return { data: [{ user_id: U, tenant_id: T, attendance_id: 'att-1' }], error: null };
      if (fn === 'reward_sweep_index_candidates') return { data: [{ user_id: U, tenant_id: T, score_date: '2026-10-07' }], error: null };
      if (fn === 'claim_capped_reward') return { data: { ok: true, claimed: true, amount: args.p_amount }, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    const now = new Date('2026-10-07T12:00:00Z');
    const r = await runRewardSweep({ rpc } as any, { quiet: true, now, env: {} as any });
    expect(r).toMatchObject({ ok: true, complete: true, members_scanned: 101, live_room_claims: 1, index_claims: 1 });
    expect(r.vtna_credited).toBe(101 * 50 + 20 + 50);
    expect(rpc).toHaveBeenCalledWith('reward_sweep_members', { p_after: page1[99].user_id, p_limit: 100 });
    // Monday 2026-10-05 00:00Z minus the 7 h grace.
    expect(rpc).toHaveBeenCalledWith('reward_sweep_live_room_candidates', { p_since: '2026-10-04T17:00:00.000Z' });
    expect(rpc).toHaveBeenCalledWith('reward_sweep_index_candidates', { p_since: '2026-10-04' });
    expect(milestoneEvents()).toHaveLength(0); // quiet backfill
  });

  test('a query failure is counted and the run still finishes', async () => {
    const rpc = jest.fn(async (fn: string) => {
      if (fn === 'reward_sweep_members') return { data: null, error: { message: 'down' } };
      return { data: [], error: null };
    });
    const r = await runRewardSweep({ rpc } as any, { quiet: false, env: {} as any });
    expect(r).toMatchObject({ ok: true, complete: true, query_failures: 1 });
  });

  test('the time budget stops the run and says so', async () => {
    const rpc = jest.fn(async () => ({ data: [], error: null }));
    const r = await runRewardSweep({ rpc } as any, { quiet: false, env: {} as any, budgetMs: -1 });
    expect(r).toMatchObject({ ok: false, error: 'BUDGET_EXHAUSTED', complete: false });
  });
});
