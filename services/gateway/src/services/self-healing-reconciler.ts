/**
 * Self-Healing Reconciler
 *
 * Periodic safety net that resolves orphaned self_healing_log rows.
 * A row is orphaned when outcome='pending' for longer than the stale
 * threshold — typically because the autopilot event loop's cursor slipped
 * past the spec.created event, or the dispatch action failed silently and
 * left no trace. Without this reconciler, such rows sit in 'pending' forever
 * and the Self-Healing History tab shows permanent hourglass spinners.
 *
 * Per stale row the reconciler:
 *   1. Re-probes the endpoint.
 *      - healthy now → mark outcome='escalated', reason='recovered_externally'
 *      - still down  → mark outcome='escalated', reason='stale_no_progress'
 *   2. Emits a self-healing.reconciled OASIS event for the Command Hub
 *      timeline so operators see the reconciliation happened.
 *
 * This service does NOT re-drive fixes. It only clears stuck state.
 * Operators can re-report a failure via collect-status.py on the next run
 * if the underlying problem still needs attention.
 */

import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
const LOG_PREFIX = '[self-healing-reconciler]';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const BATCH_LIMIT = 50;

let reconcilerTimer: NodeJS.Timeout | null = null;
let running = false;
let cycleInFlight = false;

interface StaleRow {
  id: string;
  vtid: string;
  endpoint: string;
  failure_class: string;
  created_at: string;
  diagnosis: Record<string, unknown> | null;
}

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

async function fetchStaleRows(thresholdMs: number): Promise<StaleRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/self_healing_log` +
    `?select=id,vtid,endpoint,failure_class,created_at,diagnosis` +
    `&outcome=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}` +
    `&order=created_at.asc&limit=${BATCH_LIMIT}`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`${LOG_PREFIX} Failed to fetch stale rows: ${res.status} ${text.slice(0, 200)}`);
    return [];
  }
  return (await res.json()) as StaleRow[];
}

async function probeEndpoint(
  endpoint: string,
): Promise<{ healthy: boolean; http_status: number | null }> {
  try {
    const res = await fetch(`${GATEWAY_URL}${endpoint}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { healthy: res.ok, http_status: res.status };
  } catch {
    return { healthy: false, http_status: null };
  }
}

async function markEscalated(
  row: StaleRow,
  reason: 'recovered_externally' | 'stale_no_progress',
  httpStatus: number | null,
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  const now = new Date().toISOString();
  const mergedDiagnosis = {
    ...(row.diagnosis || {}),
    reconciled_at: now,
    reconciled_reason: reason,
    reconciled_probe_http_status: httpStatus,
  };
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${row.id}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        outcome: 'escalated',
        resolved_at: now,
        diagnosis: mergedDiagnosis,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `${LOG_PREFIX} Failed to patch ${row.vtid}: ${res.status} ${text.slice(0, 200)}`,
    );
    return false;
  }
  return true;
}

async function runReconcileCycle(thresholdMs: number): Promise<void> {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    const rows = await fetchStaleRows(thresholdMs);
    if (rows.length === 0) return;
    console.log(`${LOG_PREFIX} Found ${rows.length} stale row(s) to reconcile`);
    for (const row of rows) {
      const { healthy, http_status } = await probeEndpoint(row.endpoint);
      const reason = healthy ? 'recovered_externally' : 'stale_no_progress';
      const ok = await markEscalated(row, reason, http_status);
      if (!ok) continue;
      const ageHours = (Date.now() - new Date(row.created_at).getTime()) / 3600000;
      try {
        await emitOasisEvent({
          vtid: row.vtid,
          type: 'self-healing.reconciled',
          source: 'self-healing-reconciler',
          status: healthy ? 'info' : 'warning',
          message: `Reconciler escalated stuck self-healing task — ${reason} (${row.endpoint} HTTP ${http_status ?? 'err'})`,
          payload: {
            endpoint: row.endpoint,
            failure_class: row.failure_class,
            reason,
            http_status,
            age_hours: Number(ageHours.toFixed(2)),
          },
          actor_role: 'system',
          surface: 'system',
        });
      } catch (emitErr) {
        console.warn(`${LOG_PREFIX} Failed to emit OASIS event for ${row.vtid}:`, emitErr);
      }
      console.log(
        `${LOG_PREFIX} Reconciled ${row.vtid}: ${reason} (age=${ageHours.toFixed(1)}h)`,
      );
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Cycle error:`, err);
  } finally {
    cycleInFlight = false;
  }
}

export function startReconciler(): void {
  if (running) {
    console.log(`${LOG_PREFIX} Already running`);
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn(`${LOG_PREFIX} Supabase credentials missing, reconciler not started`);
    return;
  }
  const intervalMs = parseInt(
    process.env.SELF_HEALING_RECONCILER_INTERVAL_MS || String(DEFAULT_INTERVAL_MS),
    10,
  );
  const thresholdMs = parseInt(
    process.env.SELF_HEALING_STALE_THRESHOLD_MS || String(DEFAULT_STALE_THRESHOLD_MS),
    10,
  );
  running = true;
  setTimeout(() => void runReconcileCycle(thresholdMs), 30_000);
  reconcilerTimer = setInterval(() => void runReconcileCycle(thresholdMs), intervalMs);
  console.log(
    `🩹 Self-healing reconciler started (interval=${intervalMs}ms, stale_threshold=${thresholdMs}ms)`,
  );
}

export function stopReconciler(): void {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
  }
  running = false;
  console.log(`${LOG_PREFIX} Stopped`);
}
