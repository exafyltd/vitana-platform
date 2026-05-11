/**
 * Self-Healing Reconciler
 *
 * Periodic safety net that resolves orphaned self_healing_log rows.
 * A row is orphaned when outcome='pending' for longer than the stale
 * threshold — typically because the autopilot event loop's cursor slipped
 * past the spec.created event, or the dispatch action failed silently and
 * left no trace.
 *
 * Per stale row the reconciler:
 *   1. Re-probes the endpoint.
 *      - healthy now → mark outcome='escalated', reason='recovered_externally'
 *      - still down  → try to re-dispatch the existing fix spec to the
 *        worker orchestrator (capped at MAX_REDISPATCH_ATTEMPTS, gated by
 *        MIN_REDISPATCH_INTERVAL_MS so we don't pile on a worker that's
 *        already running). Only after exhausting redispatches do we mark
 *        the row outcome='escalated', reason='stale_no_progress'.
 *   2. Emits self-healing.reconciled (terminal) or
 *      self-healing.dispatch.retried (re-drive) OASIS events.
 */

import { emitOasisEvent } from './oasis-event-service';
import { notifyGChat } from './self-healing-snapshot-service';
import {
  spawnTriageAgent,
  createFreshVtidFromTriageReport,
  MAX_TRIAGE_ATTEMPTS,
} from './self-healing-triage-service';
import { runVoiceProbe } from './voice-synthetic-probe';
import { triggerRollbackRecommendation } from './voice-auto-rollback';
import { recordSpecMemory } from './voice-spec-memory';
import { getVoiceSpecHint, parseVoiceClassFromEndpoint } from './voice-spec-hints';
import { appendVerdict, evaluateAndQuarantine } from './voice-recurrence-sentinel';
import { probeEndpoint as sharedProbeEndpoint } from './self-healing-probe';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
const COMMAND_HUB_SH_URL =
  process.env.COMMAND_HUB_SH_URL ||
  'https://gateway-q74ibpv6ia-uc.a.run.app/command-hub/infrastructure/self-healing';
const LOG_PREFIX = '[self-healing-reconciler]';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const BATCH_LIMIT = 50;
// Re-dispatch budget per row before we give up and tombstone as stale.
// Auto-fix path already does 3 attempts on first dispatch; reconciler
// adds 2 more spread across cycles, so total worst-case is 5 attempts.
const MAX_REDISPATCH_ATTEMPTS = 2;
// Minimum gap between successive redispatches for the same row, so we
// don't slam the worker if it's still processing the previous attempt.
const MIN_REDISPATCH_INTERVAL_MS = 30 * 60 * 1000;
const DISPATCH_TIMEOUT_MS = 10_000;

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
  attempt_number: number | null;
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
    `?select=id,vtid,endpoint,failure_class,created_at,diagnosis,attempt_number` +
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
  const result = await sharedProbeEndpoint(endpoint, {
    timeoutMs: PROBE_TIMEOUT_MS,
    gatewayUrl: GATEWAY_URL,
  });
  return { healthy: result.healthy, http_status: result.http_status };
}

/**
 * Try to re-dispatch a stuck row to the worker orchestrator. Returns
 * `redispatched` if we successfully POSTed a new run, `skipped` if the
 * row is over the attempt cap or hit too recently, or `failed` if the
 * fetch errored / returned non-OK.
 */
