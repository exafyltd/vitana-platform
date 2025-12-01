/**
 * Operator Routes - VTID-0509 + VTID-0510 + VTID-0523 + VTID-0524 + VTID-0533
 *
 * VTID-0509: Operator Console API (chat, heartbeat, history, upload, session)
 * VTID-0510: Software Version Tracking (deployments)
 * VTID-0523: Operator Deploy Orchestrator (deploy pipeline trigger)
 * VTID-0524: Operator History & Versions Rewire (VTID/SWV Source of Truth)
 * VTID-0533: Heartbeat Backend Stability & Endpoint Fix
 *
 * Final API endpoints (after mounting at /api/v1/operator):
 * - POST /api/v1/operator/chat - Operator chat with AI
 * - GET  /api/v1/operator/health - Health check
 * - GET  /api/v1/operator/heartbeat - Heartbeat snapshot (tasks, events, cicd)
 * - GET  /api/v1/operator/history - Operator history
 * - GET  /api/v1/operator/heartbeat/session - Read current heartbeat state (VTID-0533)
 * - POST /api/v1/operator/heartbeat/session - Update heartbeat state (live/standby)
 * - POST /api/v1/operator/upload - File upload
 * - POST /api/v1/operator/deploy - Trigger deployment pipeline (VTID-0523)
 * - GET  /api/v1/operator/deployments - Deployment history with VTID (VTID-0524)
 * - POST /api/v1/operator/deployments - Record deployment (VTID-0510)
 * - GET  /api/v1/operator/deployments/health - Deployments health (VTID-0510)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { processMessage } from '../services/ai-orchestrator';
import { ingestOperatorEvent, getTasksSummary, getRecentEvents, getCicdHealth, getOperatorHistory } from '../services/operator-service';
import { getDeploymentHistory, getDeploymentHistoryWithVtid, getNextSWV, insertSoftwareVersion } from '../lib/versioning';

const router = Router();

// ==================== VTID-0509 Schemas ====================

const ChatMessageSchema = z.object({
  message: z.string().min(1, "Message is required"),
  attachments: z.array(z.object({
    oasis_ref: z.string(),
    kind: z.enum(['image', 'video', 'file'])
  })).optional().default([])
});

const HeartbeatSessionSchema = z.object({
  status: z.enum(['live', 'standby']).optional(),
  state: z.enum(['live', 'standby']).optional()
}).refine(data => data.status || data.state, {
  message: "Either 'status' or 'state' is required"
});

const FileUploadSchema = z.object({
  name: z.string().min(1, "File name is required"),
  kind: z.enum(['image', 'video', 'file']),
  content_type: z.string().optional(),
  data: z.string().optional() // Base64 encoded data (optional for stub)
});

// ==================== Heartbeat State (in-memory for single instance) ====================
// For multi-instance deployment, this should be stored in database
interface HeartbeatState {
  state: 'live' | 'standby';
  updated_at: string;
  session_id: string | null;
}

let heartbeatState: HeartbeatState = {
  state: 'standby',
  updated_at: new Date().toISOString(),
  session_id: null
};

// ==================== VTID-0509 Routes ====================
// Routes defined WITHOUT /operator prefix since router is mounted at /api/v1/operator

/**
 * POST /chat → /api/v1/operator/chat
 */
