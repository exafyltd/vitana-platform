/**
 * Worker Orchestrator Routes - VTID-01163 + VTID-01183
 *
 * API endpoints for the Worker Orchestrator that routes work orders
 * to specialized domain subagents (frontend, backend, memory).
 *
 * VTID-01183: Added worker connector endpoints for autonomous task execution:
 * - Worker registration and heartbeat
 * - Task polling and atomic claiming
 * - Progress reporting with OASIS events
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { emitOasisEvent } from '../services/oasis-event-service';
import { isAutopilotExecutionArmed } from '../services/system-controls-service';
import {
  routeWorkOrder,
  markOrchestratorSuccess,
  markOrchestratorFailed,
  emitSubagentStart,
  emitSubagentSuccess,
  emitSubagentFailed,
  completeSubagentWithVerification,
  completeOrchestratorWithVerification,
  TaskDomain,
  WorkOrderPayload,
  SubagentResult
} from '../services/worker-orchestrator-service';
import { runPreflightChain, listSkills, getPreflightChains } from '../services/skills/preflight-runner';
import { fetchServiceTierAgents } from './agents-registry';
import {
  getSpecDomain,
  getSpecTargetPaths,
  getSpecText,
  getVtidSpec,
} from '../services/vtid-spec-service';

// ---------------------------------------------------------------------------
// Self-healing log sync: when a self-healing VTID completes or fails in the
// worker pipeline, update self_healing_log.outcome immediately so the
// Command Hub panel shows the real status instead of waiting for the reconciler.
// ---------------------------------------------------------------------------
const SH_SUPABASE_URL = process.env.SUPABASE_URL;
const SH_SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE;

async function syncSelfHealingLog(vtid: string, success: boolean): Promise<void> {
  if (!SH_SUPABASE_URL || !SH_SUPABASE_SVC) return;
  try {
    const resp = await fetch(
      `${SH_SUPABASE_URL}/rest/v1/self_healing_log?vtid=eq.${vtid}&outcome=eq.pending`,
      {
        method: 'PATCH',
        headers: {
          apikey: SH_SUPABASE_SVC,
          Authorization: `Bearer ${SH_SUPABASE_SVC}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          outcome: success ? 'fixed' : 'failed',
          resolved_at: new Date().toISOString(),
        }),
      },
    );
    if (resp.ok) {
      console.log(`[self-healing-sync] ${vtid}: outcome=${success ? 'fixed' : 'failed'}`);
    }
  } catch {
    // Non-fatal — reconciler catches it eventually
  }
}

export const workerOrchestratorRouter = Router();

// =============================================================================
// VTID-01175 + VTID-01204: Governance Control for skip_verification
// =============================================================================

/**
 * Check if skip_verification is allowed based on governance rules.
 *
 * VTID-01204: STRICTER ENFORCEMENT - Prevents false completion claims
 *
 * Allowed ONLY when:
 * - Environment is explicitly 'test' or 'ci' (NOT dev/sandbox - those still need verification)
 * - Request includes valid governance_override_key (for admin use)
 * - Caller is governance role specifically (not just admin/staff)
 *
 * BLOCKED for:
 * - Production environments
 * - Dev/sandbox environments (these should still run verification)
 * - Missing domain or result (these indicate incomplete work)
 */
function isSkipVerificationAllowed(req: Request): { allowed: boolean; reason: string } {
  const env = process.env.VITANA_ENVIRONMENT || 'production';
  const role = req.headers['x-vitana-role'] as string | undefined;
  const overrideKey = req.headers['x-governance-override-key'] as string | undefined;
  const expectedOverrideKey = process.env.GOVERNANCE_OVERRIDE_KEY;
  const envLower = env.toLowerCase();

  // VTID-01204: Only allow skip in explicit test/CI environments
  // Dev and sandbox environments should still run verification to catch issues early
  if (envLower === 'test' || envLower === 'ci' || envLower === 'testing') {
    return { allowed: true, reason: `environment=${env}` };
  }

  // Allow with valid governance override key (explicit admin action)
  if (expectedOverrideKey && overrideKey === expectedOverrideKey) {
    return { allowed: true, reason: 'governance_override_key' };
  }

  // VTID-01204: Only governance role can skip - not admin/staff
  // This prevents accidental bypasses
  if (role === 'governance') {
    return { allowed: true, reason: `role=${role}` };
  }

  return {
    allowed: false,
    reason: 'skip_verification requires test environment, governance role, or governance override key (VTID-01204)',
  };
}

/**
 * Emit OASIS governance event when skip_verification is used.
 * VTID-01204: This creates an audit trail for all verification bypasses.
 * These events are critical for governance compliance tracking.
 */
async function emitSkipVerificationEvent(
  vtid: string,
  endpoint: 'subagent/complete' | 'orchestrator/complete',
  reason: string,
  requestInfo: { domain?: string; run_id: string; caller_ip?: string }
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: 'vtid.governance.verification_skipped' as any,
    source: 'worker-orchestrator',
    status: 'warning',
    message: `[VTID-01204] Verification skipped for ${vtid} at ${endpoint} - AUDIT REQUIRED`,
    payload: {
      vtid,
      endpoint,
      skip_reason: reason,
      domain: requestInfo.domain,
      run_id: requestInfo.run_id,
      caller_ip: requestInfo.caller_ip,
      timestamp: new Date().toISOString(),
      governance_vtid: 'VTID-01204',
      severity: 'audit_required',
    }
  });
}

