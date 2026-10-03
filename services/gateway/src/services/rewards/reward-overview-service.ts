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
  rewardEventId,
  visibleRewardRules,
} from './vtna-reward-rules';
import { inviteRewardCredits } from '../community-autopilot/invites';

export const VTNA_EUR_VALUE = 0.01;
const HISTORY_SCAN = 200;
const RECENT_SHOWN = 10;

export interface RewardOverviewRule {
  id: string;
  amount: number;
  once: boolean;
  cap: { count: number; days: number } | null;
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
  const prefix = 'milestone_';
  const suffix = `_${userId}`;
  if (key.startsWith(prefix) && key.endsWith(suffix)) {
    return key.slice(prefix.length, key.length - suffix.length);
  }
  return null;
}

export function buildRewardOverview(
  userId: string,
  rows: Array<{ amount: number | string; idempotency_key: string | null; created_at: string }>,
  earnedBalance: number,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): RewardOverview {
  const keys = new Set(rows.map((r) => r.idempotency_key).filter(Boolean) as string[]);
  const groups = GROUP_ORDER.map((group) => ({
    group,
    rules: visibleRewardRules(env)
      .filter((r) => r.group === group)
      .map((r) => {
        let usedInWindow: number | null = null;
        if (r.cap) {
          const since = now.getTime() - r.cap.days * 86_400_000;
          usedInWindow = rows.filter(
            (row) => ruleIdForKey(row.idempotency_key, userId) === r.id && Date.parse(row.created_at) >= since,
          ).length;
        }
        return {
          id: r.id,
          amount: r.id === 'invite_friend_joined' ? inviteRewardCredits() : r.amount,
          once: r.once,
          cap: r.cap ?? null,
          earned: r.once ? keys.has(rewardEventId(r.id, userId)) : false,
          used_in_window: usedInWindow,
        };
      }),
  })).filter((g) => g.rules.length > 0);

  return {
    ok: true,
    unit: 'VTNA',
    eur_per_vtna: VTNA_EUR_VALUE,
    earned_balance: earnedBalance,
    groups,
    never_earns: [...VTNA_NEVER_EARNS],
    recent: rows.slice(0, RECENT_SHOWN).map((r) => ({
      rule_id: ruleIdForKey(r.idempotency_key, userId),
      amount: Number(r.amount),
      created_at: r.created_at,
    })),
  };
}

export async function getRewardOverview(userId: string): Promise<RewardOverview> {
  const sb = getSupabase();
  if (!sb) return buildRewardOverview(userId, [], 0);
  const [{ data: rows, error }, { data: wallet }] = await Promise.all([
    repo.fetchRewardTransactions(sb, userId, HISTORY_SCAN),
    repo.fetchEarnedBalance(sb, userId),
  ]);
  if (error) {
    console.error(`[reward-overview] reading rewards failed for ${userId.slice(0, 8)}: ${error.message}`);
  }
  return buildRewardOverview(
    userId,
    (rows ?? []) as Array<{ amount: number; idempotency_key: string | null; created_at: string }>,
    Number((wallet as { earned_balance?: number } | null)?.earned_balance ?? 0),
  );
}
