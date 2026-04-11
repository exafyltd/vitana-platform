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
import {
  HealthReport,
  ServiceStatus,
  SelfHealingReportResponse,
  AutonomyLevel,
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

async function getAutonomyLevel(): Promise<AutonomyLevel> {
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
      if (total >= 2) {
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

async function processFailingService(
  failure: ServiceStatus,
  autonomyLevel: AutonomyLevel,
): Promise<{ action: 'created' | 'skipped' | 'escalated' | 'disabled'; vtid?: string; reason?: string }> {
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

  // If not auto-fixable and low confidence, escalate
  if (!diagnosis.auto_fixable && diagnosis.confidence < 0.5) {
    await notifyGChat(
      `🚨 *Self-Healing Escalation*\n` +
      `Task: ${vtid}\n` +
      `Service: ${diagnosis.service_name}\n` +
      `Confidence: ${(diagnosis.confidence * 100).toFixed(0)}% — too low for autonomous fix\n` +
      `Root cause: ${diagnosis.root_cause.substring(0, 200)}\n` +
      `Action required: Manual investigation needed`,
    );
    return { action: 'escalated', vtid, reason: `Low confidence (${(diagnosis.confidence * 100).toFixed(0)}%)` };
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

  // For auto-approved tasks: directly dispatch to worker orchestrator
  // with bounded retry (autopilot event loop is the backup, but a single
  // transient 5xx / network blip used to leave rows pending until the
  // reconciler tombstoned them).
  if (diagnosis.confidence >= 0.8 && diagnosis.auto_fixable) {
    const dispatch = await dispatchToWorkerWithRetry(
      vtid,
      `SELF-HEAL: ${diagnosis.service_name} — ${diagnosis.failure_class}`,
      spec,
    );
    if (!dispatch.ok) {
      console.error(`[self-healing] ${vtid} dispatch failed after retries: ${dispatch.lastError}`);
      await emitOasisEvent({
        type: 'self-healing.dispatch.failed',
        vtid,
        source: 'self-healing',
        status: 'error',
        message: `Worker orchestrator dispatch failed after retries: ${dispatch.lastError}`,
        payload: {
          last_error: dispatch.lastError,
          confidence: diagnosis.confidence,
          service: diagnosis.service_name,
        },
      });
      // Real-time Gchat alert — autopilot couldn't dispatch, team needs
      // to investigate or manually approve.
      await notifyGChat(
        `🚨 *Self-Healing Dispatch FAILED*\n` +
        `Task: ${vtid}\n` +
        `Service: ${diagnosis.service_name}\n` +
        `Endpoint: ${diagnosis.endpoint}\n` +
        `Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%\n` +
        `Error: ${dispatch.lastError}\n` +
        `Autopilot exhausted retries. Reconciler will attempt redispatch within 1h.\n` +
        `Act now: ${COMMAND_HUB_SH_URL}`,
      );
    }
  }

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

    for (const failure of downServices) {
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

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?` +
        `select=*&order=created_at.desc&limit=${limit}&offset=${offset}`,
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

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?` +
        `outcome=eq.pending&confidence=lt.0.8` +
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
 * Helper: dispatch a self-healing VTID to the worker orchestrator with
 * bounded retry. Used by both the auto-approved direct-dispatch path
 * (in runHealing) and the human-approve path below. Returns true on
 * success, false after maxAttempts failures.
 */
async function dispatchToWorkerWithRetry(
  vtid: string,
  title: string,
  spec: string,
  maxAttempts = 3,
): Promise<{ ok: boolean; lastError?: string }> {
  const gatewayUrl = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[self-healing] ${vtid} dispatch attempt ${attempt}/${maxAttempts}`);
      const resp = await fetch(`${gatewayUrl}/api/v1/worker/orchestrator/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vtid,
          title,
          spec: spec.substring(0, 8000),
          source: 'self-healing',
          priority: 'critical',
        }),
      });

      if (resp.ok) {
        console.log(`[self-healing] ${vtid} dispatch ok on attempt ${attempt}`);
        return { ok: true };
      }
      lastError = `HTTP ${resp.status}`;
    } catch (err: any) {
      lastError = err.message;
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  return { ok: false, lastError };
}

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
    if (!id || typeof id !== 'number') {
      return res.status(400).json({ ok: false, error: 'id (number) required' });
    }

    // 1. Read the self_healing_log row
    const logResp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${id}&select=*&limit=1`,
      { headers: supabaseHeaders() },
    );
    const logRows = (await logResp.json()) as any[];
    if (!logRows || logRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'self_healing_log row not found' });
    }
    const logRow = logRows[0];
    const vtid = logRow.vtid;

    // 2. Read the vtid_ledger row to get title + spec
    const ledgerResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}&select=vtid,title,summary&limit=1`,
      { headers: supabaseHeaders() },
    );
    const ledgerRows = (await ledgerResp.json()) as any[];
    if (!ledgerRows || ledgerRows.length === 0) {
      return res.status(404).json({ ok: false, error: `vtid_ledger row ${vtid} not found` });
    }
    const ledgerRow = ledgerRows[0];

    // 3. Mark spec approved in vtid_ledger
    await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({ spec_status: 'approved', updated_at: new Date().toISOString() }),
    });

    // 4. Dispatch with bounded retry
    const dispatch = await dispatchToWorkerWithRetry(
      vtid,
      ledgerRow.title || `SELF-HEAL: ${vtid}`,
      ledgerRow.summary || '',
    );

    // 5. Mark self_healing_log row as human-approved (regardless of dispatch outcome —
    //    the OASIS event captures the dispatch failure separately)
    const newDiagnosis = {
      ...(logRow.diagnosis || {}),
      human_decision: 'approved',
      human_decision_at: new Date().toISOString(),
      human_decision_by: operator || 'command-hub',
      human_dispatch_ok: dispatch.ok,
      human_dispatch_error: dispatch.lastError,
    };
    await fetch(`${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${id}`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({ diagnosis: newDiagnosis }),
    });

    // 6. Emit OASIS event
    await emitOasisEvent({
      type: dispatch.ok ? 'self-healing.approved' : 'self-healing.dispatch.failed',
      vtid,
      source: 'self-healing',
      status: dispatch.ok ? 'info' : 'error',
      message: dispatch.ok
        ? `Self-healing ${vtid} approved by ${operator || 'command-hub'} and dispatched`
        : `Self-healing ${vtid} approved but dispatch failed: ${dispatch.lastError}`,
      payload: {
        operator: operator || 'command-hub',
        confidence: logRow.confidence,
        dispatch_ok: dispatch.ok,
        dispatch_error: dispatch.lastError,
      },
    });

    // Gchat notification ONLY on failure — a successful approve is a
    // "done" state the operator who clicked the button already knows
    // about. If the dispatch failed, manual retry is needed.
    if (!dispatch.ok) {
      await notifyGChat(
        `🚨 *Self-Healing Approved but Dispatch FAILED*\n` +
        `Task: ${vtid}\n` +
        `Operator: ${operator || 'command-hub'}\n` +
        `Error: ${dispatch.lastError}\n` +
        `Manual retry needed: ${COMMAND_HUB_SH_URL}`,
      );
    }

    return res.json({ ok: true, vtid, dispatched: dispatch.ok, error: dispatch.lastError });
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
    if (!id || typeof id !== 'number') {
      return res.status(400).json({ ok: false, error: 'id (number) required' });
    }

    const logResp = await fetch(
      `${SUPABASE_URL}/rest/v1/self_healing_log?id=eq.${id}&select=*&limit=1`,
      { headers: supabaseHeaders() },
    );
    const logRows = (await logResp.json()) as any[];
    if (!logRows || logRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'self_healing_log row not found' });
    }
    const logRow = logRows[0];
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