async function attemptRedispatch(
  row: StaleRow,
): Promise<{ status: 'redispatched' | 'skipped' | 'failed'; reason?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return { status: 'skipped', reason: 'no_supabase' };

  const diagnosis = row.diagnosis || {};
  const reconcilerAttempts = Number(diagnosis.reconciler_redispatch_count || 0);
  if (reconcilerAttempts >= MAX_REDISPATCH_ATTEMPTS) {
    return { status: 'skipped', reason: 'attempt_cap_reached' };
  }

  const lastRedispatchedAt = diagnosis.reconciler_redispatched_at as string | undefined;
  if (lastRedispatchedAt) {
    const ageMs = Date.now() - new Date(lastRedispatchedAt).getTime();
    if (ageMs < MIN_REDISPATCH_INTERVAL_MS) {
      return { status: 'skipped', reason: 'cooldown' };
    }
  }

  // Fetch the spec from vtid_ledger so we can re-POST it.
  const ledgerRes = await fetch(
    `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${row.vtid}&select=vtid,title,summary&limit=1`,
    { headers: supabaseHeaders() },
  );
  if (!ledgerRes.ok) {
    return { status: 'failed', reason: `ledger_fetch_${ledgerRes.status}` };
  }
  const ledgerRows = (await ledgerRes.json()) as Array<{ title?: string; summary?: string }>;
  if (!ledgerRows || ledgerRows.length === 0) {
    return { status: 'failed', reason: 'no_ledger_row' };
  }
  const ledger = ledgerRows[0];
  const spec = (ledger.summary || '').substring(0, 8000);
  const title = ledger.title || `SELF-HEAL: ${row.vtid}`;

  if (!spec) {
    return { status: 'skipped', reason: 'no_spec' };
  }

  try {
    const dispatchRes = await fetch(`${GATEWAY_URL}/api/v1/worker/orchestrator/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vtid: row.vtid,
        title,
        spec,
        source: 'self-healing-reconciler',
        priority: 'critical',
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    if (!dispatchRes.ok) {
      return { status: 'failed', reason: `dispatch_http_${dispatchRes.status}` };
    }
  } catch (err: any) {
    return { status: 'failed', reason: `dispatch_throw_${err.message || 'unknown'}` };
  }

  // Mark the row so the next cycle waits the cooldown out.
  const newDiagnosis = {
    ...diagnosis,
    reconciler_redispatch_count: reconcilerAttempts + 1,
    reconciler_redispatched_at: new Date().toISOString(),
  };
  await fetch(`${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ diagnosis: newDiagnosis }),
  }).catch(err => {
    console.warn(`${LOG_PREFIX} Failed to patch redispatch metadata for ${row.vtid}: ${err.message}`);
  });

  return { status: 'redispatched' };
}

type EscalateReason =
  | 'recovered_externally'
  | 'stale_no_progress'
  | 'stale_agent_exhausted'
  | 'environmental_blocker'
  | 'ci_bridge_owned'
  | 'probe_verified'
  | 'probe_failed';

