/**
 * VTID-01169: Deploy → Ledger Terminalization (IN_PROGRESS → COMPLETED)
 * VTID-01204: Pipeline Integrity Gates - Require full pipeline completion before terminalization
 *
 * Provides the authoritative write path for VTID terminalization.
 *
 * Endpoints:
 *   POST /api/v1/oasis/vtid/terminalize  - Mark VTID as terminal (success/failed/cancelled)
 *   POST /api/v1/scheduler/terminalize-repair - Repair stuck VTIDs that have deploy success events
 *
 * HARD GOVERNANCE (VTID-01204):
 * - vtid_ledger is the SINGLE SOURCE OF TRUTH for terminal state
 * - Idempotent writes only (safe to retry)
 * - All state transitions logged to OASIS events
 * - No breaking changes to existing endpoints
 * - CRITICAL: Tasks can ONLY be marked completed after FULL PIPELINE COMPLETION:
 *   1. PR must be created (pr.created event or pr_number field)
 *   2. PR must be merged (merged event or merge_sha field)
 *   3. Validator must pass (validation.passed event)
 *   4. Deploy must succeed (deploy.success event)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const VTID = 'VTID-01169';
const VTID_INTEGRITY = 'VTID-01204'; // Pipeline integrity gates
const router = Router();

// =============================================================================
// VTID-01204: Pipeline Integrity Gate - Required Events for Completion
// =============================================================================

/**
 * Pipeline stages that MUST be completed before marking a task as terminal.
 * Each stage is verified by checking for specific OASIS events.
 */
interface PipelineEvidence {
  has_pr_created: boolean;
  has_merged: boolean;
  has_validator_passed: boolean;
  has_deploy_success: boolean;
  pr_number?: string;
  merge_sha?: string;
  events_found: string[];
}

/**
 * Check if a VTID has completed the full autonomous pipeline.
 * CRITICAL: This prevents false completion claims.
 *
 * Required evidence for completion:
 * 1. PR Created: vtid.stage.pr.created, cicd.github.create_pr.success, or pr_number field
 * 2. Merged: vtid.stage.merged, cicd.github.safe_merge.executed, or merge_sha field
 * 3. Validator Passed: autopilot.validation.passed, vtid.stage.validated
 * 4. Deploy Success: deploy.*.success, vtid.stage.deploy.success
 */
async function checkPipelineEvidence(
  supabaseUrl: string,
  svcKey: string,
  vtid: string
): Promise<PipelineEvidence> {
  const evidence: PipelineEvidence = {
    has_pr_created: false,
    has_merged: false,
    has_validator_passed: false,
    has_deploy_success: false,
    events_found: [],
  };

  try {
    // Check ledger for direct evidence (pr_number, merge_sha)
    const ledgerResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}&select=pr_number,pr_url,merge_sha,validator_result`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      }
    );

    if (ledgerResp.ok) {
      const ledgerData = (await ledgerResp.json()) as any[];
      if (ledgerData.length > 0) {
        const task = ledgerData[0];
        if (task.pr_number || task.pr_url) {
          evidence.has_pr_created = true;
          evidence.pr_number = task.pr_number;
          evidence.events_found.push('ledger:pr_number');
        }
        if (task.merge_sha) {
          evidence.has_merged = true;
          evidence.merge_sha = task.merge_sha;
          evidence.events_found.push('ledger:merge_sha');
        }
        if (task.validator_result === 'passed' || task.validator_result === 'success') {
          evidence.has_validator_passed = true;
          evidence.events_found.push('ledger:validator_result');
        }
      }
    }

    // Check OASIS events for pipeline stage completion
    // Query all relevant events for this VTID
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${vtid}&select=topic,status,message,created_at&order=created_at.desc&limit=500`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      }
    );

    if (eventsResp.ok) {
      const events = (await eventsResp.json()) as any[];

      for (const event of events) {
        const topic = event.topic?.toLowerCase() || '';

        // PR Created evidence
        if (
          topic.includes('pr.created') ||
          topic.includes('create_pr.success') ||
          topic.includes('pull_request.opened')
        ) {
          evidence.has_pr_created = true;
          evidence.events_found.push(`event:${event.topic}`);
        }

        // Merged evidence
        if (
          topic.includes('.merged') ||
          topic.includes('safe_merge.executed') ||
          topic.includes('safe_merge.success') ||
          topic.includes('pull_request.merged')
        ) {
          evidence.has_merged = true;
          evidence.events_found.push(`event:${event.topic}`);
        }

        // Validator passed evidence
        if (
          topic.includes('validation.passed') ||
          topic.includes('validated') ||
          topic.includes('validator.success')
        ) {
          evidence.has_validator_passed = true;
          evidence.events_found.push(`event:${event.topic}`);
        }

        // Deploy success evidence
        if (
          topic.includes('deploy') &&
          (topic.includes('success') || event.status === 'success')
        ) {
          evidence.has_deploy_success = true;
          evidence.events_found.push(`event:${event.topic}`);
        }

        // Lifecycle completed (indicates full pipeline)
        if (topic === 'vtid.lifecycle.completed') {
          evidence.has_pr_created = true;
          evidence.has_merged = true;
          evidence.has_validator_passed = true;
          evidence.has_deploy_success = true;
          evidence.events_found.push('event:vtid.lifecycle.completed');
        }
      }
    }
  } catch (e: any) {
    console.error(`[${VTID_INTEGRITY}] Error checking pipeline evidence for ${vtid}:`, e.message);
  }

  return evidence;
}

