// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note:
// the one referencing test (test/save-diary-entry-shared.test.ts)
// wholesale jest.mocks diary-streak-celebrator.ts — zero genuine
// coverage today.
/**
 * services/diary-streak-celebrator.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * diary-streak-celebrator.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same filters, same params, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 *
 * Money-adjacent: creditWallet wraps the credit_wallet RPC. No
 * money-moving logic lives here — this is a pure pass-through of the
 * same params the source already built.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserDiaryStreak(sb: SupabaseClient, userId: string) {
  return sb.from('user_diary_streak').select('current_streak_days, last_day').eq('user_id', userId).maybeSingle();
}

export async function fetchExistingStreakCelebrationEvent(
  sb: SupabaseClient,
  userId: string,
  streakDays: number,
  sinceIso: string,
) {
  return sb
    .from('oasis_events')
    .select('id')
    .eq('topic', 'diary.streak_celebrated')
    .gte('created_at', sinceIso)
    .filter('metadata->>user_id', 'eq', userId)
    .filter('metadata->>streak_days', 'eq', String(streakDays))
    .limit(1);
}

export async function creditWallet(
  sb: SupabaseClient,
  args: {
    p_tenant_id: string;
    p_user_id: string;
    p_amount: number;
    p_type: string;
    p_source: string;
    p_source_event_id: string;
    p_description: string;
  },
) {
  return sb.rpc('credit_wallet', args);
}
