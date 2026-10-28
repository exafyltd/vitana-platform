/**
 * VTID-04878 — runs the reward sweep and reports it: one OASIS event per run
 * (`rewards.milestone_sweep.completed`, or `.failed`), never per member.
 * The in-process loop (index.ts) uses lastSweepAt() so that only one gateway
 * task sweeps per interval; concurrent sweeps would still never pay twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from '../oasis-event-service';
import { runRewardSweep, RewardSweepOptions, RewardSweepSummary } from './reward-sweep';

export const SWEEP_VTID = 'VTID-04878';
export const SWEEP_TOPIC_COMPLETED = 'rewards.milestone_sweep.completed';
export const SWEEP_TOPIC_FAILED = 'rewards.milestone_sweep.failed';
export const SWEEP_LOOP_INTERVAL_MS = 6 * 3_600_000;
export const SWEEP_LOOP_MIN_GAP_MS = 5 * 3_600_000;

export async function runAndReportRewardSweep(
  sb: SupabaseClient,
  opts: RewardSweepOptions & { trigger: 'manual' | 'loop' },
): Promise<RewardSweepSummary> {
  const summary = await runRewardSweep(sb, opts);
  // A refusal on staging is not a run — nothing to report.
  if (summary.error === 'NOT_PRODUCTION' || summary.error === 'DISABLED') return summary;

  const failed = !summary.ok || summary.credit_failures > 0 || summary.query_failures > 0;
  await emitOasisEvent({
    vtid: SWEEP_VTID,
    type: (failed ? SWEEP_TOPIC_FAILED : SWEEP_TOPIC_COMPLETED) as any,
    source: 'reward-sweep',
    status: failed ? 'warning' : 'success',
    message: `VTNA reward sweep (${summary.mode}, ${opts.trigger}): ${summary.members_scanned} members, `
      + `${summary.milestones_found} milestones, ${summary.vtna_credited} VTNA credited`
      + (failed ? `, ${summary.credit_failures} credit / ${summary.query_failures} query failures` : ''),
    payload: { ...summary, trigger: opts.trigger },
  }).catch((e: any) => console.warn(`[reward-sweep] OASIS emit failed: ${e?.message ?? e}`));
  return summary;
}

/** When the last sweep (completed or failed) was reported, or null. */
export async function lastSweepAt(sb: SupabaseClient): Promise<Date | null> {
  const { data, error } = await sb
    .from('oasis_events')
    .select('created_at')
    .in('topic', [SWEEP_TOPIC_COMPLETED, SWEEP_TOPIC_FAILED])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn(`[reward-sweep] reading the last sweep failed: ${error.message}`);
    return null;
  }
  const row = (data ?? [])[0] as { created_at?: string } | undefined;
  return row?.created_at ? new Date(row.created_at) : null;
}

/** One loop tick: sweeps unless another task swept within the last 5 hours. */
export async function rewardSweepTick(sb: SupabaseClient, now: Date = new Date()): Promise<RewardSweepSummary | null> {
  const last = await lastSweepAt(sb);
  if (last && now.getTime() - last.getTime() < SWEEP_LOOP_MIN_GAP_MS) return null;
  return runAndReportRewardSweep(sb, { quiet: false, trigger: 'loop', now });
}

/** First tick after boot: lets a rolling deploy settle before anyone sweeps. */
export const SWEEP_LOOP_FIRST_DELAY_MS = 15 * 60_000;

/**
 * Starts the production loop: every 6 hours, only inside AWS ECS and only on
 * production (rewardSweepLoopAllowed). Returns whether it started.
 */
export function startRewardSweepLoop(
  getClient: () => SupabaseClient | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Lazy import keeps the env check here, next to the loop it gates.
  const { rewardSweepLoopAllowed } = require('./reward-sweep') as typeof import('./reward-sweep');
  if (!rewardSweepLoopAllowed(env)) return false;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sb = getClient();
      if (sb) await rewardSweepTick(sb);
    } catch (err: any) {
      console.error(`[reward-sweep] loop tick failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void tick(); }, SWEEP_LOOP_FIRST_DELAY_MS).unref?.();
  setInterval(() => { void tick(); }, SWEEP_LOOP_INTERVAL_MS).unref?.();
  return true;
}
