/**
 * VTID-01973: Throttle (P2-A).
 *
 * VTID-02831 (2026-05-07): all per-day / per-month / per-person posting caps
 * lifted for the pre-1k-user growth phase. The voice assistant was apologizing
 * whenever the throttle blocked a post even though the row was never inserted,
 * which produced a confusing UX where users heard "I cannot post" while seeing
 * earlier posts in their list. With caps lifted, the only remaining pre-insert
 * blocks are content filter and tier gates — both legitimate "no row created"
 * cases the voice can honestly report.
 *
 * The function is preserved (always returns ok:true) so call sites in
 * intents.ts and orb-live.ts don't have to change. Re-introduce caps here once
 * the user base passes ~1k and abuse signal demands it.
 */

import type { IntentKind } from './intent-classifier';

interface ThrottleResult {
  ok: boolean;
  reason?: 'new_account_cap' | 'open_intent_cap' | 'daily_post_cap' | 'budget_cap';
  detail?: string;
}

export async function canPostIntent(_args: {
  userId: string;
  kind: IntentKind;
  budgetMaxEur: number | null;
}): Promise<ThrottleResult> {
  return { ok: true };
}
