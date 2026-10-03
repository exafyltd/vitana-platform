/**
 * Diary streak celebration helper (VTID-01983 / H.5).
 *
 * Reads `user_diary_streak`, detects transitions to 3 / 7 / 14 / 30
 * days, credits a small wallet reward, and emits an OASIS event so
 * downstream surfaces (morning brief, autopilot popup banner) can
 * celebrate.
 *
 * Idempotency: only fires on the FIRST detection of a given streak tier
 * (i.e. when transitioning from N-1 to N for N ∈ {3, 7, 14, 30}). The
 * caller must call this AFTER the diary entry has been written so the
 * streak length already reflects today's save.
 *
 * Rewards (VTID-04864): the amounts and the idempotency key come from the
 * VTNA rule table (rewards/vtna-reward-rules.ts) — diary_streak_3/7/30, paid
 * once each. This used to pay its own 10/20/40/80 on top of the milestone
 * service's 20/50/100 for the same streak; now whichever path notices first
 * pays and the other lands as a credit_wallet duplicate. The 14-day tier is
 * celebrated but is not a reward rule, so it pays nothing.
 *
 * Returns the celebration payload (or null when nothing fired) so the
 * caller can include it in the response and surface it in the toast /
 * voice reply.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import { notifyUserAsync } from './notification-service';
import * as repo from './diary-streak-celebrator-repository';
import { rewardAmount, rewardEventId } from './rewards/vtna-reward-rules';
import { creditWalletSucceeded } from './wallet/vtna-reward-keys';

export interface StreakCelebration {
  current_streak_days: number;
  tier_days: number;        // the tier just reached: 3 / 7 / 14 / 30
  wallet_credit: number;    // VTNA credited
  message: string;          // human-friendly celebration ("3-day diary streak — keep it!")
}

const STREAK_TIERS: ReadonlyArray<{ days: number; message: string }> = [
  { days: 3,  message: '3-day diary streak — keep it.' },
  { days: 7,  message: '7-day diary streak — a real habit is forming.' },
  { days: 14, message: '14-day diary streak — two solid weeks.' },
  { days: 30, message: '30-day diary streak — this is your practice now.' },
];

/** VTNA for reaching a streak tier — from the rule table; 0 = not a reward. */
export function streakTierReward(days: number): number {
  return rewardAmount(`diary_streak_${days}`);
}

/**
 * Check the user's current diary streak. If today's save crossed into a
 * tier (3, 7, 14, or 30 days), fire the wallet credit + OASIS event and
 * return the celebration payload.
 *
 * Best-effort: any DB / event errors log + return null so the diary write
 * is never blocked by the celebration path.
 */
export async function celebrateDiaryStreak(
  admin: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<StreakCelebration | null> {
  try {
    const { data: streakRow } = await repo.fetchUserDiaryStreak(admin, userId);

    const streak = Number((streakRow as any)?.current_streak_days ?? 0);
    if (streak <= 0) return null;

    // Only fire on EXACT transition to a tier — not every day at or above.
    const tier = STREAK_TIERS.find(t => t.days === streak);
    if (!tier) return null;

    // Idempotency: dedup on (user_id, streak_days) via the OASIS event's
    // payload — if a celebration event already exists for this streak
    // length today, skip. Cheap dedup query (filter in last 25 hours so a
    // single-day duplicate never re-fires).
    const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await repo.fetchExistingStreakCelebrationEvent(admin, userId, tier.days, since);
    if (Array.isArray(existing) && existing.length > 0) {
      // Already celebrated this tier today — skip the credit + event but
      // still return the payload so voice/toast can mention it idly if
      // they want. Caller can ignore it.
      return null;
    }

    // Wallet credit — mirror the autopilot onboarding pattern.
    //
    // credit_wallet is best-effort — wallet may dedup on p_source_event_id
    // (idempotent) or be temporarily unavailable. Streak event/notification
    // still fire regardless (see AURORA-B3-RPC-PARITY-INVENTORY.md's
    // 2026-08-29 addendum: whether the notification should keep claiming
    // "credited" when this RPC fails is a product decision, not fixed
    // here). What IS fixed here: supabase-js's .rpc() resolves normally
    // with an {error} field on a Postgres-level failure — it does NOT
    // throw — so the `catch` below was previously unreachable for
    // credit_wallet not existing, and the failure was completely invisible
    // in logs. Checking `error` explicitly makes it loud, per this
    // codebase's own "never silence errors" rule.
    // `credited` is what actually landed: 0 when the tier is not a reward
    // rule, when the milestone service already paid it (duplicate), or when
    // the credit failed — the push below never claims a credit that did not
    // happen.
    const ruleId = `diary_streak_${tier.days}`;
    const reward = streakTierReward(tier.days);
    let credited = 0;
    if (reward > 0) {
      try {
        const { data: walletData, error: walletErr } = await repo.creditWallet(admin, {
          p_tenant_id: tenantId,
          p_user_id: userId,
          p_amount: reward,
          p_type: 'reward',
          p_source: 'diary_streak',
          p_source_event_id: rewardEventId(ruleId, userId),
          p_description: `Diary ${tier.days}-day streak`,
        });
        if (walletErr) {
          console.error(`[diary-streak] credit_wallet RPC returned an error: ${walletErr.message}`);
        } else if (creditWalletSucceeded(walletData, walletErr) && !(walletData as { duplicate?: boolean }).duplicate) {
          credited = reward;
        }
      } catch (walletErr: any) {
        // Network-layer failure (the only case .rpc() actually rejects for).
        console.warn(`[diary-streak] credit_wallet failed: ${walletErr?.message ?? walletErr}`);
      }
    }

    // OASIS event so the morning brief + autopilot popup can pick it up.
    try {
      await emitOasisEvent({
        vtid: 'VTID-01983',
        type: 'diary.streak_celebrated' as any,
        source: 'memory-diary',
        status: 'success',
        message: tier.message,
        payload: {
          user_id: userId,
          tenant_id: tenantId,
          streak_days: tier.days,
          reward_vtn: credited,
        },
      });
    } catch (evErr: any) {
      console.warn(`[diary-streak] oasis emit failed: ${evErr?.message ?? evErr}`);
    }

    // BOOTSTRAP-NOTIF-SYSTEM-EVENTS: fire push + in-app notification so the
    // user sees the streak celebration on their device, not just in the
    // morning brief. Respects user_notification_preferences + DND.
    notifyUserAsync(userId, tenantId, 'diary_streak_milestone', {
      title: `${tier.days}-day diary streak!`,
      body: credited > 0 ? `${tier.message} +${credited} VTNA credited.` : tier.message,
      data: {
        url: '/diary',
        streak_days: String(tier.days),
        reward_vtn: String(credited),
      },
    }, admin);

    console.log(`[diary-streak] user=${userId.slice(0, 8)} hit ${tier.days}-day streak +${credited} VTNA`);
    return {
      current_streak_days: streak,
      tier_days: tier.days,
      wallet_credit: credited,
      message: tier.message,
    };
  } catch (err: any) {
    console.warn(`[diary-streak] check failed (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}
