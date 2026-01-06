/**
 * VTID-01169: Deploy → Ledger Terminalization (IN_PROGRESS → COMPLETED)
 *
 * Provides the authoritative write path for VTID terminalization.
 *
 * Endpoints:
 *   POST /api/v1/oasis/vtid/terminalize  - Mark VTID as terminal (success/failed/cancelled)
 *   POST /api/v1/scheduler/terminalize-repair - Repair stuck VTIDs that have deploy success events
 *
 * HARD GOVERNANCE:
 * - vtid_ledger is the SINGLE SOURCE OF TRUTH for terminal state
 * - Idempotent writes only (safe to retry)
 * - All state transitions logged to OASIS events
 * - No breaking changes to existing endpoints
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const VTID = 'VTID-01169';
const router = Router();

// =============================================================================
// Schema Definitions
// =============================================================================

const TerminalizeRequestSchema = z.object({
  vtid: z.string().min(1, 'vtid required'),
  outcome: z.enum(['success', 'failed', 'cancelled']),
  run_id: z.string().optional(),
  commit_sha: z.string().optional(),
  actor: z.enum(['autodeploy', 'repair', 'manual']).optional().default('autodeploy'),
});

// =============================================================================
// Helper: Emit OASIS Event
// =============================================================================

async function emitOasisEvent(
  supabaseUrl: string,
  svcKey: string,
  payload: {
    vtid: string;
    topic: string;
    status: string;
    message: string;
    metadata: Record<string, any>;
    service?: string;
    role?: string;
  }
): Promise<{ ok: boolean; event_id?: string }> {
  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const eventPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: payload.vtid,
      topic: payload.topic,
      service: payload.service || 'vtid-terminalize',
      role: payload.role || 'DEPLOY',
      model: 'vtid-01169-terminalize',
      status: payload.status,
      message: payload.message,
      link: null,
      metadata: payload.metadata,
    };

    const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
      body: JSON.stringify(eventPayload),
    });

    if (!resp.ok) {
      console.error(`[${VTID}] Failed to emit event: ${resp.status}`);
      return { ok: false };
    }

    return { ok: true, event_id: eventId };
  } catch (e: any) {
    console.error(`[${VTID}] Event emission error:`, e.message);
    return { ok: false };
  }
}

// =============================================================================
// POST /api/v1/oasis/vtid/terminalize
// =============================================================================
/**
 * Mark a VTID as terminal in vtid_ledger.
 *
 * Request body:
 * {
 *   "vtid": "VTID-01169",
 *   "outcome": "success" | "failed" | "cancelled",
 *   "run_id": "optional-github-run-id",
 *   "commit_sha": "optional-git-commit-sha",
 *   "actor": "autodeploy" | "repair" | "manual"
 * }
 *
 * Behavior:
 * - If vtid_ledger.is_terminal = true: return { ok: true, already_terminal: true }
 * - Else: set terminal fields and return { ok: true, already_terminal: false }
 *
 * Terminal fields set:
 * - is_terminal = true
 * - terminal_outcome = outcome
 * - completed_at = now()
 * - status = 'completed' (for success) or 'failed'
 */