router.post('/chat', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[Operator Chat] Request ${requestId} started`);

  try {
    const validation = ChatMessageSchema.safeParse(req.body);
    if (!validation.success) {
      console.error(`[Operator Chat] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const { message, attachments } = validation.data;

    // Log operator.chat.request event
    await ingestOperatorEvent({
      vtid: 'VTID-0509',
      type: 'operator.chat.request',
      status: 'info',
      message: `User message: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
      payload: {
        request_id: requestId,
        message_length: message.length,
        attachment_count: attachments.length
      }
    });

    // Call AI orchestrator
    const aiResult = await processMessage({
      text: message,
      attachments: attachments,
      oasisContext: {
        vtid: 'VTID-0509',
        request_id: requestId
      }
    });

    // Log operator.chat.response event
    await ingestOperatorEvent({
      vtid: 'VTID-0509',
      type: 'operator.chat.response',
      status: 'success',
      message: `AI response generated: ${aiResult.reply.substring(0, 100)}${aiResult.reply.length > 100 ? '...' : ''}`,
      payload: {
        request_id: requestId,
        reply_length: aiResult.reply.length
      }
    });

    console.log(`[Operator Chat] Request ${requestId} completed successfully`);

    return res.status(200).json({
      ok: true,
      reply: aiResult.reply,
      attachments: attachments,
      oasis_ref: `OASIS-CHAT-${requestId.slice(0, 8).toUpperCase()}`,
      meta: aiResult.meta || {}
    });

  } catch (error: any) {
    console.error(`[Operator Chat] Error:`, error);

    // Log error event
    await ingestOperatorEvent({
      vtid: 'VTID-0509',
      type: 'operator.chat.response',
      status: 'error',
      message: `Chat error: ${error.message}`,
      payload: { request_id: requestId, error: error.message }
    }).catch(() => {}); // Don't fail if logging fails

    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * GET /health → /api/v1/operator/health
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'operator-api',
    timestamp: new Date().toISOString(),
    status: 'healthy',
    vtid: 'VTID-0509'
  });
});

/**
 * GET /heartbeat → /api/v1/operator/heartbeat
 */
router.get('/heartbeat', async (_req: Request, res: Response) => {
  console.log('[Operator Heartbeat] Snapshot requested');

  try {
    // Log heartbeat snapshot event
    await ingestOperatorEvent({
      vtid: 'VTID-0509',
      type: 'operator.heartbeat.snapshot',
      status: 'info',
      message: 'Heartbeat snapshot requested',
      payload: {}
    });

    // Aggregate data from OASIS/CICD
    const [tasksSummary, recentEvents, cicdHealth] = await Promise.all([
      getTasksSummary(),
      getRecentEvents(10),
      getCicdHealth()
    ]);

    const snapshot = {
      ok: true,
      heartbeat: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        vtid: 'VTID-0509'
      },
      tasks_summary: tasksSummary,
      recent_events: recentEvents,
      cicd_health: cicdHealth
    };

    console.log('[Operator Heartbeat] Snapshot generated:', {
      tasks_total: snapshot.tasks_summary.total,
      events_count: snapshot.recent_events.length
    });

    return res.status(200).json(snapshot);

  } catch (error: any) {
    console.error('[Operator Heartbeat] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to generate heartbeat snapshot',
      details: error.message
    });
  }
});

/**
 * GET /history → /api/v1/operator/history
 */
router.get('/history', async (req: Request, res: Response) => {
  console.log('[Operator History] Request received');

  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const history = await getOperatorHistory(limit);

    console.log(`[Operator History] Returning ${history.length} events`);

    return res.status(200).json({
      ok: true,
      history: history,
      pagination: {
        limit: limit,
        count: history.length
      }
    });

  } catch (error: any) {
    console.error('[Operator History] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to fetch operator history',
      details: error.message
    });
  }
});

/**
 * GET /heartbeat/session → /api/v1/operator/heartbeat/session
 * Returns current heartbeat session state
 */
router.get('/heartbeat/session', (_req: Request, res: Response) => {
  console.log('[Operator Session] GET request - current state:', heartbeatState.state);

  return res.status(200).json({
    ok: true,
    data: {
      state: heartbeatState.state,
      updated_at: heartbeatState.updated_at,
      session_id: heartbeatState.session_id
    },
    error: null
  });
});

/**
 * POST /heartbeat/session → /api/v1/operator/heartbeat/session
 * Update heartbeat session state (live/standby)
 * Accepts either { status: 'live'|'standby' } or { state: 'live'|'standby' }
 */
router.post('/heartbeat/session', async (req: Request, res: Response) => {
  console.log('[Operator Session] POST request received:', req.body);

  try {
    const validation = HeartbeatSessionSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        data: null,
        error: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    // Accept both 'status' (legacy) and 'state' (new) parameters
    const newState = validation.data.state || validation.data.status;
    if (!newState) {
      return res.status(400).json({
        ok: false,
        data: null,
        error: "Either 'status' or 'state' is required with value 'live' or 'standby'"
      });
    }

    const sessionId = randomUUID();

    // Update in-memory state
    heartbeatState = {
      state: newState,
      updated_at: new Date().toISOString(),
      session_id: sessionId
    };

    // Log session event to OASIS
    const eventType = newState === 'live'
      ? 'operator.heartbeat.session.start'
      : 'operator.heartbeat.session.end';

    await ingestOperatorEvent({
      vtid: 'VTID-0509',
      type: eventType,
      status: 'info',
      message: `Heartbeat session ${newState}`,
      payload: { session_id: sessionId, state: newState }
    });

    console.log(`[Operator Session] Session ${sessionId} set to ${newState}`);

    return res.status(200).json({
      ok: true,
      data: {
        state: heartbeatState.state,
        updated_at: heartbeatState.updated_at,
        session_id: heartbeatState.session_id
      },
      error: null
    });

  } catch (error: any) {
    console.error('[Operator Session] Error:', error);
    return res.status(500).json({
      ok: false,
      data: null,
      error: error.message || 'Failed to update heartbeat session'
    });
  }
});

/**
 * POST /upload → /api/v1/operator/upload
 */
router.post('/upload', async (req: Request, res: Response) => {
  console.log('[Operator Upload] Request received');

  try {
    const validation = FileUploadSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const { name, kind, content_type } = validation.data;
    const fileId = randomUUID();
    const oasisRef = `OASIS-FILE-${fileId.slice(0, 8).toUpperCase()}`;

    // Log upload event
    await ingestOperatorEvent({
      vtid: 'VTID-0509',
      type: 'operator.upload',
      status: 'success',
      message: `File uploaded: ${name}`,
      payload: {
        file_id: fileId,
        oasis_ref: oasisRef,
        name: name,
        kind: kind,
        content_type: content_type || 'application/octet-stream'
      }
    });

    console.log(`[Operator Upload] File ${fileId} uploaded: ${name} (${kind})`);

    return res.status(200).json({
      ok: true,
      file_id: fileId,
      oasis_ref: oasisRef,
      name: name,
      kind: kind,
      content_type: content_type || 'application/octet-stream'
    });

  } catch (error: any) {
    console.error('[Operator Upload] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to upload file',
      details: error.message
    });
  }
});

// ==================== VTID-0510 Routes ====================

/**
 * GET /deployments → /api/v1/operator/deployments
 * VTID-0524: Returns deployment history with VTID correlation
 * Response format: { ok: true, deployments: [{ vtid, swv, service, environment, status, created_at, commit }] }
 */
router.get('/deployments', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    // VTID-0524: Use enhanced function with VTID correlation
    const result = await getDeploymentHistoryWithVtid(limit);

    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Database query failed',
        detail: result.error,
      });
    }

    // VTID-0524: Return canonical format with ok wrapper
    return res.status(200).json({
      ok: true,
      deployments: result.deployments || [],
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] Error fetching deployments: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: errorMessage,
    });
  }
});

/**
 * POST /deployments → /api/v1/operator/deployments
 */
router.post('/deployments', async (req: Request, res: Response) => {
  try {
    const { service, git_commit, deploy_type, initiator, environment } = req.body;

    // Validate required fields
    if (!service || typeof service !== 'string') {
      return res.status(400).json({ ok: false, error: 'service is required' });
    }
    if (!git_commit || typeof git_commit !== 'string') {
      return res.status(400).json({ ok: false, error: 'git_commit is required' });
    }
    if (!deploy_type || !['normal', 'rollback'].includes(deploy_type)) {
      return res.status(400).json({ ok: false, error: 'deploy_type must be "normal" or "rollback"' });
    }
    if (!initiator || !['user', 'agent'].includes(initiator)) {
      return res.status(400).json({ ok: false, error: 'initiator must be "user" or "agent"' });
    }

    // Get next SWV ID
    const swv_id = await getNextSWV();

    // Insert the deployment record
    const result = await insertSoftwareVersion({
      swv_id,
      service,
      git_commit,
      deploy_type,
      initiator,
      status: 'success',
      environment: environment || 'dev-sandbox',
    });

    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to record deployment',
        detail: result.error,
      });
    }

    console.log(`[Operator] Deployment recorded: ${swv_id} for ${service}`);

    return res.status(201).json({
      ok: true,
      swv_id: result.swv_id,
      service,
      git_commit,
      deploy_type,
      initiator,
      environment: environment || 'dev-sandbox',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] Error recording deployment: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: errorMessage,
    });
  }
});

/**
 * GET /deployments/health → /api/v1/operator/deployments/health
 */
router.get('/deployments/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_ROLE;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'operator-deployments',
    version: '1.0.0',
    vtid: 'VTID-0510',
    timestamp: new Date().toISOString(),
    capabilities: {
      database_connection: hasSupabaseUrl && hasSupabaseKey,
      version_tracking: true,
    },
  });
});

// ==================== VTID-0523 Routes ====================

/**
 * POST /deploy → /api/v1/operator/deploy
 * Operator Deploy Orchestrator - triggers deployment pipeline
 * This wraps the CICD deploy endpoint and adds operator-specific telemetry
 */
router.post('/deploy', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[Operator Deploy] Request ${requestId} started`);

  try {
    // VTID-0523-A: Extract full version info from request
    const { vtid, service, environment, swv, commit } = req.body;

    // Validate required fields
    if (!vtid || typeof vtid !== 'string') {
      return res.status(400).json({ ok: false, error: 'vtid is required' });
    }
    if (!service || typeof service !== 'string') {
      return res.status(400).json({ ok: false, error: 'service is required' });
    }

    const env = environment || 'dev';
    const commitShort = commit ? commit.substring(0, 7) : 'unknown';

    // VTID-0523-A: Log with full version details
    console.log(`[Operator Deploy] Deploying ${swv || 'unknown'} (${commitShort}) for ${service} to ${env}`);

    // Emit operator.deploy.requested event with version details
    await ingestOperatorEvent({
      vtid,
      type: 'operator.deploy.requested',
      status: 'info',
      message: `Deploy requested: ${swv || service} (${commitShort}) to ${env}`,
      payload: {
        request_id: requestId,
        service,
        environment: env,
        swv: swv || null,
        commit: commit || null
      }
    });

    // Call the CICD deploy endpoint internally
    const deployUrl = `${process.env.GATEWAY_INTERNAL_URL || 'http://localhost:8080'}/api/v1/deploy/service`;

    // For internal calls, we'll directly use the logic
    // Call the actual deploy service via internal fetch
    const GATEWAY_URL = process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 8080}`;

    const deployResponse = await fetch(`${GATEWAY_URL}/api/v1/deploy/service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vtid,
        service,
        environment: env,
        trigger_workflow: true
      })
    });

    const deployResult = await deployResponse.json() as {
      ok: boolean;
      error?: string;
      workflow_url?: string;
      workflow_run_id?: string;
    };

    if (!deployResult.ok) {
      // Emit operator.deploy.failed event with version details
      await ingestOperatorEvent({
        vtid,
        type: 'operator.deploy.failed',
        status: 'error',
        message: `Deploy failed: ${swv || service} - ${deployResult.error || 'Unknown error'}`,
        payload: {
          request_id: requestId,
          service,
          environment: env,
          swv: swv || null,
          commit: commit || null,
          error: deployResult.error
        }
      });

      return res.status(deployResponse.status).json({
        ok: false,
        error: deployResult.error || 'Deploy failed',
        vtid,
        swv,
        service,
        environment: env
      });
    }

    // Emit operator.deploy.started event with version details
    await ingestOperatorEvent({
      vtid,
      type: 'operator.deploy.started',
      status: 'success',
      message: `Deployment started: ${swv || service} (${commitShort}) to ${env}`,
      payload: {
        request_id: requestId,
        service,
        environment: env,
        swv: swv || null,
        commit: commit || null,
        workflow_url: deployResult.workflow_url
      }
    });

    console.log(`[Operator Deploy] Request ${requestId} completed - ${swv || service} (${commitShort}) queued`);

    return res.status(200).json({
      ok: true,
      status: 'queued',
      vtid,
      swv,
      commit,
      service,
      environment: env,
      workflow_url: deployResult.workflow_url,
      workflow_run_id: deployResult.workflow_run_id
    });

  } catch (error: any) {
    console.error(`[Operator Deploy] Error:`, error);

    // Emit error event with available version info
    const vtid = req.body?.vtid || 'UNKNOWN';
    const swv = req.body?.swv || null;
    const commit = req.body?.commit || null;
    await ingestOperatorEvent({
      vtid,
      type: 'operator.deploy.failed',
      status: 'error',
      message: `Deploy error: ${error.message}`,
      payload: {
        request_id: requestId,
        swv,
        commit,
        error: error.message
      }
    }).catch(() => {}); // Don't fail if logging fails

    return res.status(500).json({
      ok: false,
      error: error.message || 'Internal server error'
    });
  }
});

export default router;