// =============================================================================
// Request Schemas
// =============================================================================

/**
 * VTID-01207: Added 'infra' and 'ai' to task_domain enum
 */
const WorkOrderSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4,}$/, 'Invalid VTID format'),
  title: z.string().min(1, 'Title is required'),
  task_family: z.string().default('DEV'),
  task_domain: z.enum(['frontend', 'backend', 'memory', 'infra', 'ai', 'mixed']).optional(),
  target_paths: z.array(z.string()).optional(),
  change_budget: z.object({
    max_files: z.number().min(1).optional(),
    max_directories: z.number().min(1).optional()
  }).optional(),
  spec_content: z.string().optional(),
  run_id: z.string().optional()
});

/**
 * VTID-01207: Added 'infra' and 'ai' to domain enum
 */
const SubagentEventSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4,}$/, 'Invalid VTID format'),
  domain: z.enum(['frontend', 'backend', 'memory', 'infra', 'ai']),
  run_id: z.string(),
  started_at: z.string().datetime().optional(), // VTID-01175: For file modification verification
  skip_verification: z.boolean().optional(), // VTID-01175: Opt-out (for testing/legacy)
  result: z.object({
    ok: z.boolean(),
    files_changed: z.array(z.string()).optional(),
    files_created: z.array(z.string()).optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    violations: z.array(z.string()).optional()
  }).optional()
});

/**
 * VTID-01207: Added 'infra' and 'ai' to domain enum
 */
const OrchestratorCompleteSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4,}$/, 'Invalid VTID format'),
  run_id: z.string(),
  domain: z.enum(['frontend', 'backend', 'memory', 'infra', 'ai', 'mixed']).optional(), // VTID-01175: For verification
  success: z.boolean(),
  summary: z.string().optional(),
  error: z.string().optional(),
  started_at: z.string().datetime().optional(), // VTID-01175: For file modification verification
  skip_verification: z.boolean().optional(), // VTID-01175: Opt-out (for testing/legacy)
  result: z.object({
    files_changed: z.array(z.string()).optional(),
    files_created: z.array(z.string()).optional()
  }).optional()
});

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /api/v1/worker/orchestrator/route
 *
 * Route a work order to the appropriate subagent.
 * VTID-01167: Now runs preflight skill chains (VTID-01164) before routing.
 * VTID-01187: Requires autopilot_execution_enabled to be ARMED.
 * Does NOT execute the work - just determines routing and emits events.
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/route', async (req: Request, res: Response) => {
  try {
    // VTID-01187: Check governance control before any side-effect action
    const executionArmed = await isAutopilotExecutionArmed();
    if (!executionArmed) {
      console.log('[VTID-01187] Route request BLOCKED - autopilot execution is DISARMED');
      return res.status(403).json({
        ok: false,
        error: 'Autopilot execution is disarmed',
        error_code: 'EXECUTION_DISARMED',
        vtid: 'VTID-01187',
        message: 'The autopilot_execution_enabled control must be armed to route work orders'
      });
    }

    const validation = WorkOrderSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }

    const payload = validation.data as WorkOrderPayload;
    console.log(`[VTID-01163] Route request received for ${payload.vtid}`);

    // Step 1: Determine domain first for preflight chain selection
    const domain = payload.task_domain || 'backend'; // Default to backend if not specified

    // Step 2: Run governance preflight chain (VTID-01164/01167) if domain is not 'mixed'
    // Preflight checks are GOVERNANCE EVALUATIONS - same format, same registry, same truth
    // VTID-01207: Added infra and ai domain support
    let governanceResult: Awaited<ReturnType<typeof runPreflightChain>> | null = null;
    if (domain !== 'mixed') {
      console.log(`[VTID-01167] Running governance preflight chain for domain: ${domain}`);
      try {
        governanceResult = await runPreflightChain(
          domain as 'frontend' | 'backend' | 'memory' | 'infra' | 'ai',
          payload.vtid,
          {
            query: payload.title + (payload.spec_content ? ` ${payload.spec_content}` : ''),
            target_paths: payload.target_paths || []
          }
        );

        console.log(`[VTID-01167] Governance evaluation complete: ${governanceResult.summary.passed}/${governanceResult.summary.total} passed, proceed=${governanceResult.proceed}`);

        // If governance says don't proceed (e.g., critical rule failed), block the routing
        if (!governanceResult.proceed) {
          console.log(`[VTID-01167] Governance blocked routing for ${payload.vtid}`);
          return res.status(400).json({
            ok: false,
            error: 'Governance checks blocked this task',
            error_code: 'GOVERNANCE_BLOCKED',
            governance: governanceResult
          });
        }
      } catch (governanceError: any) {
        // Log but don't block on governance errors - degrade gracefully
        console.error(`[VTID-01167] Governance evaluation error (non-blocking):`, governanceError.message);
      }
    }

    // Step 3: Route the work order
    const result = await routeWorkOrder(payload);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    // Include governance evaluation results in response
    return res.status(200).json({
      ...result,
      governance: governanceResult
    });
  } catch (error: any) {
    console.error('[VTID-01163] Route error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: error.message
    });
  }
});

/**
 * POST /api/v1/worker/subagent/start
 *
 * Emit subagent start event (called when subagent begins work)
 */
