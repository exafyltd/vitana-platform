import type { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  fetchVoiceBudgetWatch,
  AT_RISK_PCT,
  OVERFLOW_PCT,
  type VoiceBudgetRow,
} from './voice-budget-watch';

/**
 * Phase D (DEV-COMHU voice budget watch) — nightly cron.
 *
 * Runs at ~03:00 UTC. Queries the same budget data as the admin route and emits OASIS
 * events so we can alert on heavy users BEFORE they overflow Vertex setup:
 *   - pct_of_cap >= 70  → `voice.instruction.budget_at_risk` (warning)
 *   - pct_of_cap >= 100 → `voice.instruction.budget_overflow` (error; P2 trigger)
 *
 * The emit logic is factored into `runVoiceInstructionBudgetWatch` so it is unit-tested
 * against a mocked Supabase + injected emitter (no live DB / OASIS in CI).
 */

const VTID = 'DEV-COMHU-voice-budget-watch';
const SOURCE = 'voice-instruction-budget-watch';

export interface BudgetWatchEmitter {
  (event: Parameters<typeof emitOasisEvent>[0]): unknown;
}

export interface RunVoiceBudgetWatchDeps {
  supabase: SupabaseClient;
  /** Injectable for tests; defaults to the real OASIS emitter. */
  emit?: BudgetWatchEmitter;
  /** How many rows to scan. */
  limit?: number;
}

export interface RunVoiceBudgetWatchResult {
  scanned: number;
  atRisk: number;
  overflow: number;
}

/**
 * Scan budget usage and emit at-risk / overflow OASIS events. Returns counts so the
 * caller (cron tick) can log a single summary line. Never throws past the emitter —
 * a single emit failure must not abort the whole scan.
 */
export async function runVoiceInstructionBudgetWatch(
  deps: RunVoiceBudgetWatchDeps,
): Promise<RunVoiceBudgetWatchResult> {
  const emit = deps.emit ?? emitOasisEvent;
  // min_pct = AT_RISK so we only fetch users worth alerting on.
  const rows: VoiceBudgetRow[] = await fetchVoiceBudgetWatch(deps.supabase, {
    limit: deps.limit ?? 200,
    minPct: AT_RISK_PCT,
  });

  let atRisk = 0;
  let overflow = 0;

  for (const row of rows) {
    const isOverflow = row.pct_of_cap >= OVERFLOW_PCT;
    const isAtRisk = !isOverflow && row.pct_of_cap >= AT_RISK_PCT;
    if (!isOverflow && !isAtRisk) continue;

    if (isOverflow) overflow += 1;
    else atRisk += 1;

    try {
      await emit({
        vtid: VTID,
        type: isOverflow
          ? 'voice.instruction.budget_overflow'
          : 'voice.instruction.budget_at_risk',
        source: SOURCE,
        status: isOverflow ? 'error' : 'warning',
        message: isOverflow
          ? `voice instruction budget OVERFLOW for ${row.vitana_id ?? row.user_id} (${row.pct_of_cap}% of cap)`
          : `voice instruction budget at risk for ${row.vitana_id ?? row.user_id} (${row.pct_of_cap}% of cap)`,
        payload: {
          user_id: row.user_id,
          vitana_id: row.vitana_id,
          pct_of_cap: row.pct_of_cap,
          memory_chars: row.memory_chars,
          memory_items: row.memory_items,
          memory_facts: row.memory_facts,
        },
        vitana_id: row.vitana_id,
      });
    } catch (err) {
      // Surface but never abort the scan on a single emit failure.
      console.warn(
        `[${SOURCE}] emit failed for ${row.user_id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { scanned: rows.length, atRisk, overflow };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds from `now` until the next occurrence of `hourUtc:00` UTC. */
export function msUntilNextUtcHour(hourUtc: number, now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setTime(next.getTime() + DAY_MS);
  }
  return next.getTime() - now.getTime();
}

/**
 * Schedule the nightly run at 03:00 UTC. Returns a stop() handle. Safe no-op-ish when
 * Supabase is unavailable (logs and skips each tick).
 */
export function startVoiceInstructionBudgetWatchCron(
  getSupabase: () => SupabaseClient | null,
  hourUtc = 3,
): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    const supabase = getSupabase();
    if (!supabase) {
      console.warn(`[${SOURCE}] supabase unavailable; skipping tick`);
      return;
    }
    try {
      const res = await runVoiceInstructionBudgetWatch({ supabase });
      console.log(`[${SOURCE}] scan complete`, JSON.stringify(res));
    } catch (err) {
      console.warn(
        `[${SOURCE}] scan failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const startTimeout = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), DAY_MS);
  }, msUntilNextUtcHour(hourUtc));

  return () => {
    clearTimeout(startTimeout);
    if (interval) clearInterval(interval);
  };
}