async function markEscalated(
  row: StaleRow,
  reason: EscalateReason,
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

  // 1. Update self_healing_log
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

  // 2. ALSO terminalize the vtid_ledger row so the dedup check stops
  //    seeing this VTID as "active". Without this, the ledger stays at
  //    status=allocated and blocks new self-healing VTIDs for the same
  //    endpoint forever.
  // Recovered/probe-verified rows complete the VTID; everything else fails.
  const terminalStatus =
    reason === 'recovered_externally' || reason === 'probe_verified' ? 'completed' : 'failed';
  await fetch(
    `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(row.vtid)}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: terminalStatus,
        updated_at: now,
      }),
    },
  ).catch((err) => {
    console.warn(`${LOG_PREFIX} Failed to terminalize ledger for ${row.vtid}: ${err.message}`);
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `${LOG_PREFIX} Failed to patch ${row.vtid}: ${res.status} ${text.slice(0, 200)}`,
    );
    return false;
  }
  return true;
}

/**
 * VTID-01961 (PR #4): Reconcile a voice synthetic-endpoint row.
 *
 * Voice rows have no HTTP path to probe; instead we run the Synthetic
 * Voice Probe (which checks /api/v1/orb/health flags). Pass → mark
 * recovered + record success in spec_memory. Fail → mark probe_failed +
 * record probe_failed in spec_memory + emit rollback recommendation.
 * Either way, transition the row terminal so it doesn't loop.
 */
async function reconcileVoiceRow(
  row: StaleRow,
  ageHours: number,
  voiceClass: string,
): Promise<void> {
  const probe = await runVoiceProbe();
  const signature =
    ((row.diagnosis || {}) as Record<string, unknown>).normalized_signature as string | undefined ||
    'unknown';
  const hint = getVoiceSpecHint(voiceClass);
  const specHash = hint?.spec_hash;

  if (probe.ok) {
    // Probe passed — mark recovered, record success in spec_memory, emit verdict.
    const ok = await markEscalated(row, 'probe_verified', null);
    if (specHash) {
      await recordSpecMemory({
        spec_hash: specHash,
        normalized_signature: signature,
        outcome: 'success',
        vtid: row.vtid,
        detail: `probe_passed_${probe.duration_ms}ms`,
      });
    }
    // VTID-01962 (PR #5): Sentinel append + threshold evaluate.
    await appendVerdict({
      class: voiceClass,
      normalized_signature: signature,
      verdict: 'ok',
      vtid: row.vtid,
      fixed_at: new Date().toISOString(),
    });
    const quarantineReason = await evaluateAndQuarantine(voiceClass, signature);
    if (quarantineReason) {
      console.log(
        `${LOG_PREFIX} Sentinel quarantined ${voiceClass}/${signature} after probe_ok: ${quarantineReason}`,
      );
    }
    if (ok) {
      try {
        await emitOasisEvent({
          vtid: row.vtid,
          type: 'voice.healing.verdict',
          source: 'self-healing-reconciler',
          status: 'success',
          message: `Voice probe PASSED for ${voiceClass} after fix attempt (${probe.duration_ms}ms)`,
          payload: {
            voice_class: voiceClass,
            normalized_signature: signature,
            spec_hash: specHash,
            verdict: 'ok',
            probe_duration_ms: probe.duration_ms,
            probe_evidence: probe.evidence,
            age_hours: Number(ageHours.toFixed(2)),
            endpoint: row.endpoint,
          },
        });
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to emit voice.healing.verdict for ${row.vtid}:`, err);
      }
      console.log(
        `${LOG_PREFIX} Voice probe passed for ${row.vtid} (${voiceClass}, ${probe.duration_ms}ms)`,
      );
    }
    return;
  }

  // Probe failed — mark terminal as probe_failed, record probe_failed in
  // spec_memory (Spec Memory Gate will block re-dispatch for 72h), and
  // emit rollback recommendation.
  const ok = await markEscalated(row, 'probe_failed', null);
  if (specHash) {
    await recordSpecMemory({
      spec_hash: specHash,
      normalized_signature: signature,
      outcome: 'probe_failed',
      vtid: row.vtid,
      detail: `${probe.failure_mode_code}_${probe.duration_ms}ms`,
    });
  }
  // VTID-01962 (PR #5): Sentinel append + threshold evaluate.
  await appendVerdict({
    class: voiceClass,
    normalized_signature: signature,
    verdict: 'rollback',
    vtid: row.vtid,
  });
  const quarantineReason = await evaluateAndQuarantine(voiceClass, signature);
  if (quarantineReason) {
    console.log(
      `${LOG_PREFIX} Sentinel quarantined ${voiceClass}/${signature} after probe_failed: ${quarantineReason}`,
    );
  }
  if (ok) {
    try {
      await emitOasisEvent({
        vtid: row.vtid,
        type: 'voice.healing.verdict',
        source: 'self-healing-reconciler',
        status: 'error',
        message: `Voice probe FAILED for ${voiceClass} after fix attempt: ${probe.failure_mode_code}`,
        payload: {
          voice_class: voiceClass,
          normalized_signature: signature,
          spec_hash: specHash,
          verdict: 'rollback',
          failure_mode_code: probe.failure_mode_code,
          probe_duration_ms: probe.duration_ms,
          probe_evidence: probe.evidence,
          age_hours: Number(ageHours.toFixed(2)),
          endpoint: row.endpoint,
        },
      });
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to emit voice.healing.verdict for ${row.vtid}:`, err);
    }

    await triggerRollbackRecommendation({
      vtid: row.vtid,
      voice_class: voiceClass,
      normalized_signature: signature,
      spec_hash: specHash,
      probe_result: probe,
    });

    console.log(
      `${LOG_PREFIX} Voice probe failed for ${row.vtid} (${voiceClass}, ${probe.failure_mode_code}) — rollback recommended`,
    );
  }
}

async function runReconcileCycle(thresholdMs: number): Promise<void> {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    const rows = await fetchStaleRows(thresholdMs);
    if (rows.length === 0) return;
    console.log(`${LOG_PREFIX} Found ${rows.length} stale row(s) to reconcile`);
    for (const row of rows) {
      const ageHours = (Date.now() - new Date(row.created_at).getTime()) / 3600000;

      // VTID-01961 (PR #4): voice synthetic endpoints take a different path —
      // run the synthetic probe (chime-aware, semantic verification post-PR-5),
      // record outcome to voice_healing_spec_memory, emit voice.healing.verdict,
      // and on failure emit voice.healing.rollback.triggered. Then mark
      // terminal so we don't retry forever.
      const voiceClass = parseVoiceClassFromEndpoint(row.endpoint);
      if (voiceClass) {
        await reconcileVoiceRow(row, ageHours, voiceClass);
        continue;
      }

      const { healthy, http_status } = await probeEndpoint(row.endpoint);

      // Path A: endpoint healthy now → tombstone as recovered_externally
      if (healthy) {
        const ok = await markEscalated(row, 'recovered_externally', http_status);
        if (!ok) continue;
        try {
          await emitOasisEvent({
            vtid: row.vtid,
            type: 'self-healing.reconciled',
            source: 'self-healing-reconciler',
            status: 'info',
            message: `Reconciler: ${row.vtid} recovered externally (${row.endpoint} HTTP ${http_status})`,
            payload: {
              endpoint: row.endpoint,
              failure_class: row.failure_class,
              reason: 'recovered_externally',
              http_status,
              age_hours: Number(ageHours.toFixed(2)),
            },
            actor_role: 'system',
            surface: 'system',
          });
        } catch (emitErr) {
          console.warn(`${LOG_PREFIX} Failed to emit OASIS event for ${row.vtid}:`, emitErr);
        }
        console.log(`${LOG_PREFIX} Reconciled ${row.vtid}: recovered_externally (age=${ageHours.toFixed(1)}h)`);
        continue;
      }

      // Path B: endpoint still down → try to redispatch the existing fix spec
      const redispatch = await attemptRedispatch(row);

      if (redispatch.status === 'redispatched') {
        const attemptNum = Number((row.diagnosis || {}).reconciler_redispatch_count || 0) + 1;
        try {
          await emitOasisEvent({
            vtid: row.vtid,
            type: 'self-healing.dispatch.retried',
            source: 'self-healing-reconciler',
            status: 'info',
            message: `Reconciler re-dispatched ${row.vtid} to worker orchestrator (age=${ageHours.toFixed(1)}h)`,
            payload: {
              endpoint: row.endpoint,
              failure_class: row.failure_class,
              age_hours: Number(ageHours.toFixed(2)),
              reconciler_redispatch_count: attemptNum,
            },
            actor_role: 'system',
            surface: 'system',
          });
        } catch (emitErr) {
          console.warn(`${LOG_PREFIX} Failed to emit dispatch.retried event for ${row.vtid}:`, emitErr);
        }
        // No Gchat ping for redispatch — it's autonomous recovery in progress,
        // not a human-action moment. Team only hears about it if it ultimately
        // fails (tombstone path below) or succeeds silently.
        console.log(`${LOG_PREFIX} Re-dispatched ${row.vtid} (age=${ageHours.toFixed(1)}h, attempt=${attemptNum}) — leaving outcome=pending`);
        continue;
      }

      if (redispatch.status === 'skipped' && redispatch.reason === 'cooldown') {
        // Worker may still be processing the previous redispatch — leave it alone for now.
        console.log(`${LOG_PREFIX} Skipping ${row.vtid}: redispatch cooldown still active`);
        continue;
      }

      // Path C: redispatch was capped, infeasible, or failed.
      // Before tombstoning, try a deep triage agent investigation — it may
      // produce a DIFFERENT approach that feeds a fresh self-healing cycle.
      const agentAttempts = Number((row.diagnosis || {} as any).triage_agent_attempts || 0);

      // ENV-ERROR SHORT-CIRCUIT (2026-04-28 incident): when the failure class
      // is `environmental_blocker` (binary missing, OOM, network, container
      // recycle), the bridge already escalated and explicitly skipped triage
      // because the agent can't fix infrastructure. Don't run another triage
      // here — it would spawn a SELF-HEAL retry VTID via createFreshVtid…,
      // and that VTID would just hit the same env blocker again on its next
      // dispatch. Tombstone immediately instead.
      if (row.failure_class === 'environmental_blocker') {
        console.log(`${LOG_PREFIX} env-blocker for ${row.vtid}: skipping triage agent + spawn (operator must fix host)`);
        await markEscalated(row, 'environmental_blocker', http_status);
        continue;
      }

      // CI-FAILURE SHORT-CIRCUIT (2026-05-03 incident): the dev-autopilot
      // bridge owns the CI-failure → revert-PR → spawn-child-execution
      // recovery path. It already retries up to `max_auto_fix_depth` and
      // then escalates cleanly. The reconciler's separate triage-then-spawn
      // path is redundant for those failures and creates phantom SELF-HEAL
      // retry VTIDs in `vtid_ledger` that the operator sees as duplicate
      // work. During a 60-min batch test, this leaked 9 SELF-HEAL VTIDs
      // even though the bridge had cleanly handled every CI failure.
      //
      // Skip if the underlying execution row is in a state the bridge owns:
      //   - failed_escalated (bridge already escalated; respect that)
      //   - reverted (CI failed, bridge reverted, depth-cap may have been hit)
      // These never need reconciler triage — they need either a human review
      // (failed_escalated) or a planner re-prompt (reverted at depth-cap).
      const bridgeStage = (row.diagnosis || {} as any).stage
        || (row.diagnosis || {} as any).failure_stage
        || row.failure_class;
      if (bridgeStage === 'ci' || row.failure_class === 'ci_check_failed') {
        console.log(`${LOG_PREFIX} ci-failure for ${row.vtid}: bridge owns this, skipping reconciler triage spawn`);
        await markEscalated(row, 'ci_bridge_owned', http_status);
        continue;
      }

      if (agentAttempts < MAX_TRIAGE_ATTEMPTS) {
        console.log(`${LOG_PREFIX} Spawning triage agent for ${row.vtid} (attempt ${agentAttempts + 1}/${MAX_TRIAGE_ATTEMPTS})`);
        try {
          const triageResult = await spawnTriageAgent({
            mode: 'post_failure',
            vtid: row.vtid,
            original_diagnosis: row.diagnosis || undefined,
            failure_class: row.failure_class,
            endpoint: row.endpoint,
            all_attempts: agentAttempts,
            reconciler_history: {
              redispatch_count: (row.diagnosis || {} as any).reconciler_redispatch_count,
              age_hours: ageHours,
              redispatch_status: redispatch.status,
              redispatch_reason: redispatch.reason,
            },
          });

          if (triageResult.ok && triageResult.report && triageResult.report.confidence_numeric >= 0.5) {
            // Agent produced a viable new approach — create a fresh VTID
            const newVtid = await createFreshVtidFromTriageReport(
              row.vtid,
              triageResult.report,
              row.endpoint,
            );

            if (newVtid) {
              // Update the original row to record the agent attempt
              const updatedDiagnosis = {
                ...(row.diagnosis || {}),
                triage_agent_attempts: agentAttempts + 1,
                triage_spawned_vtid: newVtid,
                triage_report: triageResult.report,
              };
              await fetch(`${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${row.id}`, {
                method: 'PATCH',
                headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
                body: JSON.stringify({ diagnosis: updatedDiagnosis }),
              }).catch(() => {});

              await emitOasisEvent({
                vtid: row.vtid,
                type: 'self-healing.triage.loop' as any,
                source: 'self-healing-reconciler',
                status: 'info',
                message: `Triage agent produced new approach → spawned ${newVtid} (parent: ${row.vtid})`,
                payload: {
                  parent_vtid: row.vtid,
                  child_vtid: newVtid,
                  triage_confidence: triageResult.report.confidence,
                  agent_attempt: agentAttempts + 1,
                },
                actor_role: 'system',
                surface: 'system',
              }).catch(() => {});

              console.log(`${LOG_PREFIX} Triage loop: ${row.vtid} → ${newVtid} (confidence: ${triageResult.report.confidence})`);
              // Mark original as escalated now that a child has taken over
              await markEscalated(row, 'stale_no_progress', http_status);
              continue;
            }
          }
        } catch (triageErr) {
          console.warn(`${LOG_PREFIX} Triage agent error for ${row.vtid}:`, triageErr);
        }
      }

      // Tombstone: either agent budget exhausted or agent couldn't produce a viable approach
      const tombstoneReason = agentAttempts >= MAX_TRIAGE_ATTEMPTS
        ? 'stale_agent_exhausted' : 'stale_no_progress';
      const ok = await markEscalated(row, tombstoneReason as any, http_status);
      if (!ok) continue;
      try {
        await emitOasisEvent({
          vtid: row.vtid,
          type: 'self-healing.reconciled',
          source: 'self-healing-reconciler',
          status: 'warning',
          message: `Reconciler tombstoned ${row.vtid} as ${tombstoneReason}`,
          payload: {
            endpoint: row.endpoint,
            failure_class: row.failure_class,
            reason: tombstoneReason,
            http_status,
            age_hours: Number(ageHours.toFixed(2)),
            redispatch_status: redispatch.status,
            redispatch_reason: redispatch.reason,
            triage_agent_attempts: agentAttempts,
          },
          actor_role: 'system',
          surface: 'system',
        });
      } catch (emitErr) {
        console.warn(`${LOG_PREFIX} Failed to emit OASIS event for ${row.vtid}:`, emitErr);
      }
      try {
        await notifyGChat(
          `🚨 *Self-Healing GAVE UP — ${tombstoneReason}*\n` +
          `Task: ${row.vtid}\n` +
          `Endpoint: ${row.endpoint} (HTTP ${http_status ?? 'err'})\n` +
          `Age: ${ageHours.toFixed(1)}h\n` +
          `Triage attempts: ${agentAttempts}/${MAX_TRIAGE_ATTEMPTS}\n` +
          `Endpoint still down. Manual investigation required.\n` +
          `Act now: ${COMMAND_HUB_SH_URL}`,
        );
      } catch (notifyErr) {
        console.warn(`${LOG_PREFIX} Failed to send Gchat tombstone notification:`, notifyErr);
      }
      console.log(
        `${LOG_PREFIX} Tombstoned ${row.vtid} as ${tombstoneReason} (age=${ageHours.toFixed(1)}h, triage_attempts=${agentAttempts})`,
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