/**
 * VTID-01207: Added 'infra' and 'ai' to domain enum
 */
workerOrchestratorRouter.post('/api/v1/worker/subagent/start', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      vtid: z.string().regex(/^VTID-\d{4,}$/, 'Invalid VTID format'),
      domain: z.enum(['frontend', 'backend', 'memory', 'infra', 'ai']),
      run_id: z.string()
    });

    const validation = schema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }

    const { vtid, domain, run_id } = validation.data;
    await emitSubagentStart(vtid, domain as TaskDomain, run_id);

    console.log(`[VTID-01163] Subagent ${domain} started for ${vtid}`);

    return res.status(200).json({
      ok: true,
      vtid,
      domain,
      run_id,
      event: `vtid.stage.worker_${domain}.start`
    });
  } catch (error: any) {
    console.error('[VTID-01163] Subagent start error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: error.message
    });
  }
});

/**
 * POST /api/v1/worker/subagent/complete
 *
 * Emit subagent completion event (success or failure)
 * VTID-01175: Now runs verification before marking success
 */
workerOrchestratorRouter.post('/api/v1/worker/subagent/complete', async (req: Request, res: Response) => {
  try {
    const validation = SubagentEventSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }

    const { vtid, domain, run_id, started_at, skip_verification, result } = validation.data;
    const startedAtDate = started_at ? new Date(started_at) : undefined;

    if (result?.ok) {
      if (!hasRepairEvidence(result) && await isSelfHealingVtid(vtid)) {
        await emitMissingRepairEvidenceEvent(vtid, run_id, 'subagent/complete', domain);
        return res.status(400).json({
          ok: false,
          error: 'self-healing completion requires repair evidence',
          reason: 'missing_repair_evidence',
          vtid,
          domain,
          run_id,
          event: `vtid.stage.worker_${domain}.failed`,
        });
      }

      // VTID-01175: Run verification before marking success (unless skipped with governance approval)
      if (skip_verification) {
        // Governance check: is skip_verification allowed?
        const governanceCheck = isSkipVerificationAllowed(req);
        if (!governanceCheck.allowed) {
          console.log(`[VTID-01175] skip_verification denied for ${vtid}: ${governanceCheck.reason}`);
          return res.status(403).json({
            ok: false,
            error: 'skip_verification not allowed',
            reason: governanceCheck.reason,
            vtid,
            domain,
            run_id
          });
        }

        // Emit governance audit event
        await emitSkipVerificationEvent(vtid, 'subagent/complete', governanceCheck.reason, {
          domain,
          run_id,
          caller_ip: req.ip || req.headers['x-forwarded-for'] as string
        });

        // Legacy mode - skip verification (governance approved)
        await emitSubagentSuccess(vtid, domain as TaskDomain, run_id, result as SubagentResult);
        console.log(`[VTID-01175] Subagent ${domain} succeeded for ${vtid} (verification skipped: ${governanceCheck.reason})`);
        return res.status(200).json({
          ok: true,
          vtid,
          domain,
          run_id,
          verification_skipped: true,
          skip_reason: governanceCheck.reason,
          event: `vtid.stage.worker_${domain}.success`
        });
      }

      // Run verification
      const verificationResult = await completeSubagentWithVerification(
        vtid,
        domain as TaskDomain,
        run_id,
        result as SubagentResult,
        startedAtDate
      );

      if (verificationResult.ok) {
        console.log(`[VTID-01175] Subagent ${domain} verified and succeeded for ${vtid}`);
        return res.status(200).json({
          ok: true,
          vtid,
          domain,
          run_id,
          verified: true,
          event: `vtid.stage.worker_${domain}.success`
        });
      } else if (verificationResult.should_retry) {
        // Verification failed but retriable
        console.log(`[VTID-01175] Subagent ${domain} verification failed for ${vtid}, retry recommended`);
        return res.status(202).json({
          ok: false,
          vtid,
          domain,
          run_id,
          verified: false,
          should_retry: true,
          retry_count: verificationResult.retry_count,
          reason: verificationResult.reason,
          event: 'vtid.stage.verification.failed'
        });
      } else {
        // Verification failed and not retriable
        console.log(`[VTID-01175] Subagent ${domain} verification failed for ${vtid}: ${verificationResult.reason}`);
        return res.status(400).json({
          ok: false,
          vtid,
          domain,
          run_id,
          verified: false,
          should_retry: false,
          reason: verificationResult.reason,
          event: `vtid.stage.worker_${domain}.failed`
        });
      }
    } else {
      // Worker reported failure - no verification needed
      await emitSubagentFailed(
        vtid,
        domain as TaskDomain,
        run_id,
        result?.error || 'Unknown error',
        result?.violations
      );
      console.log(`[VTID-01163] Subagent ${domain} failed for ${vtid}: ${result?.error}`);
      return res.status(200).json({
        ok: true,
        vtid,
        domain,
        run_id,
        event: `vtid.stage.worker_${domain}.failed`
      });
    }
  } catch (error: any) {
    console.error('[VTID-01163] Subagent complete error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: error.message
    });
  }
});

