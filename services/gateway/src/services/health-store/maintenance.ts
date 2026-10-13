/**
 * VTID-05159 (Health Hub Phase 1 / A2) — the store's maintenance run
 * (POST /api/v1/health/internal/maintenance, EventBridge job
 * gateway-health-store-maintenance at `23 * * * *` UTC, plan Change 11).
 *
 * One invocation: health_store_ensure_partitions(now) -> health_store_purge(now)
 * (both idempotent), plus the daily partition check (health_store_partition_check)
 * on the 02:xx UTC run or when asked, plus a capacity snapshot for the
 * placement re-evaluation triggers (plan Change 4).
 *
 * Structured log lines feed the CloudWatch metric filters of
 * scripts/aws/setup-health-store-alarms.sh:
 *   {"event":"health_store_maintenance","ok":true|false,...}   -> no success for 4 h alarms
 *   {"event":"health_store_partition_check","missing":N,...}   -> missing > 0 alarms
 *   {"event":"health_store_capacity","series_5m_rows_estimate":N,"connected_device_sources":N}
 * OASIS: health.store.maintenance.completed | failed (counts only), and
 * health.store.partition_missing when the daily check finds a gap.
 * Never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { HEALTH_STORE_VTID } from './flags';
import { defaultHealthStoreDeps, emitHealthStoreEvent, storeErrorCode, type HealthStoreDeps } from './ingest';

export interface MaintenanceOptions {
  /** Run the partition check now; default: only on the run in the 02:xx UTC hour. */
  partitionCheck?: boolean;
}

export interface MaintenanceSummary {
  ok: boolean;
  partitions_created: number | null;
  partitions_dropped: number | null;
  rows_purged: number | null;
  missing_partitions: string[] | null;
  errors: string[];
}

export async function runHealthStoreMaintenanceWith(deps: HealthStoreDeps, opts: MaintenanceOptions = {}): Promise<MaintenanceSummary> {
  const summary: MaintenanceSummary = {
    ok: false,
    partitions_created: null,
    partitions_dropped: null,
    rows_purged: null,
    missing_partitions: null,
    errors: [],
  };
  try {
    const now = deps.now();
    const nowIso = now.toISOString();

    const ensured = await deps.repo.ensurePartitions(nowIso);
    if (ensured.error) summary.errors.push(`ensure:${storeErrorCode(ensured.error)}`);
    else summary.partitions_created = typeof ensured.data === 'number' ? ensured.data : Number(ensured.data ?? 0);

    const purged = await deps.repo.purge(nowIso);
    if (purged.error) summary.errors.push(`purge:${storeErrorCode(purged.error)}`);
    else {
      summary.partitions_dropped = Number(purged.data?.partitions_dropped ?? 0);
      summary.rows_purged = Number(purged.data?.rows_purged ?? 0);
    }

    const doCheck = opts.partitionCheck === true || now.getUTCHours() === 2;
    if (doCheck) {
      const check = await deps.repo.partitionCheck(nowIso);
      if (check.error) summary.errors.push(`partition_check:${storeErrorCode(check.error)}`);
      else {
        summary.missing_partitions = (check.data ?? []).map((r) => r.partition_name);
        deps.log({
          event: 'health_store_partition_check',
          vtid: HEALTH_STORE_VTID,
          missing: summary.missing_partitions.length,
          partitions: summary.missing_partitions,
        });
        if (summary.missing_partitions.length > 0) {
          await emitHealthStoreEvent(deps, {
            type: 'health.store.partition_missing',
            status: 'error',
            message: "Health store daily check: tomorrow's partitions are missing.",
            payload: { missing: summary.missing_partitions.length, partitions: summary.missing_partitions },
            actor_role: 'system',
            surface: 'system',
          });
        }
      }

      const cap = await deps.repo.capacitySnapshot();
      if (!cap.error && cap.data) {
        deps.log({ event: 'health_store_capacity', vtid: HEALTH_STORE_VTID, ...cap.data });
      }
    }

    summary.ok = summary.errors.length === 0;
  } catch (err) {
    summary.ok = false;
    summary.errors.push(`exception:${err instanceof Error ? err.name : typeof err}`);
  }

  try {
    deps.log({ event: 'health_store_maintenance', vtid: HEALTH_STORE_VTID, ...summary });
    await emitHealthStoreEvent(deps, {
      type: summary.ok ? 'health.store.maintenance.completed' : 'health.store.maintenance.failed',
      status: summary.ok ? 'success' : 'error',
      message: summary.ok ? 'Health store maintenance run completed.' : 'Health store maintenance run failed.',
      payload: {
        partitions_created: summary.partitions_created,
        partitions_dropped: summary.partitions_dropped,
        rows_purged: summary.rows_purged,
        missing_partitions: summary.missing_partitions?.length ?? null,
        errors: summary.errors,
      },
      actor_role: 'system',
      surface: 'system',
    });
  } catch {
    /* never throw */
  }
  return summary;
}

export function runHealthStoreMaintenance(sb: SupabaseClient, opts: MaintenanceOptions = {}): Promise<MaintenanceSummary> {
  return runHealthStoreMaintenanceWith(defaultHealthStoreDeps(sb), opts);
}
