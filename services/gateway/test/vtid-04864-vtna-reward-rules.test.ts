/**
 * VTID-04864 — the VTNA reward rules are ONE table, every payer reads it, no
 * reward is paid twice, and the Wallet → Rewards overview shows exactly the
 * rules that pay.
 *
 * Owner decision 2026-10-03: "You earn VTNA for real things you do yourself,
 * once per milestone, and for staying consistent."
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  VTNA_REWARD_RULES,
  VTNA_NEVER_EARNS,
  rewardAmount,
  rewardEventId,
  visibleRewardRules,
} from '../src/services/rewards/vtna-reward-rules';
import { MILESTONES } from '../src/services/milestone-service';
import { streakTierReward } from '../src/services/diary-streak-celebrator';
import { welcomeBonusEventId } from '../src/services/wallet/vtna-reward-keys';
import {
  DEFAULT_INVITE_REWARD_CREDITS,
  INVITE_REWARD_MONTHLY_CAP,
} from '../src/services/community-autopilot/invites';
import { buildRewardOverview, ruleIdForKey } from '../src/services/rewards/reward-overview-service';
import { maybePayInviteMilestone } from '../src/services/community-autopilot/invites';
import { REWARD_TABLE } from '../src/types/automations';

const U = '11111111-1111-4111-8111-111111111111';

describe('VTID-04864: one VTNA rule table', () => {
  it('has the four approved groups: first steps, habits, community, never-earns', () => {
    const groups = new Set(VTNA_REWARD_RULES.map((r) => r.group));
    expect([...groups].sort()).toEqual(['community', 'first_steps', 'habits']);
    expect(VTNA_NEVER_EARNS).toEqual(['done_by_vitana', 'purchases', 'self_reported']);
  });

  it('first steps and habits are once-only; habits are the 3/7/30-day streaks only', () => {
    for (const r of VTNA_REWARD_RULES.filter((x) => x.group !== 'community')) expect(r.once).toBe(true);
    expect(VTNA_REWARD_RULES.filter((r) => r.group === 'habits').map((r) => r.id)).toEqual([
      'diary_streak_3', 'diary_streak_7', 'diary_streak_30',
    ]);
  });

  it('every milestone pays exactly the rule-table amount (0 when it is not a rule)', () => {
    for (const [id, def] of Object.entries(MILESTONES)) {
      expect({ id, reward: def.reward }).toEqual({ id, reward: rewardAmount(id) });
    }
    expect(MILESTONES.first_referral.reward).toBe(0);
    // every first-step / habit rule is a real milestone the service detects
    for (const r of VTNA_REWARD_RULES.filter((x) => x.group !== 'community')) {
      expect(MILESTONES[r.id]).toBeDefined();
    }
  });

  it('diary streak celebrator pays from the table: 3→20, 7→50, 14→0, 30→100', () => {
    expect([3, 7, 14, 30].map(streakTierReward)).toEqual([20, 50, 0, 100]);
  });

  it('the invite reward amount and monthly cap come from the table: 1,000 per friend, 10 per 30 days', () => {
    expect(rewardAmount('invite_friend_joined')).toBe(1000);
    expect(DEFAULT_INVITE_REWARD_CREDITS).toBe(1000);
    expect(INVITE_REWARD_MONTHLY_CAP).toBe(10);
    expect(REWARD_TABLE.referral_completed.amount).toBe(1000);
    expect(REWARD_TABLE.complete_onboarding.amount).toBe(rewardAmount('onboarding_complete'));
  });

  it('a one-time 10,000 VTNA bonus at 10 invited friends', () => {
    expect(rewardAmount('invited_friends_10')).toBe(10000);
    expect(VTNA_REWARD_RULES.find((r) => r.id === 'invited_friends_10')?.once).toBe(true);
  });
});

describe('VTID-04864: nothing is paid twice', () => {
  it('the AP-1301 welcome bonus shares the onboarding_complete milestone key', () => {
    expect(welcomeBonusEventId(U)).toBe(rewardEventId('onboarding_complete', U));
    expect(rewardEventId('onboarding_complete', U)).toBe(`milestone_onboarding_complete_${U}`);
  });

  it('the streak celebrator and the milestone service use the same key per tier', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/diary-streak-celebrator.ts'), 'utf8');
    expect(src).toContain('rewardEventId(ruleId, userId)');
    expect(src).not.toMatch(/p_source_event_id:\s*`diary_streak_/);
    const ms = fs.readFileSync(path.join(__dirname, '../src/services/milestone-service.ts'), 'utf8');
    expect(ms.match(/p_source_event_id: rewardEventId\(milestoneId, userId\)/g)?.length).toBe(2);
  });

  it('the streak push never claims a credit that did not land', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/diary-streak-celebrator.ts'), 'utf8');
    expect(src).toContain('credited > 0 ? `${tier.message} +${credited} VTNA credited.` : tier.message');
    expect(src).not.toContain('tier.reward');
  });

  it('a migration stops Autopilot completion paying 10 VTNA on top of the milestone', () => {
    const dir = path.join(__dirname, '../../../supabase/migrations');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('_vtid_04864_autopilot_completion_no_double_reward.sql'));
    expect(file).toBeDefined();
    const sql = fs.readFileSync(path.join(dir, file as string), 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.complete_autopilot_recommendation(');
    expect(sql).not.toMatch(/v_reward := 10/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.complete_autopilot_recommendation\(UUID, UUID\) TO authenticated/);
  });
});

describe('VTID-04864: the 10-friend invite bonus', () => {
  const rewarded = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
  const sbWith = (rows: unknown[], rpcData: unknown = { ok: true }) => {
    const q: any = { select: () => q, eq: () => q, limit: async () => ({ data: rows, error: null }) };
    return { from: () => q, rpc: jest.fn(async () => ({ data: rpcData, error: null })) } as any;
  };

  it('pays nothing below 10 rewarded friends', async () => {
    const sb = sbWith(rewarded(9));
    expect(await maybePayInviteMilestone(sb, U, 't1')).toEqual({ paid: false, reason: 'below_milestone' });
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it('pays 10,000 VTNA once at 10, under the per-member key', async () => {
    const sb = sbWith(rewarded(10));
    expect(await maybePayInviteMilestone(sb, U, 't1')).toEqual({ paid: true, reason: undefined });
    expect(sb.rpc).toHaveBeenCalledWith('credit_wallet', expect.objectContaining({
      p_user_id: U, p_amount: 10000, p_type: 'reward', p_source_event_id: `milestone_invited_friends_10_${U}`,
    }));
  });

  it('a later friend lands as a duplicate, not a second bonus', async () => {
    const sb = sbWith(rewarded(14), { ok: true, duplicate: true });
    expect(await maybePayInviteMilestone(sb, U, 't1')).toEqual({ paid: false, reason: 'already_paid' });
  });
});

describe('VTID-04864: the invite reward is on by default', () => {
  it('pays unless COMMUNITY_INVITE_REWARD_ENABLED is exactly "false"', () => {
    const inv = require('../src/services/community-autopilot/invites');
    const prev = process.env.COMMUNITY_INVITE_REWARD_ENABLED;
    delete process.env.COMMUNITY_INVITE_REWARD_ENABLED;
    expect(inv.isInviteRewardEnabled()).toBe(true);
    process.env.COMMUNITY_INVITE_REWARD_ENABLED = 'false';
    expect(inv.isInviteRewardEnabled()).toBe(false);
    if (prev === undefined) delete process.env.COMMUNITY_INVITE_REWARD_ENABLED; else process.env.COMMUNITY_INVITE_REWARD_ENABLED = prev;
  });
  it('the deploy workflows are untouched (no new pin needed)', () => {
    const wf = (n: string) => fs.readFileSync(path.join(__dirname, '../../../.github/workflows', n), 'utf8');
    expect(wf('AWS-STAGE-DEPLOY-GATEWAY.yml')).not.toContain('COMMUNITY_INVITE_REWARD_ENABLED');
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toContain('COMMUNITY_INVITE_REWARD_ENABLED');
  });
});

describe('VTID-04864: the Wallet → Rewards overview', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const rows = [
    { amount: 20, idempotency_key: `milestone_profile_complete_${U}`, created_at: '2026-10-02T10:00:00Z' },
    { amount: 20, idempotency_key: `milestone_diary_streak_3_${U}`, created_at: '2026-10-01T10:00:00Z' },
    { amount: 200, idempotency_key: `referral_reward:${U}:x`, created_at: '2026-09-20T10:00:00Z' },
    { amount: 200, idempotency_key: `referral_reward:${U}:y`, created_at: '2026-08-01T10:00:00Z' },
  ];

  it('marks earned once-rules and counts capped rules inside the window only', () => {
    const o = buildRewardOverview(U, rows, 440, now, { COMMUNITY_INVITE_REWARD_ENABLED: 'true' } as any);
    const all = o.groups.flatMap((g) => g.rules);
    expect(all.find((r) => r.id === 'profile_complete')?.earned).toBe(true);
    expect(all.find((r) => r.id === 'first_diary')?.earned).toBe(false);
    expect(all.find((r) => r.id === 'diary_streak_3')?.earned).toBe(true);
    expect(all.find((r) => r.id === 'invite_friend_joined')?.used_in_window).toBe(1);
    expect(o.earned_balance).toBe(440);
    expect(o.unit).toBe('VTNA');
    expect(o.eur_per_vtna).toBe(0.01);
  });

  it('never shows a rule that does not pay: the invite rules are hidden while their switch is off', () => {
    const off = buildRewardOverview(U, [], 0, now, { COMMUNITY_INVITE_REWARD_ENABLED: 'false' } as any);
    expect(off.groups.map((g) => g.group)).toEqual(['first_steps', 'habits']);
    expect(visibleRewardRules({ COMMUNITY_INVITE_REWARD_ENABLED: 'false' } as any).some((r) => r.id === 'invite_friend_joined')).toBe(false);
    expect(visibleRewardRules({} as any).some((r) => r.id === 'invited_friends_10')).toBe(true);
  });

  it('maps ledger keys back to rules for the recent list, and returns no display text', () => {
    expect(ruleIdForKey(`milestone_first_group_${U}`, U)).toBe('first_group');
    expect(ruleIdForKey(`referral_reward:${U}:z`, U)).toBe('invite_friend_joined');
    expect(ruleIdForKey('rec_complete_abc', U)).toBeNull();
    const o = buildRewardOverview(U, rows, 0, now, { COMMUNITY_INVITE_REWARD_ENABLED: 'false' } as any);
    expect(o.recent[0]).toEqual({ rule_id: 'profile_complete', amount: 20, created_at: '2026-10-02T10:00:00Z' });
    expect(JSON.stringify(o)).not.toMatch(/celebration|description|title/);
  });
});