/**
 * POST /api/v1/worker/orchestrator/complete
 *
 * Mark orchestrator as complete (success or failure)
 * VTID-01175: Now runs verification before marking success
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/complete', async (req: Request, res: Response) => {
  try {
    const validation = OrchestratorCompleteSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }

    const { vtid, run_id, domain, success, summary, error, started_at, skip_verification, result } = validation.data;
    const startedAtDate = started_at ? new Date(started_at) : undefined;

    if (success) {
      if (!hasRepairEvidence(result) && await isSelfHealingVtid(vtid)) {
        await emitMissingRepairEvidenceEvent(vtid, run_id, 'orchestrator/complete', domain);
        return res.status(400).json({
          ok: false,
          error: 'self-healing completion requires repair evidence',
          reason: 'missing_repair_evidence',
          vtid,
          run_id,
          verified: false,
          event: 'vtid.stage.worker_orchestrator.failed',
        });
      }

      // VTID-01175: Run verification before marking success (unless skipped with governance approval)
      const needsSkip = skip_verification || !domain || !result;
      if (needsSkip) {
        // Governance check: is skip_verification allowed?
        const governanceCheck = isSkipVerificationAllowed(req);
        const skipReason = skip_verification ? 'explicit_skip' : (!domain ? 'missing_domain' : 'missing_result');

        if (!governanceCheck.allowed) {
          console.log(`[VTID-01175] skip_verification denied for ${vtid}: ${governanceCheck.reason}`);
          return res.status(403).json({
            ok: false,
            error: 'skip_verification not allowed',
            reason: governanceCheck.reason,
            skip_trigger: skipReason,
            vtid,
            run_id,
            hint: 'Provide domain and result fields, or use valid governance credentials'
          });
        }

        // Emit governance audit event
        await emitSkipVerificationEvent(vtid, 'orchestrator/complete', `${governanceCheck.reason}:${skipReason}`, {
          domain: domain || 'unknown',
          run_id,
          caller_ip: req.ip || req.headers['x-forwarded-for'] as string
        });

        // Legacy mode - skip verification (governance approved)
        await markOrchestratorSuccess(vtid, run_id, summary || 'Orchestrator completed successfully');
        syncSelfHealingLog(vtid, true).catch(() => {});
        console.log(`[VTID-01175] Orchestrator succeeded for ${vtid} (verification skipped: ${governanceCheck.reason}:${skipReason})`);
        return res.status(200).json({
          ok: true,
          vtid,
          run_id,
          verification_skipped: true,
          skip_reason: `${governanceCheck.reason}:${skipReason}`,
          event: 'vtid.stage.worker_orchestrator.success'
        });
      }

      // Build SubagentResult from request
      const subagentResult: SubagentResult = {
        ok: true,
        files_changed: result.files_changed,
        files_created: result.files_created,
        summary: summary
      };

      // Run verification
      const verificationResult = await completeOrchestratorWithVerification(
        vtid,
        run_id,
        domain as TaskDomain,
        subagentResult,
        startedAtDate
      );

      if (verificationResult.ok) {
        syncSelfHealingLog(vtid, true).catch(() => {});
        console.log(`[VTID-01175] Orchestrator verified and succeeded for ${vtid}`);
        return res.status(200).json({
          ok: true,
          vtid,
          run_id,
          verified: true,
          event: 'vtid.stage.worker_orchestrator.success'
        });
      } else if (verificationResult.should_retry) {
        // Verification failed but retriable
        console.log(`[VTID-01175] Orchestrator verification failed for ${vtid}, retry recommended`);
        return res.status(202).json({
          ok: false,
          vtid,
          run_id,
          verified: false,
          should_retry: true,
          reason: verificationResult.reason,
          event: 'vtid.stage.verification.failed'
        });
      } else {
        // Verification failed and not retriable
        console.log(`[VTID-01175] Orchestrator verification failed for ${vtid}: ${verificationResult.reason}`);
        return res.status(400).json({
          ok: false,
          vtid,
          run_id,
          verified: false,
          should_retry: false,
          reason: verificationResult.reason,
          event: 'vtid.stage.worker_orchestrator.failed'
        });
      }
    } else {
      // Marked as failure - no verification needed
      await markOrchestratorFailed(vtid, run_id, error || 'Unknown error');
      syncSelfHealingLog(vtid, false).catch(() => {});
      console.log(`[VTID-01163] Orchestrator failed for ${vtid}: ${error}`);
      return res.status(200).json({
        ok: true,
        vtid,
        run_id,
        event: 'vtid.stage.worker_orchestrator.failed'
      });
    }
  } catch (error: any) {
    console.error('[VTID-01163] Orchestrator complete error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: error.message
    });
  }
});

/**
 * GET /api/v1/worker/orchestrator/health
 *
 * Health check for orchestrator service
 */
/**
 * VTID-01207: Added worker-infra and worker-ai to health check
 */
workerOrchestratorRouter.get('/api/v1/worker/orchestrator/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'worker-orchestrator',
    version: '1.1.0',
    vtid: 'VTID-01163',
    timestamp: new Date().toISOString(),
    subagents: {
      'worker-frontend': { status: 'available', domain: 'frontend' },
      'worker-backend': { status: 'available', domain: 'backend' },
      'worker-memory': { status: 'available', domain: 'memory' },
      'worker-infra': { status: 'available', domain: 'infra' },
      'worker-ai': { status: 'available', domain: 'ai' }
    },
    endpoints: {
      route: 'POST /api/v1/worker/orchestrator/route',
      subagent_start: 'POST /api/v1/worker/subagent/start',
      subagent_complete: 'POST /api/v1/worker/subagent/complete',
      orchestrator_complete: 'POST /api/v1/worker/orchestrator/complete'
    }
  });
});

