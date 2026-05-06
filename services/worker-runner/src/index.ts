/**
 * VTID-01200: Worker Runner Execution Plane
 *
 * Autonomous task execution service that:
 * - Auto-registers with orchestrator
 * - Auto-polls for pending tasks
 * - Auto-claims eligible VTIDs
 * - Auto-routes through governance
 * - Auto-executes via LLM
 * - Auto-completes and terminalizes
 *
 * No manual curl required - truly autonomous execution.
 */

import express, { Request, Response } from 'express';
import { config as dotenvConfig } from 'dotenv';
import { WorkerRunner, createRunnerFromEnv } from './services/runner-service';
import { startAgentRegistration } from './lib/agents-registry-client';

// Load environment variables
dotenvConfig();

const VTID = 'VTID-01200';
const PORT = parseInt(process.env.PORT || '8080', 10);

// Express app for health checks
const app = express();
app.use(express.json());

// Runner instance
let runner: WorkerRunner | null = null;
let stopAgentRegistration: (() => void) | null = null;

// =============================================================================
// Health Check Endpoints
// =============================================================================

/**
 * Basic health check (canonical endpoint per claude.md rule #15)
 */
app.get('/alive', (_req: Request, res: Response) => {
  if (!runner) {
    res.status(503).json({
      status: 'unhealthy',
      error: 'Runner not initialized',
      vtid: VTID,
    });
    return;
  }

  const healthy = runner.isHealthy();
  const metrics = runner.getMetrics();

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    vtid: VTID,
    state: metrics.state,
    active_vtid: metrics.active_vtid || null,
    uptime_since: metrics.registered_at,
    last_heartbeat: metrics.last_heartbeat_at,
    last_poll: metrics.last_poll_at,
  });
});

/**
 * Detailed metrics endpoint
 */
app.get('/metrics', (_req: Request, res: Response) => {
  if (!runner) {
    res.status(503).json({
      status: 'unhealthy',
      error: 'Runner not initialized',
    });
    return;
  }

  const metrics = runner.getMetrics();

  res.json({
    vtid: VTID,
    ...metrics,
    environment: {
      gateway_url: process.env.GATEWAY_URL || 'not set',
      worker_id_prefix: process.env.WORKER_ID_PREFIX || 'worker-runner',
      poll_interval_ms: process.env.POLL_INTERVAL_MS || '5000',
      autopilot_enabled: process.env.AUTOPILOT_LOOP_ENABLED !== 'false',
      vertex_project: process.env.GOOGLE_CLOUD_PROJECT || 'not set',
      vertex_location: process.env.VERTEX_LOCATION || 'us-central1',
      vertex_model: process.env.VERTEX_MODEL || 'gemini-3.1-pro-preview',
    },
  });
});

/**
 * Readiness probe
 */
app.get('/ready', (_req: Request, res: Response) => {
  if (!runner || !runner.isHealthy()) {
    res.status(503).json({ ready: false });
    return;
  }

  res.json({ ready: true });
});

/**
 * Liveness probe
 */
app.get('/live', (_req: Request, res: Response) => {
  res.json({ live: true });
});

/**
 * VTID-01206: Trigger execution of a specific VTID immediately
 * Called by gateway when task moves to in_progress - push model instead of polling
 */
app.post('/api/v1/trigger', async (req: Request, res: Response) => {
  const { vtid } = req.body;

  if (!vtid || typeof vtid !== 'string') {
    res.status(400).json({
      ok: false,
      error: 'Missing or invalid vtid parameter',
    });
    return;
  }

  if (!runner) {
    res.status(503).json({
      ok: false,
      error: 'Runner not initialized',
    });
    return;
  }

  console.log(`[${VTID}] Trigger endpoint called for ${vtid}`);

  const result = await runner.triggerExecution(vtid);

  if (result.ok) {
    res.status(200).json({
      ok: true,
      vtid,
      message: `Execution triggered for ${vtid}`,
    });
  } else {
    res.status(400).json({
      ok: false,
      vtid,
      error: result.error,
    });
  }
});

// =============================================================================
// Startup
// =============================================================================

