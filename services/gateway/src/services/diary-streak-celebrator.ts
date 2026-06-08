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
 * Reward tiers (mirror the autopilot onboarding pattern: 10 VTN base):
 *   3-day streak  → 10 VTN
 *   7-day streak  → 20 VTN
 *  14-day streak  → 40 VTN
 *  30-day streak  → 80 VTN
 *
 * Returns the celebration payload (or null when nothing fired) so the
 * caller can include it in the response and surface it in the toast /
 * voice reply.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import { notifyUserAsync } from './notification-service';

export interface StreakCelebration {
  current_streak_days: number;
  tier_days: number;        // the tier just reached: 3 / 7 / 14 / 30
  wallet_credit: number;    // VTN credited
  message: string;          // human-friendly celebration ("3-day diary streak — keep it!")
}

const STREAK_TIERS: ReadonlyArray<{ days: number; reward: number; message: string }> = [
  { days: 3,  reward: 10, message: '3-day diary streak — keep it.' },
  { days: 7,  reward: 20, message: '7-day diary streak — a real habit is forming.' },
  { days: 14, reward: 40, message: '14-day diary streak — two solid weeks.' },
  { days: 30, reward: 80, message: '30-day diary streak — this is your practice now.' },
];

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
    const { data: streakRow } = await admin
      .from('user_diary_streak')
      .select('current_streak_days, last_day')
      .eq('user_id', userId)
      .maybeSingle();

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
    const { data: existing } = await admin
      .from('oasis_events')
      .select('id')
      .eq('topic', 'diary.streak_celebrated')
      .gte('created_at', since)
      .filter('metadata->>user_id', 'eq', userId)
      .filter('metadata->>streak_days', 'eq', String(tier.days))
      .limit(1);
    if (Array.isArray(existing) && existing.length > 0) {
      // Already celebrated this tier today — skip the credit + event but
      // still return the payload so voice/toast can mention it idly if
      // they want. Caller can ignore it.
      return null;
    }

    // Wallet credit — mirror the autopilot onboarding pattern.
    try {
      await admin.rpc('credit_wallet', {
        p_tenant_id: tenantId,
        p_user_id: userId,
        p_amount: tier.reward,
        p_type: 'reward',
        p_source: 'diary_streak',
        p_source_event_id: `diary_streak_${userId}_${tier.days}_${new Date().toISOString().slice(0, 10)}`,
        p_description: `Diary ${tier.days}-day streak`,
      });
    } catch (walletErr: any) {
      // credit_wallet is best-effort — wallet may dedup on
      // p_source_event_id (idempotent) or be temporarily unavailable.
      // Streak event still fires regardless.
      console.warn(`[diary-streak] credit_wallet failed: ${walletErr?.message ?? walletErr}`);
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
          reward_vtn: tier.reward,
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
      body: `${tier.message} +${tier.reward} VTN credited.`,
      data: {
        url: '/diary',
        streak_days: String(tier.days),
        reward_vtn: String(tier.reward),
      },
    }, admin);

    console.log(`[diary-streak] user=${userId.slice(0, 8)} hit ${tier.days}-day streak +${tier.reward} VTN`);
    return {
      current_streak_days: streak,
      tier_days: tier.days,
      wallet_credit: tier.reward,
      message: tier.message,
    };
  } catch (err: any) {
    console.warn(`[diary-streak] check failed (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}
