/**
 * Worker Orchestrator Routes - VTID-01163
 *
 * API endpoints for the Worker Orchestrator that routes work orders
 * to specialized domain subagents (frontend, backend, memory).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  routeWorkOrder,
  markOrchestratorSuccess,
  markOrchestratorFailed,
  emitSubagentStart,
  emitSubagentSuccess,
  emitSubagentFailed,
  TaskDomain,
  WorkOrderPayload,
  SubagentResult
} from '../services/worker-orchestrator-service';
import { runPreflightChain, listSkills, getPreflightChains } from '../services/skills/preflight-runner';

export const workerOrchestratorRouter = Router();

// =============================================================================
// Request Schemas
// =============================================================================

const WorkOrderSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4,}$/, 'Invalid VTID format'),
  title: z.string().min(1, 'Title is required'),
  task_family: z.string().default('DEV'),
  task_domain: z.enum(['frontend', 'backend', 'memory', 'mixed']).optional(),
  target_paths: z.array(z.string()).optional(),
  change_budget: z.object({
    max_files: z.number().min(1).optional(),
    max_directories: z.number().min(1).optional()
  }).optional(),
  spec_content: z.string().optional(),
  run_id: z.string().optional()
});

const SubagentEventSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4,}$/, 'Invalid VTID format'),
  domain: z.enum(['frontend', 'backend', 'memory']),
  run_id: z.string(),
  result: z.object({
    ok: z.boolean(),
    files_changed: z.array(z.string()).optional(),
    files_created: z.array(z.string()).optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    violations: z.array(z.string()).optional()
  }).optional()
});

const OrchestratorCompleteSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4,}$/, 'Invalid VTID format'),
  run_id: z.string(),
  success: z.boolean(),
  summary: z.string().optional(),
  error: z.string().optional()
});

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /api/v1/worker/orchestrator/route
 *
 * Route a work order to the appropriate subagent.
 * VTID-01167: Now runs preflight skill chains (VTID-01164) before routing.
 * Does NOT execute the work - just determines routing and emits events.
 */
workerOrchestratorRouter.post('/api/v1/worker/orchestrator/route', async (req: Request, res: Response) => {
  try {
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
    let governanceResult: Awaited<ReturnType<typeof runPreflightChain>> | null = null;
    if (domain !== 'mixed') {
      console.log(`[VTID-01167] Running governance preflight chain for domain: ${domain}`);
      try {
        governanceResult = await runPreflightChain(
          domain as 'frontend' | 'backend' | 'memory',
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
workerOrchestratorRouter.post('/api/v1/worker/subagent/start', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      vtid: z.string().regex(/^VTID-\d{4,}$/, 'Invalid VTID format'),
      domain: z.enum(['frontend', 'backend', 'memory']),
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

    const { vtid, domain, run_id, result } = validation.data;

    if (result?.ok) {
      await emitSubagentSuccess(vtid, domain as TaskDomain, run_id, result as SubagentResult);
      console.log(`[VTID-01163] Subagent ${domain} succeeded for ${vtid}`);
    } else {
      await emitSubagentFailed(
        vtid,
        domain as TaskDomain,
        run_id,
        result?.error || 'Unknown error',
        result?.violations
      );
      console.log(`[VTID-01163] Subagent ${domain} failed for ${vtid}: ${result?.error}`);
    }

    return res.status(200).json({
      ok: true,
      vtid,
      domain,
      run_id,
      event: `vtid.stage.worker_${domain}.${result?.ok ? 'success' : 'failed'}`
    });
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

    const { vtid, run_id, success, summary, error } = validation.data;

    if (success) {
      await markOrchestratorSuccess(vtid, run_id, summary || 'Orchestrator completed successfully');
      console.log(`[VTID-01163] Orchestrator succeeded for ${vtid}`);
    } else {
      await markOrchestratorFailed(vtid, run_id, error || 'Unknown error');
      console.log(`[VTID-01163] Orchestrator failed for ${vtid}: ${error}`);
    }

    return res.status(200).json({
      ok: true,
      vtid,
      run_id,
      event: `vtid.stage.worker_orchestrator.${success ? 'success' : 'failed'}`
    });
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
workerOrchestratorRouter.get('/api/v1/worker/orchestrator/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'worker-orchestrator',
    version: '1.0.0',
    vtid: 'VTID-01163',
    timestamp: new Date().toISOString(),
    subagents: {
      'worker-frontend': { status: 'available', domain: 'frontend' },
      'worker-backend': { status: 'available', domain: 'backend' },
      'worker-memory': { status: 'available', domain: 'memory' }
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
 * List available subagents with their configurations
 */
workerOrchestratorRouter.get('/api/v1/worker/subagents', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    subagents: [
      {
        id: 'worker-frontend',
        domain: 'frontend',
        allowed_paths: [
          'services/gateway/src/frontend/**',
          'services/gateway/dist/frontend/**'
        ],
        guardrails: ['CSP compliance', 'No inline scripts', 'No external CDNs'],
        default_budget: { max_files: 10, max_directories: 5 }
      },
      {
        id: 'worker-backend',
        domain: 'backend',
        allowed_paths: [
          'services/gateway/src/**',
          'services/**/src/**'
        ],
        guardrails: ['Route mount validation', 'Path restrictions'],
        default_budget: { max_files: 15, max_directories: 8 }
      },
      {
        id: 'worker-memory',
        domain: 'memory',
        allowed_paths: [
          'supabase/migrations/**',
          'services/agents/memory-indexer/**'
        ],
        guardrails: ['Tenant context', 'RPC signatures', 'Migration naming'],
        default_budget: { max_files: 5, max_directories: 3 }
      }
    ]
  });
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
