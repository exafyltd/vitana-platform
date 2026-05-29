/**
 * Self-Healing Route
 * Receives health reports from collect-status.py, orchestrates the
 * diagnosis → spec → inject → verify pipeline, and provides dashboard APIs.
 *
 * Endpoints:
 * - POST /report              — Receive health report, trigger self-healing
 * - POST /kill-switch          — Enable/disable self-healing
 * - GET  /config               — Get current config (enabled, autonomy level)
 * - PATCH /config              — Update autonomy level
 * - GET  /active               — List active self-healing tasks
 * - GET  /history              — List past self-healing attempts
 * - GET  /pending-approval     — Rows needing a human approval decision
 * - GET  /snapshots/:vtid      — Get pre/post snapshots for a VTID
 * - POST /verify/:vtid         — Manually trigger post-fix verification
 * - POST /rollback/:vtid       — Manually trigger rollback
 * - GET  /health               — Health check
 */

import { Router, Request, Response } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import { beginDiagnosis } from '../services/self-healing-diagnosis-service';
import { generateAndStoreFixSpec } from '../services/self-healing-spec-service';
import { injectIntoAutopilotPipeline } from '../services/self-healing-injector-service';
import {
  captureHealthSnapshot,
  verifyFixWithBlastRadiusCheck,
  executeRollback,
  notifyGChat,
} from '../services/self-healing-snapshot-service';
import { spawnTriageAgent } from '../services/self-healing-triage-service';
import { probeEndpoint, isJsonHealthy } from '../services/self-healing-probe';
import {
  HealthReport,
  ServiceStatus,
  SelfHealingReportResponse,
  AutonomyLevel,
  ENDPOINT_FILE_MAP,
} from '../types/self-healing';

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Deep link used in every real-time Gchat alert so recipients can
// click straight into the Self Healing panel and act on the row.
const COMMAND_HUB_SH_URL =
  process.env.COMMAND_HUB_SH_URL ||
  'https://gateway-q74ibpv6ia-uc.a.run.app/command-hub/infrastructure/self-healing';

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

// ═══════════════════════════════════════════════════════════════════
// Config helpers
// ═══════════════════════════════════════════════════════════════════

async function isSelfHealingEnabled(): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/system_config?key=eq.self_healing_enabled&select=value`,
      { headers: supabaseHeaders() },
    );
    if (!resp.ok) return true; // default enabled
    const rows = (await resp.json()) as Array<{ value: unknown }>;
    if (rows.length === 0) return true;
    return rows[0].value !== false && rows[0].value !== 'false';
  } catch {
    return true; // default enabled
  }
}

// VTID-02032: Exported alongside processFailingService so the routines
// bridge runs at the same autonomy level as the canonical /report path.
export async function getAutonomyLevel(): Promise<AutonomyLevel> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return AutonomyLevel.AUTO_FIX_SIMPLE;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/system_config?key=eq.self_healing_autonomy_level&select=value`,
      { headers: supabaseHeaders() },
    );
    if (!resp.ok) return AutonomyLevel.AUTO_FIX_SIMPLE;
    const rows = (await resp.json()) as Array<{ value: unknown }>;
    if (rows.length === 0) return AutonomyLevel.AUTO_FIX_SIMPLE;
    const level = Number(rows[0].value);
    return isNaN(level) ? AutonomyLevel.AUTO_FIX_SIMPLE : level as AutonomyLevel;
  } catch {
    return AutonomyLevel.AUTO_FIX_SIMPLE;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Dedup & Circuit Breaker
// ═══════════════════════════════════════════════════════════════════

async function shouldBeginDiagnosis(endpoint: string): Promise<{ proceed: boolean; reason?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { proceed: false, reason: 'Supabase not configured' };
  }

  try {
    // Check 1: Active self-healing VTID for this endpoint?
    const activeResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?` +
        `metadata->>source=eq.self-healing&metadata->>endpoint=eq.${encodeURIComponent(endpoint)}` +
        `&status=in.(allocated,pending,scheduled,in_progress)&select=vtid,status&limit=1`,
      { headers: supabaseHeaders() },
    );
    if (activeResp.ok) {
      const active = (await activeResp.json()) as Array<{ vtid: string; status: string }>;
      if (active.length > 0) {
        return {
          proceed: false,
          reason: `Active VTID ${active[0].vtid} (status=${active[0].status}) for ${endpoint}`,
        };
      }
    }

    // Check 2: Circuit breaker — max 2 attempts per endpoint per 24h
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const countResp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?` +
        `endpoint=eq.${encodeURIComponent(endpoint)}&created_at=gte.${cutoff}` +
        `&select=id`,
      { headers: { ...supabaseHeaders(), Prefer: 'count=exact' } },
    );
    if (countResp.ok) {
      const countHeader = countResp.headers.get('content-range');
      const total = countHeader ? parseInt(countHeader.split('/')[1] || '0', 10) : 0;
      // Circuit breaker cap: allow up to 5 attempts per endpoint per 24h.
      // Raised from 2 to 5 to accommodate the triage agent feedback loop
      // which may create 2-3 fresh VTIDs per original failure.
      if (total >= 5) {
        return {
          proceed: false,
          reason: `Circuit breaker: ${total} attempts in 24h for ${endpoint}`,
        };
      }
    }

    return { proceed: true };
  } catch (err: any) {
    console.warn(`[self-healing] Dedup check error: ${err.message}`);
    return { proceed: true }; // allow on error — better to try than to silently skip
  }
}