/**
 * Validate that pipeline evidence is sufficient for completion.
 * Returns { valid: true } if all required stages are complete.
 * Returns { valid: false, missing: [...] } if stages are missing.
 */
function validatePipelineEvidence(
  evidence: PipelineEvidence,
  outcome: 'success' | 'failed' | 'cancelled'
): { valid: boolean; missing: string[] } {
  // For failed/cancelled outcomes, we don't require full pipeline
  if (outcome !== 'success') {
    return { valid: true, missing: [] };
  }

  const missing: string[] = [];

  if (!evidence.has_pr_created) {
    missing.push('PR_CREATED');
  }
  if (!evidence.has_merged) {
    missing.push('MERGED');
  }
  if (!evidence.has_validator_passed) {
    missing.push('VALIDATOR_PASSED');
  }
  if (!evidence.has_deploy_success) {
    missing.push('DEPLOY_SUCCESS');
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Check if pipeline integrity gates can be bypassed.
 * Only allowed for:
 * - Explicit governance override key
 * - Admin/governance role
 * - Failed/cancelled outcomes (don't need full pipeline)
 */
function canBypassPipelineGates(
  req: Request,
  outcome: 'success' | 'failed' | 'cancelled'
): { allowed: boolean; reason: string } {
  // Failed/cancelled outcomes don't need full pipeline
  if (outcome !== 'success') {
    return { allowed: true, reason: `outcome=${outcome}` };
  }

  const role = req.headers['x-vitana-role'] as string | undefined;
  const overrideKey = req.headers['x-governance-override-key'] as string | undefined;
  const expectedOverrideKey = process.env.GOVERNANCE_OVERRIDE_KEY;

  // Allow with valid governance override key
  if (expectedOverrideKey && overrideKey === expectedOverrideKey) {
    return { allowed: true, reason: 'governance_override_key' };
  }

  // Allow for governance role
  if (role === 'governance') {
    return { allowed: true, reason: 'role=governance' };
  }

  return { allowed: false, reason: 'Pipeline integrity gates require full pipeline completion or governance override' };
}

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

    // VTID-01204: Pipeline Integrity Gate - Check for full pipeline completion
    const bypassCheck = canBypassPipelineGates(req, outcome);
    if (!bypassCheck.allowed) {
      console.log(`[${VTID_INTEGRITY}] Checking pipeline evidence for ${vtid}`);
      const evidence = await checkPipelineEvidence(supabaseUrl, svcKey, vtid);
      const validation = validatePipelineEvidence(evidence, outcome);

      if (!validation.valid) {
        console.warn(
          `[${VTID_INTEGRITY}] BLOCKED: ${vtid} missing pipeline stages: ${validation.missing.join(', ')}`
        );

        // Emit governance audit event for blocked terminalization
        await emitOasisEvent(supabaseUrl, svcKey, {
          vtid,
          topic: 'vtid.governance.terminalize_blocked',
          status: 'warning',
          message: `Terminalization blocked for ${vtid}: missing pipeline stages`,
          metadata: {
            vtid,
            outcome,
            actor,
            missing_stages: validation.missing,
            evidence_found: evidence.events_found,
            blocked_at: new Date().toISOString(),
            governance_vtid: VTID_INTEGRITY,
          },
        });

        return res.status(400).json({
          ok: false,
          error: 'PIPELINE_INCOMPLETE',
          message: `Cannot mark ${vtid} as completed: missing required pipeline stages`,
          missing_stages: validation.missing,
          evidence_found: evidence.events_found,
          hint: 'Task must complete PR creation, merge, validation, and deploy before terminalization',
          governance_vtid: VTID_INTEGRITY,
        });
      }

      console.log(`[${VTID_INTEGRITY}] Pipeline evidence verified for ${vtid}: ${evidence.events_found.join(', ')}`);
    } else {
      console.log(`[${VTID_INTEGRITY}] Pipeline gate bypassed for ${vtid}: ${bypassCheck.reason}`);
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
 * VTID-01204: Now requires FULL PIPELINE COMPLETION, not just deploy success.
 *
 * Finds VTIDs where:
 * - is_terminal = false
 * - status = 'in_progress' (or similar active status)
 * - MUST have ALL of:
 *   1. PR created event (vtid.stage.pr.created, cicd.github.create_pr.success)
 *   2. Merged event (vtid.stage.merged, cicd.github.safe_merge.executed)
 *   3. Validator passed event (autopilot.validation.passed)
 *   4. Deploy success event (deploy.*.success, vtid.stage.deploy.success)
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
 *   "skipped_incomplete_pipeline": 10,
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

    // VTID-01204: For each non-terminal VTID, check for FULL PIPELINE completion
    // Not just deploy success - must have PR created, merged, validated, AND deployed
    const results: any[] = [];
    let terminalized = 0;
    let skippedIncompletePipeline = 0;
    let errors = 0;

    console.log(`[${VTID_INTEGRITY}] Repair: Checking full pipeline evidence for ${nonTerminalVtids.length} VTIDs`);

    for (const vtidRow of nonTerminalVtids) {
      const vtid = vtidRow.vtid;

      // Check for FULL pipeline evidence (not just deploy success)
      const evidence = await checkPipelineEvidence(supabaseUrl, svcKey, vtid);
      const validation = validatePipelineEvidence(evidence, 'success');

      if (!validation.valid) {
        // Pipeline incomplete - skip this VTID
        skippedIncompletePipeline++;
        results.push({
          vtid,
          action: 'skipped',
          reason: 'incomplete_pipeline',
          missing_stages: validation.missing,
          evidence_found: evidence.events_found,
        });
        continue;
      }

      // This VTID has FULL pipeline completion but isn't terminal - repair it
      console.log(`[${VTID_INTEGRITY}] ${vtid} has full pipeline evidence: ${evidence.events_found.join(', ')}`);

      if (dryRun) {
        results.push({
          vtid,
          action: 'would_terminalize',
          current_status: vtidRow.status,
          evidence_found: evidence.events_found,
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
        // Emit terminalize event with pipeline evidence
        await emitOasisEvent(supabaseUrl, svcKey, {
          vtid,
          topic: 'vtid.terminalize.success',
          status: 'success',
          message: `VTID ${vtid} terminalized by repair job (full pipeline verified)`,
          metadata: {
            vtid,
            outcome: 'success',
            actor: 'repair',
            previous_status: vtidRow.status,
            repair_reason: 'full_pipeline_verified',
            pipeline_evidence: {
              pr_created: evidence.has_pr_created,
              merged: evidence.has_merged,
              validator_passed: evidence.has_validator_passed,
              deploy_success: evidence.has_deploy_success,
            },
            evidence_events: evidence.events_found,
            repaired_at: timestamp,
            governance_vtid: VTID_INTEGRITY,
          },
        });

        terminalized++;
        results.push({
          vtid,
          action: 'terminalized',
          previous_status: vtidRow.status,
          evidence_found: evidence.events_found,
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
      message: `Repair job completed: ${terminalized} terminalized, ${skippedIncompletePipeline} skipped (incomplete pipeline), ${errors} errors`,
      service: 'vtid-terminalize-repair',
      role: 'GOVERNANCE',
      metadata: {
        scanned: nonTerminalVtids.length,
        terminalized,
        skipped_incomplete_pipeline: skippedIncompletePipeline,
        errors,
        dry_run: dryRun,
        elapsed_ms,
        repaired_vtids: results.filter((r) => r.action === 'terminalized').map((r) => r.vtid),
        skipped_vtids: results.filter((r) => r.action === 'skipped').map((r) => ({
          vtid: r.vtid,
          missing: r.missing_stages,
        })),
        governance_vtid: VTID_INTEGRITY,
      },
    });

    console.log(
      `[${VTID_INTEGRITY}] Repair complete: scanned=${nonTerminalVtids.length}, terminalized=${terminalized}, skipped_incomplete=${skippedIncompletePipeline}, errors=${errors}, elapsed=${elapsed_ms}ms`
    );

    return res.status(200).json({
      ok: true,
      scanned: nonTerminalVtids.length,
      terminalized,
      skipped_incomplete_pipeline: skippedIncompletePipeline,
      errors,
      dry_run: dryRun,
      elapsed_ms,
      governance_vtid: VTID_INTEGRITY,
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
