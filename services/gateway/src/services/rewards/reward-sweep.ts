/**
 * VTID-04878 — the VTNA reward sweep: pays every reward a member has earned
 * but not been paid, without depending on the community automation engine
 * (which does not run in production).
 *
 *  - Milestones (first steps + streaks + onboarding at signup) for every real
 *    member, through milestone-service's scan. `quiet` skips the celebration
 *    event — used for the backfill of milestones reached before 2026-10-02.
 *  - live_room_15min and index_new_best, through claim_capped_reward().
 *
 * Production only: staging shares the production database, so a staging
 * gateway must never pay anyone. The sweep refuses before any query unless
 * the environment is production (VITANA_ENV is pinned to 'staging' on the
 * staging task definition).
 *
 * Idempotent by construction (rewardEventId / `<rule>:<ref>` keys), so a
 * partial or repeated run never pays twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { scanUserMilestonesDetailed } from '../milestone-service';
import { claimCappedReward } from './capped-reward';
import { capWindowStart } from './vtna-reward-rules';
import * as repo from './reward-sweep-repository';

export const SWEEP_PAGE_SIZE = 100;
export const SWEEP_DEFAULT_BUDGET_MS = 10 * 60_000;
/** Look back past the week boundary so a Sunday-night stay is still swept. */
export const SWEEP_LOOKBACK_GRACE_MS = 7 * 3_600_000;

export interface RewardSweepOptions {
  quiet: boolean;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
}

export interface RewardSweepSummary {
  ok: boolean;
  error?: 'NOT_PRODUCTION' | 'DISABLED' | 'BUDGET_EXHAUSTED';
  mode: 'backfill' | 'scheduled';
  members_scanned: number;
  milestones_found: number;
  milestones_recorded: number;
  record_failures: number;
  live_room_claims: number;
  index_claims: number;
  vtna_credited: number;
  credit_failures: number;
  query_failures: number;
  complete: boolean;
}

/** Only a production gateway may pay. Staging pins VITANA_ENV=staging. */
export function rewardSweepAllowed(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; error: 'NOT_PRODUCTION' | 'DISABLED' } {
  if (env.VITANA_ENV === 'staging') return { ok: false, error: 'NOT_PRODUCTION' };
  if (env.REWARD_SWEEP_ENABLED === 'false') return { ok: false, error: 'DISABLED' };
  return { ok: true };
}

/** The in-process loop additionally runs only inside AWS ECS, never on a laptop. */
export function rewardSweepLoopAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return rewardSweepAllowed(env).ok && !!env.ECS_CONTAINER_METADATA_URI_V4;
}

export async function runRewardSweep(sb: SupabaseClient, opts: RewardSweepOptions): Promise<RewardSweepSummary> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budget = opts.budgetMs ?? SWEEP_DEFAULT_BUDGET_MS;
  const summary: RewardSweepSummary = {
    ok: true, mode: opts.quiet ? 'backfill' : 'scheduled',
    members_scanned: 0, milestones_found: 0, milestones_recorded: 0, record_failures: 0,
    live_room_claims: 0, index_claims: 0, vtna_credited: 0, credit_failures: 0, query_failures: 0,
    complete: false,
  };

  const allowed = rewardSweepAllowed(env);
  if (!allowed.ok) return { ...summary, ok: false, error: allowed.error };

  const overBudget = () => Date.now() - started > budget;

  // 1. Milestones, member by member.
  let after: string | null = null;
  for (;;) {
    if (overBudget()) return { ...summary, ok: false, error: 'BUDGET_EXHAUSTED' };
    const { data, error } = await repo.fetchSweepMembers(sb, after, SWEEP_PAGE_SIZE);
    if (error) {
      summary.query_failures++;
      console.error(`[reward-sweep] member page after ${after ?? 'start'} failed: ${error.message}`);
      break;
    }
    const page = (data ?? []) as Array<{ user_id: string; tenant_id: string }>;
    for (const m of page) {
      if (overBudget()) return { ...summary, ok: false, error: 'BUDGET_EXHAUSTED' };
      try {
        const r = await scanUserMilestonesDetailed(sb, m.user_id, m.tenant_id, { quiet: opts.quiet });
        summary.members_scanned++;
        summary.milestones_found += r.milestones.length;
        summary.milestones_recorded += r.recorded;
        summary.record_failures += r.record_failures;
        summary.vtna_credited += r.vtna_credited;
        summary.credit_failures += r.credit_failures;
      } catch (err: any) {
        summary.query_failures++;
        console.error(`[reward-sweep] milestone scan failed for ${m.user_id.slice(0, 8)}…: ${err?.message ?? err}`);
      }
    }
    if (page.length < SWEEP_PAGE_SIZE) break;
    after = page[page.length - 1].user_id;
  }

  // 2. Capped rules, from this ISO week (plus a grace period) only, so an
  //    occurrence from last week can never be paid against a new week's cap.
  const since = new Date(capWindowStart('week', now).getTime() - SWEEP_LOOKBACK_GRACE_MS);

  const live = await repo.fetchLiveRoomCandidates(sb, since.toISOString());
  if (live.error) {
    summary.query_failures++;
    console.error(`[reward-sweep] live room candidates failed: ${live.error.message}`);
  }
  for (const c of (live.data ?? []) as Array<{ user_id: string; tenant_id: string | null; attendance_id: string }>) {
    if (overBudget()) return { ...summary, ok: false, error: 'BUDGET_EXHAUSTED' };
    const r = await claimCappedReward(sb, { tenantId: c.tenant_id, userId: c.user_id, ruleId: 'live_room_15min', ref: c.attendance_id }, env);
    if (r.outcome === 'claimed') { summary.live_room_claims++; summary.vtna_credited += r.credited; }
    if (r.outcome === 'failed') summary.credit_failures++;
  }

  const idx = await repo.fetchIndexCandidates(sb, since.toISOString().slice(0, 10));
  if (idx.error) {
    summary.query_failures++;
    console.error(`[reward-sweep] index candidates failed: ${idx.error.message}`);
  }
  for (const c of (idx.data ?? []) as Array<{ user_id: string; tenant_id: string | null; score_date: string }>) {
    if (overBudget()) return { ...summary, ok: false, error: 'BUDGET_EXHAUSTED' };
    const r = await claimCappedReward(sb, { tenantId: c.tenant_id, userId: c.user_id, ruleId: 'index_new_best', ref: c.score_date }, env);
    if (r.outcome === 'claimed') { summary.index_claims++; summary.vtna_credited += r.credited; }
    if (r.outcome === 'failed') summary.credit_failures++;
  }

  summary.complete = true;
  return summary;
}