// ═══════════════════════════════════════════════════════════════════
// Process a single failing service through the pipeline
// ═══════════════════════════════════════════════════════════════════

// VTID-02032: Exported so the routines bridge can run a routine-detected
// breach through the same LLM-diagnosis + auto-fix-or-escalate pipeline as
// real health-probe failures. Without this, rows inserted directly into
// self_healing_log have no spec and the reconciler escalates them after 1h
// of no progress.
export async function processFailingService(
  failure: ServiceStatus,
  autonomyLevel: AutonomyLevel,
): Promise<{ action: 'created' | 'skipped' | 'escalated' | 'disabled' | 'recovered_externally'; vtid?: string; reason?: string }> {
  // Dedup + circuit breaker
  const check = await shouldBeginDiagnosis(failure.endpoint);
  if (!check.proceed) {
    await emitOasisEvent({
      type: 'self-healing.task.skipped',
      vtid: 'SYSTEM',
      source: 'self-healing',
      status: 'info',
      message: check.reason || 'Skipped',
      payload: { endpoint: failure.endpoint, reason: check.reason },
    });
    return { action: 'skipped', reason: check.reason };
  }

  // Pre-probe gate (PR-B): the scanner snapshot may already be stale by the
  // time we get here. Real-HTTP endpoints get a 5s re-probe; if they answer
  // with 2xx + application/json, the endpoint has recovered between snapshot
  // and processing — bail out without allocating a VTID or writing a
  // self_healing_log row. Voice synthetic endpoints (voice-error://) are
  // skipped here; they have their own Synthetic Voice Probe path.
  if (!failure.endpoint.startsWith('voice-error://')) {
    const probe = await probeEndpoint(failure.endpoint);
    if (isJsonHealthy(probe)) {
      await emitOasisEvent({
        type: 'self-healing.preflight.recovered',
        vtid: 'SYSTEM',
        source: 'self-healing',
        status: 'info',
        message: `Pre-probe found ${failure.endpoint} healthy (HTTP ${probe.http_status}, ${probe.latency_ms}ms)`,
        payload: {
          endpoint: failure.endpoint,
          http_status: probe.http_status,
          latency_ms: probe.latency_ms,
          content_type: probe.content_type,
          probed_at: new Date().toISOString(),
          scanner_http_status: failure.http_status,
          scanner_response_time_ms: failure.response_time_ms,
        },
      });
      return {
        action: 'recovered_externally',
        reason: `endpoint healthy at pre-probe (HTTP ${probe.http_status}, ${probe.latency_ms}ms)`,
      };
    }
  }

  // Level 0: Observe only — log but don't act
  if (autonomyLevel === AutonomyLevel.OBSERVE_ONLY) {
    console.log(`[self-healing] OBSERVE_ONLY: ${failure.name} (${failure.endpoint}) is down`);
    return { action: 'disabled', reason: 'Autonomy level: OBSERVE_ONLY' };
  }

  // Allocate VTID + run deep diagnosis
  const { vtid, diagnosis } = await beginDiagnosis(failure);

  // Level 1: Diagnose only — stop after diagnosis
  if (autonomyLevel === AutonomyLevel.DIAGNOSE_ONLY) {
    console.log(`[self-healing] DIAGNOSE_ONLY: ${vtid} diagnosed as ${diagnosis.failure_class} (${(diagnosis.confidence * 100).toFixed(0)}%)`);
    await notifyGChat(
      `🔍 *Self-Healing Diagnosis*\n` +
      `Task: ${vtid}\n` +
      `Service: ${diagnosis.service_name}\n` +
      `Class: ${diagnosis.failure_class}\n` +
      `Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%\n` +
      `Root cause: ${diagnosis.root_cause.substring(0, 200)}\n` +
      `Mode: DIAGNOSE_ONLY — no action taken`,
    );
    return { action: 'created', vtid, reason: 'Diagnosed only (autonomy level 1)' };
  }

  // If not auto-fixable and low confidence, try deep triage before escalating
  if (!diagnosis.auto_fixable && diagnosis.confidence < 0.5) {
    // Attempt deep triage with Claude Managed Agents — may upgrade confidence
    const triageResult = await spawnTriageAgent({
      mode: 'pre_fix',
      vtid,
      diagnosis: diagnosis as any,
      failure,
    });
    if (triageResult.ok && triageResult.report) {
      console.log(`[self-healing] ${vtid} deep triage: confidence ${(diagnosis.confidence * 100).toFixed(0)}% → ${(triageResult.report.confidence_numeric * 100).toFixed(0)}%`);
      diagnosis.root_cause = triageResult.report.root_cause_hypothesis || diagnosis.root_cause;
      diagnosis.confidence = triageResult.report.confidence_numeric;
      diagnosis.auto_fixable = triageResult.report.confidence_numeric >= 0.8;
      (diagnosis as any).triage_agent = triageResult.report;
      // If triage upgraded confidence above 0.5, fall through to spec generation
      // instead of escalating
    } else if (!triageResult.ok) {
      console.warn(`[self-healing] ${vtid} triage failed: ${triageResult.error ?? 'unknown'}`);
    }

    // Still too low after triage — escalate with the agent's enriched context
    if (diagnosis.confidence < 0.5) {
      const triageFailed = !triageResult.ok;
      await notifyGChat(
        `🚨 *Self-Healing Escalation*\n` +
        `Task: ${vtid}\n` +
        `Service: ${diagnosis.service_name}\n` +
        `Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%${(diagnosis as any).triage_agent ? ' (after deep triage)' : triageFailed ? ' (triage unavailable)' : ''}\n` +
        `Root cause: ${diagnosis.root_cause.substring(0, 200)}\n` +
        `Action required: Manual investigation needed`,
      );
      return { action: 'escalated', vtid, reason: `Low confidence (${(diagnosis.confidence * 100).toFixed(0)}%)` };
    }
  }

  // Mid-range confidence (0.5-0.79) — also try deep triage to potentially upgrade
  if (diagnosis.confidence >= 0.5 && diagnosis.confidence < 0.8 && !(diagnosis as any).triage_agent) {
    const triageResult = await spawnTriageAgent({
      mode: 'pre_fix',
      vtid,
      diagnosis: diagnosis as any,
      failure,
    });
    if (triageResult.ok && triageResult.report) {
      console.log(`[self-healing] ${vtid} deep triage: confidence ${(diagnosis.confidence * 100).toFixed(0)}% → ${(triageResult.report.confidence_numeric * 100).toFixed(0)}%`);
      diagnosis.root_cause = triageResult.report.root_cause_hypothesis || diagnosis.root_cause;
      diagnosis.confidence = triageResult.report.confidence_numeric;
      diagnosis.auto_fixable = triageResult.report.confidence_numeric >= 0.8;
      (diagnosis as any).triage_agent = triageResult.report;
    }
  }

  // Generate fix spec
  const { spec, spec_hash, quality_score } = await generateAndStoreFixSpec(diagnosis);
  console.log(`[self-healing] ${vtid} spec generated (quality: ${quality_score.toFixed(2)}, hash: ${spec_hash.substring(0, 8)})`);

  // Level 2: Spec and wait — generate spec but always require approval
  if (autonomyLevel === AutonomyLevel.SPEC_AND_WAIT) {
    // Force non-auto-approved
    diagnosis.confidence = Math.min(diagnosis.confidence, 0.79);
  }

  // Level 3: Only auto-approve high confidence
  if (autonomyLevel === AutonomyLevel.AUTO_FIX_SIMPLE && diagnosis.confidence < 0.8) {
    diagnosis.auto_fixable = false;
  }

  // Inject into autopilot pipeline
  const injection = await injectIntoAutopilotPipeline(vtid, diagnosis, spec, spec_hash);
  if (!injection.success) {
    console.error(`[self-healing] Failed to inject ${vtid}: ${injection.error}`);
    return { action: 'escalated', vtid, reason: `Injection failed: ${injection.error}` };
  }

  // No direct dispatch — the injector emits autopilot.task.spec.created
  // which the autopilot event loop picks up and dispatches through the
  // standard pipeline (enforceSpecRequirement → worker-runner → completion).

  // Gchat notification ONLY when a human decision is required.
  // Auto-approved tasks run silently — the team sees them in the
  // Command Hub if they look, but we don't ping for in-progress work.
  if (diagnosis.confidence < 0.8) {
    await notifyGChat(
      `⏳ *Self-Healing AWAITING APPROVAL*\n` +
      `Task: ${vtid}\n` +
      `Service: ${diagnosis.service_name}\n` +
      `Issue: ${diagnosis.failure_class}\n` +
      `Root cause: ${diagnosis.root_cause.substring(0, 200)}\n` +
      `Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%\n` +
      `Approve/reject: ${COMMAND_HUB_SH_URL}`,
    );
  }

  return { action: 'created', vtid };
}

