/**
 * VTID-04809: credit_wallet() idempotency keys for VTNA rewards.
 *
 * credit_wallet() applies a given key at most once per member. When two code
 * paths can pay the same reward (the member-invite claim and automation
 * AP-0405 both reward a referral), they must build the key here so the second
 * one lands as a duplicate instead of paying twice.
 */

import { rewardEventId } from '../rewards/vtna-reward-rules';

export function referralRewardEventId(referrerId: string, referredId: string): string {
  return `referral_reward:${referrerId}:${referredId}`;
}

/**
 * VTID-04864: the AP-1301 welcome bonus IS the onboarding_complete first
 * step, so it shares that rule's key — whichever path notices first pays,
 * the other lands as a duplicate (it used to be a second 50 VTNA).
 */
export function welcomeBonusEventId(userId: string): string {
  return rewardEventId('onboarding_complete', userId);
}

/** credit_wallet() reports business failures in `data`, not `error`. */
export function creditWalletSucceeded(data: unknown, error: unknown): boolean {
  if (error) return false;
  return (data as { ok?: boolean } | null)?.ok === true;
}
