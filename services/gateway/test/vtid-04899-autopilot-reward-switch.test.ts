/**
 * VTID-04899 — a production-safe switch for the immediate Autopilot completion
 * reward (owner decision 2026-10-05).
 *
 * AUTOPILOT_ACTION_REWARD_ENABLED is fail closed: autopilot_action_done pays
 * only when it is exactly 'true'. isRuleLive() is the one gate: the payer
 * (claimCappedReward, used by both completion paths) and Wallet → Rewards
 * (visibleRewardRules) both read it, so a switched-off reward is neither paid
 * nor advertised. live_room_15min and index_new_best follow
 * REWARD_SWEEP_ENABLED (their only payer is the sweep); invite rules keep
 * COMMUNITY_INVITE_REWARD_ENABLED. Each switch changes only its own rules.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { claimCappedReward } from '../src/services/rewards/capped-reward';
import { getRewardRule, isRuleLive, visibleRewardRules } from '../src/services/rewards/vtna-reward-rules';
import { buildRewardOverview } from '../src/services/rewards/reward-overview-service';
import { rewardSweepAllowed } from '../src/services/rewards/reward-sweep';

const U = '11111111-1111-1111-1111-111111111111';
const T = '22222222-2222-2222-2222-222222222222';
const ON = { AUTOPILOT_ACTION_REWARD_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv;
const OFF = {} as unknown as NodeJS.ProcessEnv;
const rule = (id: string) => getRewardRule(id)!;
const ids = (env: NodeJS.ProcessEnv) => visibleRewardRules(env).map((r) => r.id);
const rpcClient = (data: unknown) => {
  const rpc = jest.fn().mockResolvedValue({ data, error: null });
  return { client: { rpc } as any, rpc };
};
const claimArgs = { tenantId: T, userId: U, ruleId: 'autopilot_action_done', ref: 'rec-1' };

describe('payout: the switch is fail closed', () => {
  test.each([
    ['unset', OFF],
    ["'false'", { AUTOPILOT_ACTION_REWARD_ENABLED: 'false' }],
    ["'TRUE' (not exactly 'true')", { AUTOPILOT_ACTION_REWARD_ENABLED: 'TRUE' }],
    ["'1'", { AUTOPILOT_ACTION_REWARD_ENABLED: '1' }],
  ])('%s → rule_off, the RPC is never called, nothing is credited', async (_label, env) => {
    const { client, rpc } = rpcClient({ ok: true, claimed: true, amount: 5 });
    const r = await claimCappedReward(client, claimArgs, env as any);
    expect(r).toEqual({ outcome: 'rule_off', credited: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  test("exactly 'true' → the claim goes to the database with the rule's own amount, cap and window", async () => {
    const { client, rpc } = rpcClient({ ok: true, claimed: true, amount: 5 });
    const r = await claimCappedReward(client, claimArgs, ON);
    expect(rpc).toHaveBeenCalledWith('claim_capped_reward', {
      p_tenant_id: T, p_user_id: U, p_rule: 'autopilot_action_done', p_ref: 'rec-1',
      p_amount: 5, p_cap: 2, p_window: 'day',
    });
    expect(r).toEqual({ outcome: 'claimed', credited: 5 });
  });
});

describe('interaction with the daily cap (2 per UTC day)', () => {
  test('enabled: the cap is still enforced by the database — the third claim of the day is capped and pays 0', async () => {
    const { client } = rpcClient({ ok: true, claimed: false, reason: 'capped', amount: 0, cap: 2, window: 'day' });
    expect(await claimCappedReward(client, { ...claimArgs, ref: 'rec-3' }, ON)).toEqual({ outcome: 'capped', credited: 0 });
  });

  test('enabled: a second claim for the same item is a duplicate, not a second payout', async () => {
    const { client } = rpcClient({ ok: true, claimed: false, reason: 'duplicate', amount: 0 });
    expect(await claimCappedReward(client, claimArgs, ON)).toEqual({ outcome: 'duplicate', credited: 0 });
  });

  test('disabled: claims never reach the database, so they write no wallet row and use none of the day\'s cap', async () => {
    const { client, rpc } = rpcClient({ ok: true, claimed: true, amount: 5 });
    for (const ref of ['a', 'b', 'c']) await claimCappedReward(client, { ...claimArgs, ref }, OFF);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('completions made while disabled are not paid later: both payers claim only on a first-time completion', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/autopilot-recommendations.ts'), 'utf8');
    const routeBlock = route.slice(route.indexOf('let credited = 0;'), route.indexOf("ruleId: 'autopilot_action_done', ref: recId"));
    expect(routeBlock).toContain('if (!alreadyCompleted) {');
    const cal = fs.readFileSync(path.join(__dirname, '../src/services/calendar-producers.ts'), 'utf8');
    const calBlock = cal.slice(cal.indexOf('let reward = 0;'), cal.indexOf("ruleId: 'autopilot_action_done', ref: event.source_ref_id"));
    expect(calBlock).toContain('body.already_completed !== true');
    // Both go through the gated claim; nothing pays autopilot_action_done another way.
    for (const src of [route, cal]) expect(src).toContain('claimCappedReward(');
  });
});

describe('Wallet → Rewards uses the same switch', () => {
  const overview = (env: NodeJS.ProcessEnv) =>
    buildRewardOverview(U, { earnedKeys: [], windowCounts: { autopilot_action_done: 1 }, recent: [] }, 0, env)
      .groups.flatMap((g) => g.rules.map((r) => r.id));

  test('off → autopilot_action_done is neither live nor listed', () => {
    expect(isRuleLive(rule('autopilot_action_done'), OFF)).toBe(false);
    expect(ids(OFF)).not.toContain('autopilot_action_done');
    expect(overview(OFF)).not.toContain('autopilot_action_done');
  });

  test("on → listed with its cap and today's count", () => {
    expect(ids(ON)).toContain('autopilot_action_done');
    const r = buildRewardOverview(U, { earnedKeys: [], windowCounts: { autopilot_action_done: 1 }, recent: [] }, 0, ON)
      .groups.flatMap((g) => g.rules).find((x) => x.id === 'autopilot_action_done');
    expect(r).toMatchObject({ amount: 5, cap: { count: 2, days: 1 }, window: 'day', used_in_window: 1 });
  });

  test('sweep-paid rules follow REWARD_SWEEP_ENABLED: hidden and unpaid while it is false', async () => {
    const sweepOff = { REWARD_SWEEP_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv;
    expect(ids(sweepOff)).not.toContain('live_room_15min');
    expect(ids(sweepOff)).not.toContain('index_new_best');
    expect(ids(OFF)).toEqual(expect.arrayContaining(['live_room_15min', 'index_new_best']));
    const { client, rpc } = rpcClient({ ok: true, claimed: true, amount: 20 });
    expect(await claimCappedReward(client, { ...claimArgs, ruleId: 'live_room_15min', ref: 'att' }, sweepOff)).toEqual({ outcome: 'rule_off', credited: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('production as pinned (both switches false): none of the three repeatable rules is advertised; milestones still are', () => {
    const prod = { AUTOPILOT_ACTION_REWARD_ENABLED: 'false', REWARD_SWEEP_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv;
    const shown = ids(prod);
    for (const id of ['autopilot_action_done', 'live_room_15min', 'index_new_best']) expect(shown).not.toContain(id);
    expect(shown).toEqual(expect.arrayContaining(['onboarding_complete', 'diary_streak_3', 'invite_friend_joined']));
  });
});

describe('each switch changes only its own rules', () => {
  const base = ids({ AUTOPILOT_ACTION_REWARD_ENABLED: 'true' } as any);
  const diff = (env: Record<string, string>) => base.filter((id) => !ids({ AUTOPILOT_ACTION_REWARD_ENABLED: 'true', ...env } as any).includes(id)).sort();

  test('autopilot switch → only autopilot_action_done', () => {
    expect(base.filter((id) => !ids(OFF).includes(id))).toEqual(['autopilot_action_done']);
  });
  test('sweep switch → only the two sweep-paid rules', () => {
    expect(diff({ REWARD_SWEEP_ENABLED: 'false' })).toEqual(['index_new_best', 'live_room_15min']);
  });
  test('invite switch → only the two invite rules', () => {
    expect(diff({ COMMUNITY_INVITE_REWARD_ENABLED: 'false' })).toEqual(['invite_friend_joined', 'invited_friends_10']);
  });
  test('the sweep gate itself is unchanged and ignores the autopilot switch', () => {
    expect(rewardSweepAllowed({ REWARD_SWEEP_ENABLED: 'false', AUTOPILOT_ACTION_REWARD_ENABLED: 'true' } as any)).toEqual({ ok: false, error: 'DISABLED' });
    expect(rewardSweepAllowed({ VITANA_ENV: 'staging' } as any)).toEqual({ ok: false, error: 'NOT_PRODUCTION' });
    expect(rewardSweepAllowed({ AUTOPILOT_ACTION_REWARD_ENABLED: 'false' } as any)).toEqual({ ok: true });
  });
});

describe('deploy workflows', () => {
  const wf = (n: string) => fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows', n), 'utf8');
  const prodSteps = (yaml.load(wf('AWS-PROD-DEPLOY-GATEWAY.yml')) as any).jobs['build-push-deploy'].steps as Array<{ name?: string; run?: string }>;
  const at = (prefix: string) => prodSteps.findIndex((s) => (s.name ?? '').startsWith(prefix));

  // VTID-04944: on in production (owner decision 2026-10-07); off is an env_overrides dispatch.
  test('production pins it "true" before registration and before env_overrides (2/2)', () => {
    const pin = prodSteps[at('Build task-definition (reward payouts on)')];
    expect(pin).toBeDefined();
    expect(pin.run).toContain('{name:"AUTOPILOT_ACTION_REWARD_ENABLED", value:"true"}');
    expect(pin.run).not.toContain('{name:"AUTOPILOT_ACTION_REWARD_ENABLED", value:"false"}');
    expect(pin.run).toContain('select(.name != "AUTOPILOT_ACTION_REWARD_ENABLED")');
    expect(at('Build task-definition (reward payouts on)')).toBeLessThan(at('Build task-definition (2/2'));
  });

  test('the live check after the roll covers it (rollback on mismatch), read-only', () => {
    const check = prodSteps[at('Verify reward sweep setting')].run ?? '';
    expect(check).toContain('EXPECTED_AP=true');
    expect(check).toContain('has("AUTOPILOT_ACTION_REWARD_ENABLED")');
    expect(check).toMatch(/if \[ "\$LIVE_AP" != "\$EXPECTED_AP" \]; then[\s\S]*exit 1/);
    expect(check).not.toMatch(/update-service|register-task-definition/);
  });

  test('staging pins it "true" (and strips the old value first); the flag pins are regenerated', () => {
    const stage = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(stage).toContain('{name:"AUTOPILOT_ACTION_REWARD_ENABLED", value:"true"}');
    expect(stage).toContain('"COMMERCE_MCP_ENABLED","AUTOPILOT_ACTION_REWARD_ENABLED",');
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.AUTOPILOT_ACTION_REWARD_ENABLED).toEqual({ staging: 'true', prod: 'true' });
    expect(GATEWAY_WORKFLOW_PINS.REWARD_SWEEP_ENABLED).toEqual({ staging: null, prod: 'true' });
  });
});