async function main(): Promise<void> {
  console.log(`[${VTID}] Worker Runner Execution Plane starting...`);
  console.log(`[${VTID}] Configuration:`);
  console.log(`  - GATEWAY_URL: ${process.env.GATEWAY_URL || 'not set'}`);
  console.log(`  - WORKER_ID_PREFIX: ${process.env.WORKER_ID_PREFIX || 'worker-runner'}`);
  console.log(`  - POLL_INTERVAL_MS: ${process.env.POLL_INTERVAL_MS || '5000'}`);
  console.log(`  - AUTOPILOT_LOOP_ENABLED: ${process.env.AUTOPILOT_LOOP_ENABLED !== 'false'}`);
  console.log(`  - GOOGLE_CLOUD_PROJECT: ${process.env.GOOGLE_CLOUD_PROJECT || 'not set'}`);
  console.log(`  - VERTEX_LOCATION: ${process.env.VERTEX_LOCATION || 'us-central1'}`);
  console.log(`  - VERTEX_MODEL: ${process.env.VERTEX_MODEL || 'gemini-3.1-pro-preview'}`);

  // Validate required environment variables
  const requiredVars = ['GATEWAY_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE'];
  const missingVars = requiredVars.filter((v) => !process.env[v]);

  if (missingVars.length > 0) {
    console.error(`[${VTID}] Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
  }

  // Start Express server
  const server = app.listen(PORT, () => {
    console.log(`[${VTID}] Health server listening on port ${PORT}`);
  });

  // Create and start the runner
  runner = createRunnerFromEnv();

  const started = await runner.start();
  if (!started) {
    console.error(`[${VTID}] Failed to start runner`);
    server.close();
    process.exit(1);
  }

  console.log(`[${VTID}] Worker Runner Execution Plane started successfully`);
  console.log(`[${VTID}] Polling for tasks every ${process.env.POLL_INTERVAL_MS || '5000'}ms`);

  // Self-register with the agents registry (fire-and-forget, non-blocking)
  // BOOTSTRAP-WORKER-TRUTH: report what execution-service.ts actually calls
  // (Anthropic Claude, default claude-opus-4-6) rather than the legacy
  // Gemini declaration. The hardcoded values were rolling the registry back
  // to misleading defaults every heartbeat.
  try {
    const workerLlmModel = process.env.WORKER_LLM_MODEL || 'claude-opus-4-6';
    const workerLlmProvider: 'claude' | 'gemini' | 'deepseek' | 'unknown' =
      workerLlmModel.startsWith('claude')
        ? 'claude'
        : workerLlmModel.startsWith('gemini')
        ? 'gemini'
        : workerLlmModel.startsWith('deepseek')
        ? 'deepseek'
        : 'unknown';

    stopAgentRegistration = startAgentRegistration({
      gatewayUrl: process.env.GATEWAY_URL || '',
      agentId: 'worker-runner',
      displayName: 'Worker Runner',
      description: 'Autonomous VTID execution plane (VTID-01200). Polls, claims, executes via Anthropic SDK (default claude-opus-4-6, env-overridable via WORKER_LLM_MODEL). DeepSeek-reasoner fallback engages if primary fails.',
      tier: 'service',
      role: 'executor',
      llmProvider: workerLlmProvider,
      llmModel: workerLlmModel,
      sourcePath: 'services/worker-runner/',
      healthEndpoint: '/alive',
      metadata: {
        vtid: VTID,
        fallback_model: process.env.WORKER_FALLBACK_MODEL || 'deepseek-reasoner',
        fallback_enabled: process.env.WORKER_DEEPSEEK_FALLBACK !== 'false',
      },
    });
  } catch (err) {
    console.warn(`[${VTID}] Agents registry self-registration failed (non-fatal):`, err);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[${VTID}] Received ${signal}, shutting down...`);

    if (stopAgentRegistration) {
      try { stopAgentRegistration(); } catch { /* best-effort */ }
    }

    if (runner) {
      await runner.stop();
    }

    server.close(() => {
      console.log(`[${VTID}] Server closed`);
      process.exit(0);
    });

    // Force exit after 30 seconds
    setTimeout(() => {
      console.error(`[${VTID}] Forced exit after timeout`);
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run main
main().catch((error) => {
  console.error(`[${VTID}] Fatal error:`, error);
  process.exit(1);
});