// ═══════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════

/** Health check */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'self-healing',
    version: 'v1',
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /report — Receive health report from collect-status.py
 * Triggers the self-healing pipeline for each down service.
 */
router.post('/report', async (req: Request, res: Response) => {
  try {
    const report = req.body as HealthReport;

    if (!report || !report.services || !Array.isArray(report.services)) {
      return res.status(400).json({ ok: false, error: 'Invalid report format' });
    }

    // Check kill switch
    const enabled = await isSelfHealingEnabled();
    if (!enabled) {
      console.log('[self-healing] Kill switch active — logging report but not acting');
      await emitOasisEvent({
        type: 'self-healing.report.received',
        vtid: 'SYSTEM',
        source: 'self-healing',
        status: 'info',
        message: `Health report received (${report.live}/${report.total} live) — self-healing DISABLED`,
        payload: { total: report.total, live: report.live, enabled: false },
      });
      return res.json({
        ok: true,
        processed: 0,
        vtids_created: 0,
        skipped: report.services.filter(s => s.status !== 'live').length,
        details: report.services
          .filter(s => s.status !== 'live')
          .map(s => ({ service: s.name, endpoint: s.endpoint, action: 'disabled' as const, reason: 'Self-healing disabled' })),
      } satisfies SelfHealingReportResponse);
    }

    const autonomyLevel = await getAutonomyLevel();

    // Emit report received event
    const downServices = report.services.filter(s => s.status !== 'live');
    await emitOasisEvent({
      type: 'self-healing.report.received',
      vtid: 'SYSTEM',
      source: 'self-healing',
      status: downServices.length > 0 ? 'warning' : 'success',
      message: `Health report: ${report.live}/${report.total} live, ${downServices.length} down`,
      payload: {
        total: report.total,
        live: report.live,
        down_count: downServices.length,
        down_services: downServices.map(s => s.name),
        autonomy_level: autonomyLevel,
      },
    });

    if (downServices.length === 0) {
      return res.json({
        ok: true,
        processed: 0,
        vtids_created: 0,
        skipped: 0,
        details: [],
      } satisfies SelfHealingReportResponse);
    }

    // Process each failing service sequentially (avoid overwhelming the system)
    const details: SelfHealingReportResponse['details'] = [];
    let vtidsCreated = 0;
    let skipped = 0;
    let recoveredExternally = 0;

    // Known-endpoint allowlist: only process endpoints that exist in the
    // gateway route map. Test/phantom endpoints (e.g. /api/v1/final-test/health,
    // /api/v1/orb-v2/health) from E2E runs are rejected immediately.
    const knownEndpoints = new Set(Object.keys(ENDPOINT_FILE_MAP));
    // Also allow /alive (gateway root health) and /api/v1/self-healing/health
    knownEndpoints.add('/alive');
    knownEndpoints.add('/api/v1/self-healing/health');

    // Voice synthetic endpoints (voice-error://<class>) are accepted by the
    // self-healing pipeline so the Voice→SelfHealing Adapter can dispatch
    // ORB voice failures through the same diagnose/inject/dispatch chain.
    // Subsequent PRs add the adapter, deterministic specs, and synthetic probe.
    const VOICE_SYNTHETIC_ENDPOINT = /^voice-error:\/\/[a-z._-]+$/;
    // VTID-02032: Routine incidents — synthetic endpoint pattern for breaches detected
    // by the daily routines, so the self-healing pipeline picks them up via the same
    // diagnose/spec/dispatch chain that handles voice-synthetic errors.
    const ROUTINE_SYNTHETIC_ENDPOINT = /^routine-incident:\/\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

    for (const failure of downServices) {
      const isVoiceSynthetic = VOICE_SYNTHETIC_ENDPOINT.test(failure.endpoint);
      const isRoutineSynthetic = ROUTINE_SYNTHETIC_ENDPOINT.test(failure.endpoint);
      if (!isVoiceSynthetic && !isRoutineSynthetic && !knownEndpoints.has(failure.endpoint)) {
        console.log(`[self-healing] Rejecting unknown endpoint: ${failure.endpoint}`);
        details.push({
          service: failure.name,
          endpoint: failure.endpoint,
          action: 'skipped' as const,
          reason: `Unknown endpoint — not in gateway route map`,
        });
        skipped++;
        continue;
      }
      try {
        const result = await processFailingService(failure, autonomyLevel);
        details.push({
          service: failure.name,
          endpoint: failure.endpoint,
          action: result.action,
          vtid: result.vtid,
          reason: result.reason,
        });
        if (result.action === 'created') vtidsCreated++;
        if (result.action === 'skipped') skipped++;
        if (result.action === 'recovered_externally') recoveredExternally++;
      } catch (err: any) {
        console.error(`[self-healing] Error processing ${failure.name}: ${err.message}`);
        details.push({
          service: failure.name,
          endpoint: failure.endpoint,
          action: 'escalated',
          reason: `Processing error: ${err.message}`,
        });
      }
    }

    return res.json({
      ok: true,
      processed: downServices.length,
      vtids_created: vtidsCreated,
      skipped,
      recovered_externally: recoveredExternally,
      details,
    } satisfies SelfHealingReportResponse);
  } catch (err: any) {
    console.error(`[self-healing] Report handler error: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /kill-switch — Enable or disable self-healing
 */
router.post('/kill-switch', async (req: Request, res: Response) => {
  try {
    const { action, operator, reason } = req.body as {
      action: 'activate' | 'deactivate';
      operator?: string;
      reason?: string;
    };

    if (!action || !['activate', 'deactivate'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'action must be "activate" or "deactivate"' });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    const enabled = action === 'deactivate'; // deactivate kill switch = enable self-healing

    // Update config
    await fetch(`${SUPABASE_URL}/rest/v1/system_config?key=eq.self_healing_enabled`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({
        value: enabled,
        updated_by: operator || 'api',
        updated_at: new Date().toISOString(),
      }),
    });

    if (action === 'activate') {
      // Pause all active self-healing VTIDs
      await fetch(
        `${SUPABASE_URL}/rest/v1/vtid_ledger?metadata->>source=eq.self-healing&status=in.(allocated,pending,in_progress)`,
        {
          method: 'PATCH',
          headers: supabaseHeaders(),
          body: JSON.stringify({ status: 'paused', updated_at: new Date().toISOString() }),
        },
      );
    }

    await emitOasisEvent({
      type: `self-healing.kill_switch.${action === 'activate' ? 'activated' : 'deactivated'}`,
      vtid: 'SYSTEM',
      source: 'self-healing',
      status: action === 'activate' ? 'warning' : 'info',
      message: `Self-healing kill switch ${action}d by ${operator || 'api'}`,
      payload: { operator, reason, enabled },
    });

    await notifyGChat(
      action === 'activate'
        ? `🔴 *Self-Healing KILL SWITCH activated*\nBy: ${operator || 'api'}\nReason: ${reason || 'not specified'}\nAll active tasks paused.`
        : `🟢 *Self-Healing re-enabled*\nBy: ${operator || 'api'}`,
    );

    return res.json({ ok: true, status: action === 'activate' ? 'killed' : 'active', enabled });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /config — Current self-healing configuration
 */
router.get('/config', async (_req: Request, res: Response) => {
  const enabled = await isSelfHealingEnabled();
  const autonomyLevel = await getAutonomyLevel();
  const levelNames = ['OBSERVE_ONLY', 'DIAGNOSE_ONLY', 'SPEC_AND_WAIT', 'AUTO_FIX_SIMPLE', 'FULL_AUTO'];
  return res.json({
    ok: true,
    enabled,
    autonomy_level: autonomyLevel,
    autonomy_name: levelNames[autonomyLevel] || 'UNKNOWN',
  });
});

/**
 * PATCH /config — Update autonomy level
 */
router.patch('/config', async (req: Request, res: Response) => {
  try {
    const { autonomy_level, operator } = req.body as { autonomy_level: number; operator?: string };

    if (autonomy_level === undefined || autonomy_level < 0 || autonomy_level > 4) {
      return res.status(400).json({ ok: false, error: 'autonomy_level must be 0-4' });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    await fetch(`${SUPABASE_URL}/rest/v1/system_config?key=eq.self_healing_autonomy_level`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({
        value: autonomy_level,
        updated_by: operator || 'api',
        updated_at: new Date().toISOString(),
      }),
    });

    const levelNames = ['OBSERVE_ONLY', 'DIAGNOSE_ONLY', 'SPEC_AND_WAIT', 'AUTO_FIX_SIMPLE', 'FULL_AUTO'];
    return res.json({
      ok: true,
      autonomy_level,
      autonomy_name: levelNames[autonomy_level],
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /active — List active self-healing tasks
 */
router.get('/active', async (_req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?` +
        `metadata->>source=eq.self-healing&status=in.(allocated,pending,scheduled,in_progress,paused)` +
        `&select=vtid,title,status,spec_status,metadata,created_at,updated_at` +
        `&order=created_at.desc&limit=20`,
      { headers: supabaseHeaders() },
    );

    if (!resp.ok) {
      return res.status(500).json({ ok: false, error: 'Failed to query active tasks' });
    }

    const tasks = await resp.json();
    return res.json({ ok: true, tasks });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /history — List past self-healing attempts
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    // Optional filters. PostgREST query syntax: `failure_class=eq.<value>`.
    // Whitelist allowed columns to keep this an exact-match filter that
    // can't smuggle other operators through the URL.
    const filterParts: string[] = [];
    const failureClass = (req.query.failure_class as string | undefined) || '';
    if (failureClass) filterParts.push(`failure_class=eq.${encodeURIComponent(failureClass)}`);
    const outcome = (req.query.outcome as string | undefined) || '';
    if (outcome) filterParts.push(`outcome=eq.${encodeURIComponent(outcome)}`);
    const filterQs = filterParts.length ? '&' + filterParts.join('&') : '';

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?` +
        `select=*&order=created_at.desc&limit=${limit}&offset=${offset}` +
        filterQs,
      { headers: { ...supabaseHeaders(), Prefer: 'count=exact' } },
    );

    if (!resp.ok) {
      return res.status(500).json({ ok: false, error: 'Failed to query history' });
    }

    const items = (await resp.json()) as any[];
    const countHeader = resp.headers.get('content-range');
    const total = countHeader ? parseInt(countHeader.split('/')[1] || '0', 10) : items.length;

    return res.json({ ok: true, items, total, limit, offset });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /history/classes — Distinct (failure_class, count) pairs across the
 * full self_healing_log. Used by the Command Hub Self-Healing screen to
 * populate the failure-class filter dropdown without paginating client-side.
 */
router.get('/history/classes', async (_req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }
    // PostgREST aggregate trick: select=failure_class,count() with group is
    // not exposed by default; we pull failure_class for all rows and tally
    // here. The table is small enough (low thousands) that this is cheap;
    // if it grows, swap for a SQL view + RPC.
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?select=failure_class&limit=10000`,
      { headers: supabaseHeaders() },
    );
    if (!resp.ok) {
      return res.status(500).json({ ok: false, error: 'Failed to query classes' });
    }
    const rows = (await resp.json()) as Array<{ failure_class: string | null }>;
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const k = r.failure_class || '(none)';
      counts[k] = (counts[k] || 0) + 1;
    }
    const classes = Object.keys(counts)
      .map((k) => ({ class: k, count: counts[k] }))
      .sort((a, b) => b.count - a.count);
    return res.json({ ok: true, classes });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /pending-approval — Rows that need a human decision.
 *
 * Reads directly from self_healing_log (authoritative) instead of
 * vtid_ledger, so rows stay visible even after the reconciler or
 * autopilot transitions the ledger row out of the `allocated/pending/…`
 * status window. A row qualifies as "awaiting approval" when:
 *   - outcome = 'pending' (not yet resolved or escalated), AND
 *   - confidence < 0.8 (below the auto-fix auto-approval threshold)
 *
 * Rows with confidence >= 0.8 and outcome='pending' are still executing
 * via the direct-dispatch path and belong in "Active Repairs", not here.
 */
router.get('/pending-approval', async (req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 200);

    // dev_autopilot_self_heal_in_progress is written by dev-autopilot-bridge
    // when it AUTO-spawns a child execution to retry. Outcome is 'pending'
    // because the retry is in flight, but no human input is requested or
    // useful — those rows belong on the Active Repairs view, not here.
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?` +
        `outcome=eq.pending&confidence=lt.0.8` +
        `&failure_class=neq.dev_autopilot_self_heal_in_progress` +
        `&select=id,vtid,endpoint,failure_class,confidence,diagnosis,created_at,attempt_number` +
        `&order=created_at.desc&limit=${limit}`,
      { headers: supabaseHeaders() },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(500).json({ ok: false, error: `Failed to query pending-approval: ${errText}` });
    }

    // Filter out rows already decided by a human (approve/reject sets
    // diagnosis.human_decision). Done client-side because PostgREST
    // jsonb path filters are awkward and the result set is small.
    const all = (await resp.json()) as any[];
    const items = all.filter(r => !(r.diagnosis && r.diagnosis.human_decision));
    return res.json({ ok: true, items, count: items.length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /approve — Human approves a sub-0.8 row from pending-approval.
 * Body: { id: number, operator?: string }
 *
 * Marks the self_healing_log row as human-approved (so it leaves the
 * Awaiting Approval list), sets vtid_ledger.spec_status='approved', and
 * dispatches the existing fix spec to the worker orchestrator with the
 * same bounded retry as the auto-approved path.
 */
router.post('/approve', async (req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }
    const { id, operator } = req.body || {};
    // self_healing_log.id is UUID. Accept only a non-empty string that
    // matches the UUID format so malformed ids fail fast with 400 and
    // never reach PostgREST (where they produced a 500 crash before).
    const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ ok: false, error: 'id (UUID string) required' });
    }

    // 1. Read the self_healing_log row
    const logResp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${id}&select=*&limit=1`,
      { headers: supabaseHeaders() },
    );
    if (!logResp.ok) {
      const errText = await logResp.text().catch(() => '');
      return res.status(500).json({ ok: false, error: `self_healing_log query failed: ${errText.slice(0, 200)}` });
    }
    const logBody = await logResp.json();
    if (!Array.isArray(logBody) || logBody.length === 0) {
      return res.status(404).json({ ok: false, error: 'self_healing_log row not found' });
    }
    const logRow = logBody[0];
    const vtid = logRow.vtid;

    // Real ledger VTIDs match `VTID-<digits>`. Dev-autopilot synthetic
    // correlation IDs (`VTID-DA-<exec>`, `VTID-DA-FIND-<finding>`) have
    // no vtid_ledger row by design — see dev-autopilot-self-heal-log.ts.
    // For those, the standard execution_approved → autopilot event loop
    // path can't dispatch (no ledger row to read), so we mark the log
    // row approved and emit a self-healing.approved signal instead.
    const isLedgerVtid = /^VTID-\d+$/.test(vtid);

    if (isLedgerVtid) {
      // 2. Read the vtid_ledger row to confirm it exists.
      const ledgerResp = await fetch(
        `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}&select=vtid,title,summary&limit=1`,
        { headers: supabaseHeaders() },
      );
      if (!ledgerResp.ok) {
        const errText = await ledgerResp.text().catch(() => '');
        return res.status(500).json({ ok: false, error: `vtid_ledger query failed: ${errText.slice(0, 200)}` });
      }
      const ledgerBody = await ledgerResp.json();
      if (!Array.isArray(ledgerBody) || ledgerBody.length === 0) {
        return res.status(404).json({ ok: false, error: `vtid_ledger row ${vtid} not found` });
      }

      // 3. Mark spec approved in vtid_ledger.
      await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({ spec_status: 'approved', updated_at: new Date().toISOString() }),
      });
    }

    // 4. Mark self_healing_log row as human-approved.
    const newDiagnosis = {
      ...(logRow.diagnosis || {}),
      human_decision: 'approved',
      human_decision_at: new Date().toISOString(),
      human_decision_by: operator || 'command-hub',
    };
    await fetch(`${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${id}`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({ diagnosis: newDiagnosis }),
    });

    // 5. Emit the appropriate approval event.
    //   - Ledger VTIDs: vtid.lifecycle.execution_approved so the autopilot
    //     event loop dispatches through the standard worker pipeline.
    //   - Synthetic VTIDs: self-healing.approved as a record-only signal
    //     (the dev-autopilot bridge owns the real retry path; this just
    //     clears the row from the human queue and leaves an audit trail).
    await emitOasisEvent({
      type: isLedgerVtid ? 'vtid.lifecycle.execution_approved' : 'self-healing.approved',
      vtid,
      source: 'self-healing',
      status: 'info',
      message: `Self-healing ${vtid} approved by ${operator || 'command-hub'}`,
      payload: {
        auto_approved: true,
        source: 'self-healing',
        operator: operator || 'command-hub',
        confidence: logRow.confidence,
        synthetic_vtid: !isLedgerVtid,
      },
    });

    return res.json({ ok: true, vtid });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /reject — Human rejects a sub-0.8 row from pending-approval.
 * Body: { id: number, operator?: string, reason?: string }
 *
 * Marks the self_healing_log row as escalated with human_rejected reason
 * so it leaves the Awaiting Approval list and lands in history.
 */
