/**
 * VTID-05161 (Health Hub Phase 1 / B1) — B Change 5: the read-only reconciler.
 *
 * Once a day, while the dual-write or the read switch is on, it counts both
 * connection models per kind and status (SQL health_sources_reconcile_counts(),
 * service_role only, counts only) and emits OASIS `health.sources.reconcile`
 * with those counts — no member ids, no health data. A non-zero
 * `mismatch.total` blocks the B1 read-switch Gate 2; seven clean days in a row
 * are its precondition.
 *
 * It runs from the existing nightly daily-recompute scheduler call (first batch
 * of a run, cursor null) — no new route, no new EventBridge rule — at most once
 * per UTC date per gateway task, fire-and-forget. It never changes the
 * scheduler's response, and it writes nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from '../oasis-event-service';
import { isHealthSourcesStoreMissing } from './health-sources';
import { isHealthSourcesDualWriteEnabled } from './legacy-mirror';
import { isHealthSourcesReadEnabled } from './read-model';
import * as repo from './health-sources-repository';

export interface ReconcileCounts {
  legacy_connections: Array<{ kind: string; status: string; n: number }>;
  legacy_integrations: Array<{ kind: string; status: string; n: number }>;
  sources: Array<{ kind: string; status: string; n: number }>;
  mismatch: {
    connections_unlinked: number;
    integrations_unlinked: number;
    integrations_no_tenant: number;
    integrations_unmapped: number;
    status_mismatch: number;
    orphaned_sources: number;
    total: number;
  };
  computed_at: string;
}

export type ReconcileResult =
  | { ok: true; counts: ReconcileCounts }
  | { ok: false; code: 'STORE_PENDING' | 'STORE_UNAVAILABLE' | 'RECONCILE_THREW' };

export function isHealthSourcesReconcileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHealthSourcesDualWriteEnabled(env) || isHealthSourcesReadEnabled(env);
}

export async function runHealthSourcesReconcile(sb: SupabaseClient): Promise<ReconcileResult> {
  try {
    const { data, error } = await repo.rpcReconcileCounts(sb);
    if (error) {
      const code = isHealthSourcesStoreMissing(error) ? 'STORE_PENDING' : 'STORE_UNAVAILABLE';
      console.warn(JSON.stringify({ event: 'health_sources_reconcile_failed', vtid: 'VTID-05161', code }));
      return { ok: false, code };
    }
    const counts = data as ReconcileCounts;
    await emitOasisEvent({
      vtid: 'VTID-05161',
      type: 'health.sources.reconcile',
      source: 'gateway',
      status: counts?.mismatch?.total === 0 ? 'info' : 'warning',
      message: `health_sources reconcile: mismatch ${counts?.mismatch?.total ?? 'unknown'}`,
      payload: {
        legacy_connections: counts?.legacy_connections ?? [],
        legacy_integrations: counts?.legacy_integrations ?? [],
        sources: counts?.sources ?? [],
        mismatch: counts?.mismatch ?? null,
      },
    }).catch(() => {});
    return { ok: true, counts };
  } catch {
    return { ok: false, code: 'RECONCILE_THREW' };
  }
}

let lastRunDate: string | null = null;

/** Test hook. */
export function resetHealthSourcesReconcileSchedule(): void {
  lastRunDate = null;
}

/**
 * Called by the nightly scheduler route. Returns the run's promise (callers do
 * not await it), or null when it does not run: flag off / staging, not the
 * first batch of a run, or already run for this UTC date in this process.
 */
export function maybeRunNightlyHealthSourcesReconcile(
  sb: SupabaseClient | null | undefined,
  opts: { cursor: string | null | undefined; now?: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReconcileResult> | null {
  if (!sb || !isHealthSourcesReconcileEnabled(env) || opts.cursor) return null;
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  if (lastRunDate === date) return null;
  lastRunDate = date;
  return runHealthSourcesReconcile(sb);
}