/**
 * GET /api/v1/worker/subagents
 *
 * Legacy endpoint — list available subagents.
 *
 * NOTE: As of the agents-registry rewrite, this endpoint reads from the
 * agents_registry table (tier=service) instead of the hardcoded array it
 * used to return. The response shape is preserved (id/domain/allowed_paths/
 * guardrails/default_budget) so existing UI callers do not break, but the
 * canonical endpoint going forward is GET /api/v1/agents/registry which
 * returns all three tiers grouped with derived health status.
 */
workerOrchestratorRouter.get('/api/v1/worker/subagents', async (_req: Request, res: Response) => {
  try {
    const result = await fetchServiceTierAgents();
    if (!result.ok || !result.agents) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Failed to load service-tier agents from registry',
      });
    }

    // Map registry rows into the legacy response shape. Fields that don't
    // have a registry equivalent (allowed_paths, guardrails, default_budget)
    // come from the row's metadata blob if present, otherwise defaulted.
    const subagents = result.agents.map((row) => {
      const meta = row.metadata || {};
      return {
        id: row.agent_id,
        domain: row.role || 'default',
        status: row.derived_status,
        llm_provider: row.llm_provider,
        llm_model: row.llm_model,
        last_heartbeat_at: row.last_heartbeat_at,
        source_path: row.source_path,
        allowed_paths: Array.isArray((meta as any).allowed_paths) ? (meta as any).allowed_paths : [],
        guardrails: Array.isArray((meta as any).guardrails) ? (meta as any).guardrails : [],
        default_budget: (meta as any).default_budget || null,
      };
    });

    return res.status(200).json({
      ok: true,
      subagents,
      source: 'agents_registry',
      deprecated: 'Use GET /api/v1/agents/registry instead — returns all three tiers with derived health status.',
    });
  } catch (error: any) {
    console.error('[worker-orchestrator] /worker/subagents error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/v1/worker/skills
 *
 * List available preflight/postflight skills (VTID-01164)
 */
workerOrchestratorRouter.get('/api/v1/worker/skills', (_req: Request, res: Response) => {
  try {
    const skills = listSkills();
    const preflight_chains = getPreflightChains();
    return res.status(200).json({
      ok: true,
      vtid: 'VTID-01164',
      skills,
      preflight_chains
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to list skills',
      detail: error.message
    });
  }
});

// =============================================================================
// VTID-01183: Worker Connector Endpoints
// Connects autonomous worker agents to the event loop for task execution
// =============================================================================

const LOG_PREFIX = '[VTID-01183]';
const TASK_DOMAINS: TaskDomain[] = ['frontend', 'backend', 'memory', 'infra', 'ai', 'mixed'];

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function asTaskDomain(value: unknown): TaskDomain | undefined {
  return typeof value === 'string' && TASK_DOMAINS.includes(value as TaskDomain)
    ? value as TaskDomain
    : undefined;
}

function hasRepairEvidence(result?: { files_changed?: string[]; files_created?: string[] }): boolean {
  return ((result?.files_changed?.length || 0) + (result?.files_created?.length || 0)) > 0;
}

async function isSelfHealingVtid(vtid: string): Promise<boolean> {
  const result = await supabaseRequest<any[]>(
    `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=metadata`
  );
  if (!result.ok) {
    console.warn(`${LOG_PREFIX} Could not load metadata for ${vtid}: ${result.error}`);
    return false;
  }

  const metadata = asRecord(result.data?.[0]?.metadata);
  return metadata.source === 'self-healing';
}

async function emitMissingRepairEvidenceEvent(
  vtid: string,
  runId: string,
  stage: 'subagent/complete' | 'orchestrator/complete',
  domain?: string
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: 'self-healing.verification.rejected' as any,
    source: 'worker-orchestrator',
    status: 'error',
    message: `Self-healing completion rejected at ${stage}: missing repair evidence`,
    payload: {
      vtid,
      run_id: runId,
      domain,
      stage,
      reason: 'missing_repair_evidence',
      required: ['files_changed', 'files_created'],
      emitted_at: new Date().toISOString(),
    },
  });
}

type LegacyVtidSpecRow = {
  vtid: string;
  title?: string | null;
  spec_markdown?: string | null;
  spec_hash?: string | null;
  status?: string | null;
  created_by?: string | null;
  created_at?: string | null;
};

async function fetchLegacyVtidSpec(vtid: string): Promise<LegacyVtidSpecRow | null> {
  const result = await supabaseRequest<LegacyVtidSpecRow[]>(
    `/rest/v1/vtid_specs?vtid=eq.${encodeURIComponent(vtid)}` +
      `&select=vtid,title,spec_markdown,spec_hash,status,created_by,created_at` +
      `&order=created_at.desc&limit=1`
  );

  if (!result.ok) {
    console.warn(`${LOG_PREFIX} Legacy spec lookup failed for ${vtid}: ${result.error}`);
    return null;
  }

  const row = result.data?.[0];
  return row?.spec_markdown ? row : null;
}

