/**
 * VTID-04809: credit_wallet() idempotency keys for VTNA rewards.
 *
 * credit_wallet() applies a given key at most once per member. When two code
 * paths can pay the same reward (the member-invite claim and automation
 * AP-0405 both reward a referral), they must build the key here so the second
 * one lands as a duplicate instead of paying twice.
 */

export function referralRewardEventId(referrerId: string, referredId: string): string {
  return `referral_reward:${referrerId}:${referredId}`;
}

export function welcomeBonusEventId(userId: string): string {
  return `onboarding_welcome_bonus:${userId}`;
}

/** credit_wallet() reports business failures in `data`, not `error`. */
export function creditWalletSucceeded(data: unknown, error: unknown): boolean {
  if (error) return false;
  return (data as { ok?: boolean } | null)?.ok === true;
}
