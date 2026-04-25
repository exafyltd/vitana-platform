/**
 * Proactive Guide — Active Usage-Days Tracker (BOOTSTRAP-DYK-TOUR)
 *
 * Backs the "30 days of USAGE, not calendar days" rule for the Did-You-Know
 * tour curriculum. Every authenticated gateway request calls upsertActiveDay()
 * fire-and-forget, which inserts one row per (user_id, UTC date) into
 * public.user_active_days. The composite PK dedupes same-day requests.
 *
 * resolveNextTip() in tip-curriculum reads countActiveUsageDays() to decide
 * which tip is eligible. A user who signs up, returns a month later, and
 * has two active-day rows is on usage-day 2 — not day 31.
 *
 * Plan: .claude/plans/proactive-did-you-generic-sifakis.md
 */

import { getSupabase } from '../../lib/supabase';

const LOG_PREFIX = '[Guide:active-usage]';

/**
 * Record that the user is active today. Idempotent per (user_id, UTC date)
 * via the table's composite primary key and ON CONFLICT DO NOTHING.
 *
 * Fire-and-forget from the caller's perspective — the auth middleware cannot
 * block on this. Errors are swallowed silently (warn-logged) because a DB
 * outage must not break authentication.
 */
export async function upsertActiveDay(userId: string): Promise<void> {
  if (!userId) return;
  const supabase = getSupabase();
  if (!supabase) return;

  const activeDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const { error } = await supabase
    .from('user_active_days')
    .upsert(
      { user_id: userId, active_date: activeDate },
      { onConflict: 'user_id,active_date', ignoreDuplicates: true },
    );

  if (error) {
    console.warn(`${LOG_PREFIX} upsert failed for user=${userId.substring(0, 8)}:`, error.message);
  }
}

/**
 * Count distinct UTC dates the user was authenticated-active. Drives the
 * tour curriculum gating: `active_usage_days > 30` disables all tour tips.
 *
 * Returns 0 on any error — worst case the resolver treats the user as
 * brand-new, which is a safer default than silently tripping the 30-day
 * guardrail for a real user.
 */
export async function countActiveUsageDays(userId: string): Promise<number> {
  if (!userId) return 0;
  const supabase = getSupabase();
  if (!supabase) return 0;

  const { count, error } = await supabase
    .from('user_active_days')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) {
    console.warn(`${LOG_PREFIX} count failed for user=${userId.substring(0, 8)}:`, error.message);
    return 0;
  }

  return count ?? 0;
}
