/**
 * VTID-04868 — Plan Sparring Gate: hourly tamper reconciler (N2, owner
 * decision 1: tampering is DETECTED, not prevented, while execute_sql runs as
 * postgres on Supabase).
 *
 * Read-only. Off unless PLAN_SPARRING_RECONCILER_ENABLED=true. Each run checks:
 *   1. the vtid_ledger BEFORE INSERT trigger exists and is enabled
 *      (pg_trigger.tgenabled = 'O'), via the read-only RPC
 *      plan_sparring_trigger_status() — an unreadable status is itself
 *      reported, never assumed fine;
 *   2. ledger rows created since the last run with no metadata.sparring_id
 *      (rows carrying metadata.sparring_exempt_reason are reported as
 *      break-glass instead);
 *   3. plan_sparring_config changed (or vanished) since the last run.
 * Every detection emits OASIS vtid.plan_sparring.tamper_detected (break-glass
 * rows emit vtid.plan_sparring.break_glass). Nothing is written to the
 * sparring tables or the ledger.
 *
 * State (last run time, last config snapshot) is in memory: after a restart
 * the first run re-baselines the config and looks back one interval.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CicdOasisEvent } from '../../types/cicd';
import * as repo from './plan-sparring-repository';
import { PLAN_SPARRING_VTID } from './plan-sparring-service';

export const RECONCILER_INTERVAL_MS = 60 * 60 * 1000;
const MAX_LISTED_VTIDS = 50;

export interface ReconcilerState {
  lastRunAt: number | null;
  lastConfigSnapshot: string | null;
}

export interface ReconcilerDeps {
  sb: SupabaseClient;
  emit: (event: CicdOasisEvent) => Promise<unknown>;
  now?: () => number;
}

export interface Detection {
  check: 'trigger_disabled' | 'trigger_missing' | 'trigger_status_unreadable' | 'ledger_rows_without_sparring' | 'ledger_read_failed' | 'config_changed' | 'config_missing' | 'config_read_failed' | 'break_glass';
  detail: Record<string, unknown>;
}

export function isReconcilerEnabled(): boolean {
  return process.env.PLAN_SPARRING_RECONCILER_ENABLED === 'true';
}

export function newReconcilerState(): ReconcilerState {
  return { lastRunAt: null, lastConfigSnapshot: null };
}

export async function runPlanSparringReconcile(deps: ReconcilerDeps, state: ReconcilerState): Promise<Detection[]> {
  const now = (deps.now ?? Date.now)();
  const since = new Date(state.lastRunAt ?? now - RECONCILER_INTERVAL_MS).toISOString();
  const detections: Detection[] = [];

  // 1. Trigger enabled?
  const trig = await repo.fetchTriggerStatus(deps.sb);
  if (trig.error) {
    detections.push({ check: 'trigger_status_unreadable', detail: { error: trig.error.message } });
  } else {
    const row = Array.isArray(trig.data) ? trig.data[0] : trig.data;
    if (!row || row.present !== true) detections.push({ check: 'trigger_missing', detail: {} });
    else if (row.tgenabled !== 'O') detections.push({ check: 'trigger_disabled', detail: { tgenabled: row.tgenabled } });
  }

  // 2. Ledger rows without a sparring id since the last run.
  const rows = await repo.fetchLedgerRowsWithoutSparring(deps.sb, since);
  if (rows.error) {
    detections.push({ check: 'ledger_read_failed', detail: { error: rows.error.message } });
  } else {
    const all = rows.data ?? [];
    const exempt = all.filter((r) => typeof r.metadata?.sparring_exempt_reason === 'string');
    const bare = all.filter((r) => typeof r.metadata?.sparring_exempt_reason !== 'string');
    for (const r of exempt) {
      detections.push({ check: 'break_glass', detail: { vtid: r.vtid, reason: r.metadata?.sparring_exempt_reason, created_at: r.created_at } });
    }
    if (bare.length > 0) {
      detections.push({
        check: 'ledger_rows_without_sparring',
        detail: { since, count: bare.length, vtids: bare.slice(0, MAX_LISTED_VTIDS).map((r) => r.vtid) },
      });
    }
  }

  // 3. Config changed?
  const cfg = await repo.fetchConfig(deps.sb);
  if (cfg.error) {
    detections.push({ check: 'config_read_failed', detail: { error: cfg.error.message } });
  } else if (!cfg.data) {
    detections.push({ check: 'config_missing', detail: {} });
    state.lastConfigSnapshot = null;
  } else {
    const snapshot = JSON.stringify(cfg.data, Object.keys(cfg.data).sort());
    if (state.lastConfigSnapshot !== null && state.lastConfigSnapshot !== snapshot) {
      detections.push({ check: 'config_changed', detail: { before: JSON.parse(state.lastConfigSnapshot), after: cfg.data } });
    }
    state.lastConfigSnapshot = snapshot;
  }

  state.lastRunAt = now;

  for (const d of detections) {
    const breakGlass = d.check === 'break_glass';
    const vtid = breakGlass && typeof d.detail.vtid === 'string' ? d.detail.vtid : PLAN_SPARRING_VTID;
    try {
      await deps.emit({
        vtid,
        type: breakGlass ? 'vtid.plan_sparring.break_glass' : 'vtid.plan_sparring.tamper_detected',
        source: 'plan-sparring-reconciler',
        status: breakGlass ? 'warning' : 'error',
        message: breakGlass
          ? `${vtid} inserted with sparring_exempt_reason (break-glass) — post-hoc sparring due within 24h`
          : `Plan Sparring Gate tamper check failed: ${d.check}`,
        payload: { check: d.check, ...d.detail },
        actor_role: 'system',
        surface: 'system',
      });
    } catch (err) {
      console.error(`[plan-sparring-reconciler] emit failed for ${d.check}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (detections.length > 0) {
    console.warn(`[plan-sparring-reconciler] ${detections.length} detection(s): ${detections.map((d) => d.check).join(', ')}`);
  }
  return detections;
}

let timer: NodeJS.Timeout | null = null;

/** Start the hourly loop. Returns false (and does nothing) unless enabled. */
export function startPlanSparringReconciler(depsFactory?: () => ReconcilerDeps): boolean {
  if (!isReconcilerEnabled() || timer) return false;
  const state = newReconcilerState();
  const factory =
    depsFactory ??
    ((): ReconcilerDeps => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getSupabase } = require('../../lib/supabase');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { emitOasisEvent } = require('../oasis-event-service');
      const sb = getSupabase();
      if (!sb) throw new Error('Supabase not configured');
      return { sb, emit: emitOasisEvent };
    });
  const tick = () => {
    let deps: ReconcilerDeps;
    try {
      deps = factory();
    } catch (err) {
      console.error(`[plan-sparring-reconciler] cannot run: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    runPlanSparringReconcile(deps, state).catch((err) =>
      console.error(`[plan-sparring-reconciler] run failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  timer = setInterval(tick, RECONCILER_INTERVAL_MS);
  timer.unref?.();
  return true;
}

/** Test-only. */
export function _stopPlanSparringReconcilerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
