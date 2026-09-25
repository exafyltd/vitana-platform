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
import * as repo from './active-usage-repository';

const LOG_PREFIX = '[Guide:active-usage]';

// VTID-04543: per-process throttle. The auth middleware calls
// upsertActiveDay() on EVERY authenticated request, and an ORB voice session
// over SSE sends one request per 64 ms mic frame (~15/s) — so the same
// (user_id, UTC date) row was upserted thousands of times a day even though
// only the first write can change anything (the PK dedupes the rest).
//
// Rules:
//   - The first call for a (user, UTC date) runs exactly as before.
//   - A user is only marked "recorded" after a write that returned no error,
//     so a failed or thrown write is retried by the next request.
//   - Concurrent calls for the same (user, date) share the one in-flight write.
//   - The recorded set is cleared when the UTC date changes, so memory is
//     bounded by the users active on one day in this process.
// Another process (another ECS task) keeps its own set — at most one write
// per user per day per task, still idempotent at the DB.
let recordedDate: string | null = null;
const recordedUsers = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

/** Test-only: forget the per-process throttle state. */
export function __resetActiveDayThrottleForTests(): void {
  recordedDate = null;
  recordedUsers.clear();
  inFlight.clear();
}

/**
 * Record that the user is active today. Idempotent per (user_id, UTC date)
 * via the table's composite primary key and ON CONFLICT DO NOTHING.
 *
 * Fire-and-forget from the caller's perspective — the auth middleware cannot
 * block on this. Errors are swallowed silently (warn-logged) because a DB
 * outage must not break authentication.
 *
 * VTID-04543: at most one successful write per user per UTC date per process
 * (see the throttle notes above).
 */
export async function upsertActiveDay(userId: string): Promise<void> {
  if (!userId) return;
  const supabase = getSupabase();
  if (!supabase) return;

  const activeDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  if (recordedDate !== activeDate) {
    recordedDate = activeDate;
    recordedUsers.clear();
  }
  if (recordedUsers.has(userId)) return;

  const key = `${userId}|${activeDate}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const write = (async () => {
    const { error } = await repo.upsertActiveUsageDay(supabase, userId, activeDate);

    if (error) {
      console.warn(`${LOG_PREFIX} upsert failed for user=${userId.substring(0, 8)}:`, error.message);
      return;
    }
    if (recordedDate === activeDate) recordedUsers.add(userId);
  })();
  inFlight.set(key, write);
  try {
    await write;
  } finally {
    inFlight.delete(key);
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

  const { count, error } = await repo.countActiveUsageDaysForUser(supabase, userId);

  if (error) {
    console.warn(`${LOG_PREFIX} count failed for user=${userId.substring(0, 8)}:`, error.message);
    return 0;
  }

  return count ?? 0;
}
