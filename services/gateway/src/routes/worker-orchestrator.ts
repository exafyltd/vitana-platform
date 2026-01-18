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

// =============================================================================
// VTID-01183: Worker Connector Endpoints
// Connects autonomous worker agents to the event loop for task execution
// =============================================================================

const LOG_PREFIX = '[VTID-01183]';

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
): Promise<{ ok: boolean; data?: T; error?: string }> {
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
 * Get tasks available for workers to claim
 */
workerOrchestratorRouter.get('/api/v1/worker/orchestrator/tasks/pending', async (_req: Request, res: Response) => {
  try {
    const result = await callRpc<any[]>('get_pending_worker_tasks', { p_limit: 50 });

    return res.status(200).json({
      ok: true,
      tasks: result.data || [],
      count: result.data?.length || 0,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
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