router.post('/reject', async (req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }
    const { id, operator, reason } = req.body || {};
    const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ ok: false, error: 'id (UUID string) required' });
    }

    const logResp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${id}&select=*&limit=1`,
      { headers: supabaseHeaders() },
    );
    if (!logResp.ok) {
      const errText = await logResp.text().catch(() => '');
      return res.status(500).json({ ok: false, error: `self_healing_log query failed: ${errText.slice(0, 200)}` });
    }
    const logBody = await logResp.json();
    if (!Array.isArray(logBody) || logBody.length === 0) {
      return res.status(404).json({ ok: false, error: 'self_healing_log row not found' });
    }
    const logRow = logBody[0];
    const vtid = logRow.vtid;

    const newDiagnosis = {
      ...(logRow.diagnosis || {}),
      human_decision: 'rejected',
      human_decision_at: new Date().toISOString(),
      human_decision_by: operator || 'command-hub',
      reject_reason: reason || 'no reason provided',
    };
    await fetch(`${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${id}`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({
        outcome: 'escalated',
        resolved_at: new Date().toISOString(),
        diagnosis: newDiagnosis,
      }),
    });

    await emitOasisEvent({
      type: 'self-healing.rejected',
      vtid,
      source: 'self-healing',
      status: 'info',
      message: `Self-healing ${vtid} rejected by ${operator || 'command-hub'}: ${reason || 'no reason'}`,
      payload: {
        operator: operator || 'command-hub',
        reason: reason || null,
        confidence: logRow.confidence,
      },
    });

    // Reject is a terminal human decision — no Gchat ping; the operator
    // who clicked reject already knows it happened.

    return res.json({ ok: true, vtid });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /snapshots/:vtid — Get pre/post health snapshots for a VTID
 */
router.get('/snapshots/:vtid', async (req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    const { vtid } = req.params;
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_snapshots?vtid=eq.${vtid}&select=*&order=timestamp.asc`,
      { headers: supabaseHeaders() },
    );

    if (!resp.ok) {
      return res.status(500).json({ ok: false, error: 'Failed to query snapshots' });
    }

    const snapshots = (await resp.json()) as Array<{ phase: string }>;
    const preFix = snapshots.find(s => s.phase === 'pre_fix') || null;
    const postFix = snapshots.find(s => s.phase === 'post_fix') || null;

    return res.json({ ok: true, vtid, pre_fix: preFix, post_fix: postFix });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /verify/:vtid — Manually trigger post-fix verification
 */
router.post('/verify/:vtid', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    console.log(`[self-healing] Manual verification triggered for ${vtid}`);

    const result = await verifyFixWithBlastRadiusCheck(vtid);
    return res.json({ ok: true, result });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /rollback/:vtid — Manually trigger rollback
 */
router.post('/rollback/:vtid', async (req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    const { vtid } = req.params;

    // Get pre-fix snapshot
    const snapResp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_snapshots?vtid=eq.${vtid}&phase=eq.pre_fix&select=*&limit=1`,
      { headers: supabaseHeaders() },
    );

    if (!snapResp.ok) {
      return res.status(500).json({ ok: false, error: 'Failed to get pre-fix snapshot' });
    }

    const snapshots = (await snapResp.json()) as any[];
    if (!snapshots || snapshots.length === 0) {
      return res.status(404).json({ ok: false, error: 'No pre-fix snapshot found for this VTID' });
    }

    await executeRollback(vtid, snapshots[0]);
    return res.json({ ok: true, message: `Rollback requested for ${vtid}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
export { router as selfHealingRouter };