router.post('/api/v1/oasis/vtid/terminalize', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /api/v1/oasis/vtid/terminalize`);

  // Validate request
  const validation = TerminalizeRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors,
    });
  }

  const { vtid, outcome, run_id, commit_sha, actor } = validation.data;

  // Validate VTID format
  if (!/^VTID-\d{4,}$/.test(vtid)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_VTID_FORMAT',
      message: 'VTID must match format VTID-XXXXX (4+ digits)',
      vtid,
    });
  }

  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;

  if (!svcKey || !supabaseUrl) {
    console.error(`[${VTID}] Gateway misconfigured: Missing Supabase credentials`);
    return res.status(500).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    // Step 1: Fetch current state from vtid_ledger
    const fetchResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    });

    if (!fetchResp.ok) {
      console.error(`[${VTID}] Failed to fetch VTID ${vtid}: ${fetchResp.status}`);
      return res.status(502).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: 'Failed to query vtid_ledger',
      });
    }

    const tasks = (await fetchResp.json()) as any[];
    if (tasks.length === 0) {
      console.log(`[${VTID}] VTID not found: ${vtid}`);
      return res.status(404).json({
        ok: false,
        error: 'NOT_FOUND',
        message: `VTID ${vtid} not found in vtid_ledger`,
        vtid,
      });
    }

    const task = tasks[0];

    // Step 2: Check idempotency - already terminal
    if (task.is_terminal === true) {
      console.log(`[${VTID}] VTID ${vtid} already terminal (idempotent response)`);
      return res.status(200).json({
        ok: true,
        vtid,
        already_terminal: true,
        status: task.status,
        is_terminal: true,
        terminal_outcome: task.terminal_outcome,
        terminal_at: task.completed_at,
      });
    }

    // Step 3: Update vtid_ledger with terminal fields
    const timestamp = new Date().toISOString();
    const newStatus = outcome === 'success' ? 'completed' : outcome === 'failed' ? 'failed' : 'cancelled';

    const updatePayload = {
      status: newStatus,
      is_terminal: true,
      terminal_outcome: outcome,
      completed_at: timestamp,
      updated_at: timestamp,
    };

    const updateResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(updatePayload),
    });

    if (!updateResp.ok) {
      const text = await updateResp.text();
      console.error(`[${VTID}] Failed to update VTID ${vtid}: ${updateResp.status} - ${text}`);
      return res.status(502).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: 'Failed to update vtid_ledger',
      });
    }

    const updatedTasks = (await updateResp.json()) as any[];
    const updated = updatedTasks[0];

    console.log(`[${VTID}] VTID ${vtid} terminalized: outcome=${outcome}, actor=${actor}`);

    // Step 4: Emit OASIS event for traceability
    const eventResult = await emitOasisEvent(supabaseUrl, svcKey, {
      vtid,
      topic: 'vtid.terminalize.success',
      status: outcome === 'success' ? 'success' : 'error',
      message: `VTID ${vtid} terminalized with outcome: ${outcome}`,
      metadata: {
        vtid,
        outcome,
        actor,
        run_id: run_id || null,
        commit_sha: commit_sha || null,
        previous_status: task.status,
        previous_is_terminal: task.is_terminal,
        terminal_at: timestamp,
      },
    });

    if (!eventResult.ok) {
      console.warn(`[${VTID}] Event emission failed for ${vtid}, but terminalization succeeded`);
    }

    return res.status(200).json({
      ok: true,
      vtid,
      already_terminal: false,
      status: updated.status,
      is_terminal: updated.is_terminal,
      terminal_outcome: updated.terminal_outcome,
      terminal_at: updated.completed_at,
      event_id: eventResult.event_id,
    });
  } catch (e: any) {
    console.error(`[${VTID}] Unexpected error:`, e);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: e.message,
    });
  }
});

// =============================================================================
// POST /api/v1/scheduler/terminalize-repair
// =============================================================================
/**
 * Repair stuck VTIDs that should be terminal.
 *
 * Finds VTIDs where:
 * - is_terminal = false
 * - status = 'in_progress' (or similar active status)
 * - oasis_events contains vtid.stage.deploy.success OR deploy.*.success
 *
 * For matching VTIDs, calls terminalize function and marks terminal.
 *
 * Request body (optional):
 * {
 *   "dry_run": false,  // If true, don't actually terminalize
 *   "limit": 50        // Max VTIDs to process
 * }
 *
 * Returns:
 * {
 *   "ok": true,
 *   "scanned": 100,
 *   "terminalized": 5,
 *   "skipped_already_terminal": 2,
 *   "errors": 0,
 *   "details": [...]
 * }
 */
router.post('/api/v1/scheduler/terminalize-repair', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /api/v1/scheduler/terminalize-repair`);

  const dryRun = req.body?.dry_run === true;
  const limit = Math.min(Math.max(parseInt(req.body?.limit) || 100, 1), 500);

  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;

  if (!svcKey || !supabaseUrl) {
    console.error(`[${VTID}] Gateway misconfigured: Missing Supabase credentials`);
    return res.status(500).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    const startTime = Date.now();

    // Step 1: Find non-terminal VTIDs with active status
    // Active statuses that could be stuck
    const activeStatuses = ['in_progress', 'running', 'active', 'validating'];
    const statusFilter = activeStatuses.map((s) => `status.eq.${s}`).join(',');

    const ledgerResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?is_terminal=eq.false&or=(${statusFilter})&limit=${limit}&order=updated_at.asc`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      }
    );

    if (!ledgerResp.ok) {
      console.error(`[${VTID}] Failed to query ledger: ${ledgerResp.status}`);
      return res.status(502).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: 'Failed to query vtid_ledger',
      });
    }

    const nonTerminalVtids = (await ledgerResp.json()) as any[];
    console.log(`[${VTID}] Repair: Found ${nonTerminalVtids.length} non-terminal active VTIDs`);

    if (nonTerminalVtids.length === 0) {
      return res.status(200).json({
        ok: true,
        scanned: 0,
        terminalized: 0,
        skipped_already_terminal: 0,
        skipped_no_deploy_success: 0,
        errors: 0,
        dry_run: dryRun,
        elapsed_ms: Date.now() - startTime,
        details: [],
      });
    }

    // Step 2: For each non-terminal VTID, check if deploy success event exists
    const vtidList = nonTerminalVtids.map((v: any) => v.vtid);
    const vtidFilter = `vtid=in.(${vtidList.join(',')})`;

    // Fetch deploy success events for these VTIDs
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?${vtidFilter}&or=(topic.like.deploy.%.success,topic.eq.vtid.stage.deploy.success,topic.eq.vtid.lifecycle.completed)&limit=1000`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      }
    );

    let deploySuccessEvents: any[] = [];
    if (eventsResp.ok) {
      deploySuccessEvents = (await eventsResp.json()) as any[];
    }

    // Build set of VTIDs with deploy success
    const vtidsWithDeploySuccess = new Set<string>();
    for (const event of deploySuccessEvents) {
      if (event.vtid) {
        vtidsWithDeploySuccess.add(event.vtid);
      }
    }

    console.log(`[${VTID}] Repair: ${vtidsWithDeploySuccess.size} VTIDs have deploy success events`);

    // Step 3: Terminalize VTIDs that have deploy success but aren't terminal
    const results: any[] = [];
    let terminalized = 0;
    let skippedNoDeploySuccess = 0;
    let errors = 0;

    for (const vtidRow of nonTerminalVtids) {
      const vtid = vtidRow.vtid;

      if (!vtidsWithDeploySuccess.has(vtid)) {
        // No deploy success event - skip
        skippedNoDeploySuccess++;
        results.push({
          vtid,
          action: 'skipped',
          reason: 'no_deploy_success_event',
        });
        continue;
      }

      // This VTID has deploy success but isn't terminal - repair it
      if (dryRun) {
        results.push({
          vtid,
          action: 'would_terminalize',
          current_status: vtidRow.status,
        });
        terminalized++;
        continue;
      }

      // Actually terminalize
      const timestamp = new Date().toISOString();
      const updatePayload = {
        status: 'completed',
        is_terminal: true,
        terminal_outcome: 'success',
        completed_at: timestamp,
        updated_at: timestamp,
      };

      const updateResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
        body: JSON.stringify(updatePayload),
      });

      if (updateResp.ok) {
        // Emit terminalize event
        await emitOasisEvent(supabaseUrl, svcKey, {
          vtid,
          topic: 'vtid.terminalize.success',
          status: 'success',
          message: `VTID ${vtid} terminalized by repair job`,
          metadata: {
            vtid,
            outcome: 'success',
            actor: 'repair',
            previous_status: vtidRow.status,
            repair_reason: 'deploy_success_event_present',
            repaired_at: timestamp,
          },
        });

        terminalized++;
        results.push({
          vtid,
          action: 'terminalized',
          previous_status: vtidRow.status,
        });
      } else {
        errors++;
        results.push({
          vtid,
          action: 'error',
          error: `Update failed: ${updateResp.status}`,
        });
      }
    }

    const elapsed_ms = Date.now() - startTime;

    // Step 4: Emit repair summary event
    await emitOasisEvent(supabaseUrl, svcKey, {
      vtid: VTID,
      topic: 'vtid.terminalizer.repair.summary',
      status: errors > 0 ? 'warning' : 'success',
      message: `Repair job completed: ${terminalized} terminalized, ${errors} errors`,
      service: 'vtid-terminalize-repair',
      role: 'GOVERNANCE',
      metadata: {
        scanned: nonTerminalVtids.length,
        terminalized,
        skipped_no_deploy_success: skippedNoDeploySuccess,
        errors,
        dry_run: dryRun,
        elapsed_ms,
        repaired_vtids: results.filter((r) => r.action === 'terminalized').map((r) => r.vtid),
      },
    });

    console.log(
      `[${VTID}] Repair complete: scanned=${nonTerminalVtids.length}, terminalized=${terminalized}, skipped=${skippedNoDeploySuccess}, errors=${errors}, elapsed=${elapsed_ms}ms`
    );

    return res.status(200).json({
      ok: true,
      scanned: nonTerminalVtids.length,
      terminalized,
      skipped_no_deploy_success: skippedNoDeploySuccess,
      errors,
      dry_run: dryRun,
      elapsed_ms,
      details: results,
    });
  } catch (e: any) {
    console.error(`[${VTID}] Repair job error:`, e);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: e.message,
    });
  }
});

// =============================================================================
// GET /api/v1/oasis/vtid/terminalize/health
// =============================================================================
/**
 * Health check for terminalize service
 */
router.get('/api/v1/oasis/vtid/terminalize/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'vtid-terminalize',
    vtid: VTID,
    timestamp: new Date().toISOString(),
  });
});

export default router;