function inferTaskDomainFromPaths(paths: string[]): TaskDomain | undefined {
  if (paths.some((p) => p.includes('/frontend/') || p.endsWith('.css') || p.endsWith('.html'))) {
    return 'frontend';
  }
  if (paths.some((p) => p.startsWith('supabase/') || p.endsWith('.sql'))) {
    return 'memory';
  }
  if (paths.some((p) => p.includes('/agents/') || p.includes('agent') || p.includes('llm'))) {
    return 'ai';
  }
  if (paths.some((p) => p.includes('/routes/') || p.includes('/services/') || p.endsWith('.ts'))) {
    return 'backend';
  }
  return undefined;
}

async function hydratePendingTask(task: any) {
  const metadata = asRecord(task.metadata);
  const spec = await getVtidSpec(task.vtid, { bypassCache: true });
  const legacySpec = spec ? null : await fetchLegacyVtidSpec(task.vtid);
  const specTargetPaths = spec ? getSpecTargetPaths(spec) : [];
  const metadataTargetPaths = asStringArray(metadata.target_paths).length > 0
    ? asStringArray(metadata.target_paths)
    : asStringArray(metadata.files_to_modify);
  const targetPaths = specTargetPaths.length > 0 ? specTargetPaths : metadataTargetPaths;
  const specContent = spec ? getSpecText(spec) : legacySpec?.spec_markdown;
  const specHash = spec?.spec_checksum ||
    legacySpec?.spec_hash ||
    (typeof metadata.spec_hash === 'string' ? metadata.spec_hash : undefined);

  return {
    vtid: task.vtid,
    title: task.title,
    summary: task.summary,
    status: task.status,
    spec_status: task.spec_status,
    spec_content: specContent,
    task_domain:
      asTaskDomain(spec ? getSpecDomain(spec) : undefined) ||
      asTaskDomain(metadata.task_domain) ||
      inferTaskDomainFromPaths(targetPaths),
    target_paths: targetPaths,
    spec_hash: specHash,
    metadata,
    is_terminal: task.is_terminal || false,
    layer: task.layer,
    module: task.module,
    created_at: task.created_at,
    updated_at: task.updated_at,
    claimed_by: task.claimed_by || null,
    claim_expires_at: task.claim_expires_at || null,
    claim_started_at: task.claim_started_at || null,
  };
}

