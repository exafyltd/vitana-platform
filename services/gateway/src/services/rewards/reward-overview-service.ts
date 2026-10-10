/**
 * VTID-04864 — the Wallet → Rewards overview: the VTNA rules a member can
 * earn under (from the one rule table), which of them this member has
 * already earned, and their recent rewards.
 *
 * Text is NOT returned: the app renders every label from its own catalog
 * keyed by rule id (screens.wallet.rewardRules.*), so all 11 languages work
 * and nothing here is a hardcoded member-facing string.
 */
import { getSupabase } from '../../lib/supabase';
import * as repo from './reward-overview-repository';
import {
  RewardRuleGroup,
  VTNA_NEVER_EARNS,
  VTNA_REWARD_RULES,
  capRewardKey,
  capWindowStart,
  cappedRules,
  rewardEventId,
  visibleRewardRules,
} from './vtna-reward-rules';
import { inviteRewardCredits } from '../community-autopilot/invites';

export const VTNA_EUR_VALUE = 0.01;
const RECENT_SHOWN = 10;

export interface RewardOverviewRule {
  id: string;
  amount: number;
  once: boolean;
  cap: { count: number; days: number } | null;
  /** VTID-04878: calendar window (UTC) of a capped rule; null = rolling `cap.days`. */
  window: 'day' | 'week' | null;
  /** once-rules: already paid to this member. */
  earned: boolean;
  /** capped rules: how many paid inside the current window. */
  used_in_window: number | null;
}

export interface RewardOverview {
  ok: true;
  unit: 'VTNA';
  eur_per_vtna: number;
  earned_balance: number;
  groups: Array<{ group: RewardRuleGroup; rules: RewardOverviewRule[] }>;
  never_earns: string[];
  recent: Array<{ rule_id: string | null; amount: number; created_at: string }>;
}

const GROUP_ORDER: RewardRuleGroup[] = ['first_steps', 'habits', 'community'];

/** Which rule a ledger row paid, from its idempotency key. */
export function ruleIdForKey(key: string | null | undefined, userId: string): string | null {
  if (!key) return null;
  if (key.startsWith('referral_reward:')) return 'invite_friend_joined';
  // VTID-04878: capped rules are keyed `<rule>:<ref>`.
  for (const r of cappedRules()) {
    if (key.startsWith(capRewardKey(r.id, ''))) return r.id;
  }
  const prefix = 'milestone_';
  const suffix = `_${userId}`;
  if (key.startsWith(prefix) && key.endsWith(suffix)) {
    return key.slice(prefix.length, key.length - suffix.length);
  }
  return null;
}

export interface RewardOverviewInput {
  /** Once-only rule keys this member has ever been paid (lifetime). */
  earnedKeys: string[];
  /** Per capped rule: how many were paid inside its rolling window. */
  windowCounts: Record<string, number>;
  /** Most recent reward rows, newest first (history list only). */
  recent: Array<{ amount: number | string; idempotency_key: string | null; created_at: string }>;
}

export function buildRewardOverview(
  userId: string,
  input: RewardOverviewInput,
  earnedBalance: number,
  env: NodeJS.ProcessEnv = process.env,
): RewardOverview {
  const keys = new Set(input.earnedKeys);
  const groups = GROUP_ORDER.map((group) => ({
    group,
    rules: visibleRewardRules(env)
      .filter((r) => r.group === group)
      .map((r) => ({
        id: r.id,
        amount: r.id === 'invite_friend_joined' ? inviteRewardCredits() : r.amount,
        once: r.once,
        cap: r.cap ?? null,
        window: r.window ?? null,
        earned: r.once ? keys.has(rewardEventId(r.id, userId)) : false,
        used_in_window: r.cap ? input.windowCounts[r.id] ?? 0 : null,
      })),
  })).filter((g) => g.rules.length > 0);

  return {
    ok: true,
    unit: 'VTNA',
    eur_per_vtna: VTNA_EUR_VALUE,
    earned_balance: earnedBalance,
    groups,
    never_earns: [...VTNA_NEVER_EARNS],
    recent: input.recent.slice(0, RECENT_SHOWN).map((r) => ({
      rule_id: ruleIdForKey(r.idempotency_key, userId),
      amount: Number(r.amount),
      created_at: r.created_at,
    })),
  };
}

export async function getRewardOverview(userId: string, now: Date = new Date()): Promise<RewardOverview> {
  const empty: RewardOverviewInput = { earnedKeys: [], windowCounts: {}, recent: [] };
  const sb = getSupabase();
  if (!sb) return buildRewardOverview(userId, empty, 0);

  const onceKeys = VTNA_REWARD_RULES.filter((r) => r.once).map((r) => rewardEventId(r.id, userId));
  const invite = VTNA_REWARD_RULES.find((r) => r.id === 'invite_friend_joined');
  const since = new Date(now.getTime() - (invite?.cap?.days ?? 30) * 86_400_000).toISOString();

  const capped = cappedRules();
  const [earned, windowRows, recent, wallet, ...cappedRows] = await Promise.all([
    repo.fetchEarnedKeys(sb, userId, onceKeys),
    repo.fetchKeyPrefixSince(sb, userId, `referral_reward:${userId}:`, since),
    repo.fetchRecentRewards(sb, userId, RECENT_SHOWN),
    repo.fetchEarnedBalance(sb, userId),
    // VTID-04878: each capped rule counts inside its own calendar window (UTC).
    ...capped.map((r) =>
      repo.fetchKeyPrefixSince(sb, userId, capRewardKey(r.id, ''), capWindowStart(r.window!, now).toISOString()),
    ),
  ]);
  for (const [name, r] of [['earned keys', earned], ['invite window', windowRows], ['recent rewards', recent]] as const) {
    if ((r as { error?: { message: string } | null }).error) {
      console.error(`[reward-overview] reading ${name} failed for ${userId.slice(0, 8)}: ${(r as any).error.message}`);
    }
  }
  const windowCounts: Record<string, number> = { invite_friend_joined: (windowRows.data ?? []).length };
  capped.forEach((r, i) => {
    const res = cappedRows[i] as { data?: unknown[] | null; error?: { message: string } | null };
    if (res.error) console.error(`[reward-overview] reading ${r.id} window failed for ${userId.slice(0, 8)}: ${res.error.message}`);
    windowCounts[r.id] = (res.data ?? []).length;
  });
  return buildRewardOverview(
    userId,
    {
      earnedKeys: ((earned.data ?? []) as Array<{ idempotency_key: string }>).map((x) => x.idempotency_key),
      windowCounts,
      recent: (recent.data ?? []) as RewardOverviewInput['recent'],
    },
    Number((wallet.data as { earned_balance?: number } | null)?.earned_balance ?? 0),
  );
}
