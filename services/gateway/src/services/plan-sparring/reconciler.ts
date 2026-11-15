/**
 * VTID-04868 — Plan Sparring: hourly integrity reconciler (N2, owner decision 1:
 * tampering is DETECTED, not prevented, while execute_sql runs as postgres).
 *
 * Read-only. Off unless PLAN_SPARRING_RECONCILER_ENABLED=true. Each run checks:
 *   1. plan_sparring_config changed (or vanished) since the last run;
 *   2. (VTID-05214) a session carries a policy approval although it is not converged — impossible while the table's
 *      CHECK stands, so a hit means the constraint was tampered with.
 * VTID-05800 (owner decision 2026-11-15: anyone may allocate a VTID at any time) removed the two checks that enforced
 * "no VTID without sparring": the vtid_ledger trigger (dropped by migration 20261115090000) and ledger rows without a
 * sparring id (normal now). Every detection emits OASIS vtid.plan_sparring.tamper_detected. Nothing is written to the
 * sparring tables or the ledger.
 *
 * State (last run time, last config snapshot) is in memory: after a restart
 * the first run re-baselines the config.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CicdOasisEvent } from '../../types/cicd';
import * as repo from './plan-sparring-repository';
import { PLAN_SPARRING_VTID } from './plan-sparring-service';

export const RECONCILER_INTERVAL_MS = 60 * 60 * 1000;

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
  check: 'config_changed' | 'config_missing' | 'config_read_failed' | 'policy_approval_on_non_converged' | 'policy_approval_read_failed';
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
  const detections: Detection[] = [];

  // 1. Config changed?
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

  // 2. Policy approval on a session that is not converged (VTID-05214).
  const pol = await repo.fetchPolicyApprovedNonConverged(deps.sb);
  if (pol.error) detections.push({ check: 'policy_approval_read_failed', detail: { error: pol.error.message } });
  else if ((pol.data ?? []).length > 0) {
    detections.push({ check: 'policy_approval_on_non_converged', detail: { sessions: (pol.data ?? []).map((s) => ({ id: s.id, verdict: s.verdict })) } });
  }

  state.lastRunAt = now;

  for (const d of detections) {
    try {
      await deps.emit({
        vtid: PLAN_SPARRING_VTID,
        type: 'vtid.plan_sparring.tamper_detected',
        source: 'plan-sparring-reconciler',
        status: 'error',
        message: `Plan Sparring integrity check failed: ${d.check}`,
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