// Helper: Supabase request
async function supabaseRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = await response.json() as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Helper: Call RPC function
async function callRpc<T>(
  functionName: string,
  params: Record<string, unknown>
): Promise<{ ok: boolean; data?: T; error?: string; message?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = await response.json() as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * POST /api/v1/worker/orchestrator/register
 *
 * Register a worker agent with the orchestrator
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/register', async (req: Request, res: Response) => {
  try {
    const { worker_id, capabilities, max_concurrent, version, metadata } = req.body;

    if (!worker_id) {
      return res.status(400).json({ ok: false, error: 'worker_id is required' });
    }

    console.log(`${LOG_PREFIX} Registering worker: ${worker_id}`);

    // Check if already registered
    const existing = await supabaseRequest<any[]>(
      `/rest/v1/worker_registry?worker_id=eq.${encodeURIComponent(worker_id)}&select=*`
    );

    if (existing.ok && existing.data && existing.data.length > 0) {
      // Update existing registration
      const result = await supabaseRequest<any[]>(
        `/rest/v1/worker_registry?worker_id=eq.${encodeURIComponent(worker_id)}`,
        {
          method: 'PATCH',
          body: {
            capabilities: capabilities || [],
            max_concurrent: max_concurrent || 1,
            version: version || '1.0.0',
            metadata: metadata || {},
            status: 'active',
            last_heartbeat_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }
      );

      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
      }

      console.log(`${LOG_PREFIX} Worker re-registered: ${worker_id}`);
      return res.status(200).json({
        ok: true,
        worker_id,
        registered: true,
        reregistered: true,
        vtid: 'VTID-01183',
        timestamp: new Date().toISOString(),
      });
    }

    // Create new registration
    const result = await supabaseRequest<any[]>(
      '/rest/v1/worker_registry',
      {
        method: 'POST',
        body: {
          worker_id,
          capabilities: capabilities || [],
          max_concurrent: max_concurrent || 1,
          version: version || '1.0.0',
          metadata: metadata || {},
          status: 'active',
          last_heartbeat_at: new Date().toISOString(),
        },
      }
    );

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    // Emit registration event
    await emitOasisEvent({
      vtid: 'SYSTEM',
      type: 'vtid.stage.worker_orchestrator.registered' as any,
      source: 'worker-orchestrator',
      status: 'info',
      message: `Worker registered: ${worker_id}`,
      payload: { worker_id, capabilities },
    });

    console.log(`${LOG_PREFIX} Worker registered: ${worker_id}`);
    return res.status(200).json({
      ok: true,
      worker_id,
      registered: true,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Registration error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/worker/orchestrator/register/:worker_id
 *
 * Unregister a worker agent
 */
workerOrchestratorRouter.delete('/api/v1/worker/orchestrator/register/:worker_id', async (req: Request, res: Response) => {
  try {
    const { worker_id } = req.params;

    console.log(`${LOG_PREFIX} Unregistering worker: ${worker_id}`);

    const result = await supabaseRequest(
      `/rest/v1/worker_registry?worker_id=eq.${encodeURIComponent(worker_id)}`,
      {
        method: 'PATCH',
        body: {
          status: 'terminated',
          current_vtid: null,
          updated_at: new Date().toISOString(),
        },
      }
    );

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    // Release any active claims
    await supabaseRequest(
      `/rest/v1/vtid_ledger?claimed_by=eq.${encodeURIComponent(worker_id)}`,
      {
        method: 'PATCH',
        body: {
          claimed_by: null,
          claim_expires_at: null,
          updated_at: new Date().toISOString(),
        },
      }
    );

    return res.status(200).json({
      ok: true,
      worker_id,
      unregistered: true,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Unregistration error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/v1/worker/orchestrator/workers
 *
 * List active workers
 */
workerOrchestratorRouter.get('/api/v1/worker/orchestrator/workers', async (_req: Request, res: Response) => {
  try {
    const result = await supabaseRequest<any[]>(
      '/rest/v1/worker_registry?status=eq.active&select=*&order=registered_at.desc'
    );

    return res.status(200).json({
      ok: true,
      workers: result.data || [],
      count: result.data?.length || 0,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} List workers error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/v1/worker/orchestrator/tasks/pending
 *
 * VTID-01201 + VTID-01202: Get claimable tasks from vtid_ledger
 *
 * Returns tasks that are:
 * - status = 'in_progress'
 * - spec_status = 'approved'
 * - is_terminal = false (or null treated as false)
 * - Claim inclusion:
 *   - claimed_by IS NULL (unclaimed)
 *   - OR claimed_by = worker_id (claimed by requesting worker)
 *   - OR claim_expires_at < now() (expired claim)
 *
 * Query params:
 * - worker_id: If provided, includes tasks claimed by this worker
 * - limit: Max tasks to return (default 100, max 200)
 *
 * Ordered by created_at ASC (oldest first), limited to 100 tasks.
 */
workerOrchestratorRouter.get('/api/v1/worker/orchestrator/tasks/pending', async (req: Request, res: Response) => {
  const LOG_VTID = '[VTID-01202]';
  try {
    const limitParam = req.query.limit;
    const limit = Math.min(Math.max(parseInt(String(limitParam)) || 100, 1), 200);
    const now = new Date().toISOString();

    // VTID-01202: Parse worker_id query param for claim inclusion
    const workerIdParam = req.query.worker_id;
    const workerId = workerIdParam ? String(workerIdParam) : null;

    // Query vtid_ledger directly for eligible tasks
    // Supabase REST API doesn't support complex OR in WHERE, so we query with
    // base filters and then filter claim window in code
    const queryResult = await supabaseRequest<any[]>(
      `/rest/v1/vtid_ledger?` +
      `status=in.(scheduled,in_progress)&` +
      `spec_status=eq.approved&` +
      `select=vtid,title,summary,status,layer,module,metadata,created_at,updated_at,claimed_by,claim_expires_at,claim_started_at,is_terminal,spec_status&` +
      `order=created_at.asc&` +
      `limit=${limit * 2}` // Fetch extra to allow for filtering
    );

    if (!queryResult.ok) {
      console.error(`${LOG_VTID} Failed to query vtid_ledger:`, queryResult.error);
      return res.status(500).json({ ok: false, error: queryResult.error });
    }

    // VTID-01202: Filter for eligible tasks with claim inclusion logic:
    // - is_terminal must be false or null
    // - Claim inclusion:
    //   - claimed_by IS NULL (unclaimed)
    //   - OR claimed_by = worker_id (requesting worker's own claimed task)
    //   - OR claim_expires_at < now (expired claim)
    const claimableRows = (queryResult.data || [])
      .filter(task => {
        // is_terminal must be false or null
        if (task.is_terminal === true) return false;

        // Claim inclusion check
        const isUnclaimed = task.claimed_by === null || task.claimed_by === undefined;
        const isClaimedByWorker = workerId && task.claimed_by === workerId;
        const isExpired = task.claim_expires_at && new Date(task.claim_expires_at) < new Date(now);

        return isUnclaimed || isClaimedByWorker || isExpired;
      })
      .slice(0, limit);

    const claimableTasks = await Promise.all(claimableRows.map(hydratePendingTask));

    // Telemetry only — no OASIS event (polling ≠ progress)
    console.log(`${LOG_VTID} Pending tasks query: ${claimableTasks.length} eligible tasks found (worker_id=${workerId || 'none'})`);

    return res.status(200).json({
      ok: true,
      tasks: claimableTasks,
      count: claimableTasks.length,
      vtid: 'VTID-01202',
      timestamp: new Date().toISOString(),
      worker_id: workerId,
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Get pending tasks error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/v1/worker/orchestrator/tasks/:vtid/claim
 *
 * Claim a task atomically
 * VTID-01187: Requires autopilot_execution_enabled to be ARMED.
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/tasks/:vtid/claim', async (req: Request, res: Response) => {
  try {
    // VTID-01187: Check governance control before claiming (prevents bypass of event loop)
    const executionArmed = await isAutopilotExecutionArmed();
    if (!executionArmed) {
      console.log('[VTID-01187] Task claim BLOCKED - autopilot execution is DISARMED');
      return res.status(403).json({
        ok: false,
        claimed: false,
        error: 'Autopilot execution is disarmed',
        error_code: 'EXECUTION_DISARMED',
        vtid: 'VTID-01187',
        message: 'The autopilot_execution_enabled control must be armed to claim tasks'
      });
    }

    const { vtid } = req.params;
    const { worker_id, expires_minutes } = req.body;

    if (!worker_id) {
      return res.status(400).json({ ok: false, error: 'worker_id is required' });
    }

    console.log(`${LOG_PREFIX} Worker ${worker_id} claiming task ${vtid}`);

    const result = await callRpc<any>('claim_vtid_task', {
      p_vtid: vtid,
      p_worker_id: worker_id,
      p_expires_minutes: expires_minutes || 60,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, claimed: false, error: result.error });
    }

    const claim = result.data;

    if (claim.claimed) {
      // Emit claim event
      await emitOasisEvent({
        vtid,
        type: 'vtid.stage.worker_orchestrator.claimed' as any,
        source: 'worker-orchestrator',
        status: 'info',
        message: `Task claimed by ${worker_id}`,
        payload: { worker_id, expires_at: claim.expires_at },
      });

      console.log(`${LOG_PREFIX} Task ${vtid} claimed by ${worker_id}`);
    }

    return res.status(claim.claimed ? 200 : 409).json({
      ...claim,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Claim error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/v1/worker/orchestrator/tasks/:vtid/release
 *
 * Release a task claim
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/tasks/:vtid/release', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { worker_id, reason } = req.body;

    if (!worker_id) {
      return res.status(400).json({ ok: false, error: 'worker_id is required' });
    }

    console.log(`${LOG_PREFIX} Worker ${worker_id} releasing task ${vtid} (${reason || 'completed'})`);

    const result = await callRpc<any>('release_vtid_claim', {
      p_vtid: vtid,
      p_worker_id: worker_id,
      p_reason: reason || 'completed',
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    // Emit release event
    await emitOasisEvent({
      vtid,
      type: 'vtid.stage.worker_orchestrator.released' as any,
      source: 'worker-orchestrator',
      status: 'info',
      message: `Task released: ${reason || 'completed'}`,
      payload: { worker_id, reason: reason || 'completed' },
    });

    return res.status(200).json({
      ...result.data,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Release error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/v1/worker/orchestrator/tasks/:vtid/progress
 *
 * Report progress on a task (emits OASIS event for event loop)
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/tasks/:vtid/progress', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { worker_id, event, message, metadata } = req.body;

    if (!worker_id) {
      return res.status(400).json({ ok: false, error: 'worker_id is required' });
    }

    if (!event) {
      return res.status(400).json({ ok: false, error: 'event is required' });
    }

    console.log(`${LOG_PREFIX} Progress: ${vtid} - ${event}`);

    // Verify worker has active claim
    const claimCheck = await supabaseRequest<any[]>(
      `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&claimed_by=eq.${encodeURIComponent(worker_id)}&select=vtid,claimed_by`
    );

    if (!claimCheck.ok || !claimCheck.data || claimCheck.data.length === 0) {
      return res.status(400).json({ ok: false, error: 'No active claim for this task' });
    }

    // Normalize event name to vtid.stage.worker_orchestrator.* taxonomy
    const normalizedEvent = event.startsWith('vtid.stage.') ? event : `vtid.stage.worker_orchestrator.${event}`;

    // Emit OASIS event for the event loop to process
    const eventResult = await emitOasisEvent({
      vtid,
      type: normalizedEvent as any,
      source: 'worker-orchestrator',
      status: 'info',
      message: message || `Worker progress: ${event}`,
      payload: { worker_id, ...metadata },
    });

    if (!eventResult.ok) {
      return res.status(400).json({ ok: false, error: eventResult.error });
    }

    // Extend claim expiry
    await supabaseRequest(
      `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&claimed_by=eq.${encodeURIComponent(worker_id)}`,
      {
        method: 'PATCH',
        body: { updated_at: new Date().toISOString() },
      }
    );

    return res.status(200).json({
      ok: true,
      vtid,
      event: normalizedEvent,
      vtid_tag: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Progress error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/v1/worker/orchestrator/heartbeat
 *
 * Worker heartbeat - keeps registration and claim alive
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/heartbeat', async (req: Request, res: Response) => {
  try {
    const { worker_id, active_vtid } = req.body;

    if (!worker_id) {
      return res.status(400).json({ ok: false, error: 'worker_id is required' });
    }

    const result = await callRpc<any>('worker_heartbeat', {
      p_worker_id: worker_id,
      p_active_vtid: active_vtid || null,
    });

    if (!result.ok || !result.data?.ok) {
      return res.status(400).json({ ok: false, error: result.error || result.data?.reason });
    }

    return res.status(200).json({
      ...result.data,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Heartbeat error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/v1/worker/orchestrator/stats
 *
 * Get worker connector statistics
 */
workerOrchestratorRouter.get('/api/v1/worker/orchestrator/stats', async (_req: Request, res: Response) => {
  try {
    const result = await callRpc<any>('get_worker_connector_stats', {});

    return res.status(200).json({
      ok: true,
      stats: result.data,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Stats error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/v1/worker/orchestrator/cleanup
 *
 * Expire stale claims (admin endpoint)
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/cleanup', async (_req: Request, res: Response) => {
  try {
    const result = await callRpc<number>('expire_stale_vtid_claims', {});

    const count = result.data as number;
    if (count > 0) {
      console.log(`${LOG_PREFIX} Expired ${count} stale claims`);
    }

    return res.status(200).json({
      ok: true,
      expired_count: count,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Cleanup error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});
