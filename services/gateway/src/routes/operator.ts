/**
 * Operator Routes - VTID-0509 + VTID-0510
 *
 * VTID-0509: Operator Console API (chat, heartbeat, history, upload, session)
 * VTID-0510: Software Version Tracking (deployments)
 *
 * Final API endpoints (after mounting at /api/v1/operator):
 * - POST /api/v1/operator/chat - Operator chat with AI
 * - GET  /api/v1/operator/health - Health check
 * - GET  /api/v1/operator/heartbeat - Heartbeat snapshot
 * - GET  /api/v1/operator/history - Operator history
 * - POST /api/v1/operator/heartbeat/session - Start/stop heartbeat
 * - POST /api/v1/operator/upload - File upload
 * - GET  /api/v1/operator/deployments - Deployment history (VTID-0510)
 * - POST /api/v1/operator/deployments - Record deployment (VTID-0510)
 * - GET  /api/v1/operator/deployments/health - Deployments health (VTID-0510)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { processMessage } from '../services/ai-orchestrator';
import { ingestOperatorEvent, getTasksSummary, getRecentEvents, getCicdHealth, getOperatorHistory } from '../services/operator-service';
import { getDeploymentHistory, getNextSWV, insertSoftwareVersion } from '../lib/versioning';

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
  status: z.enum(['live', 'standby'])
});

const FileUploadSchema = z.object({
  name: z.string().min(1, "File name is required"),
  kind: z.enum(['image', 'video', 'file']),
  content_type: z.string().optional(),
  data: z.string().optional() // Base64 encoded data (optional for stub)
});

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
 * POST /heartbeat/session → /api/v1/operator/heartbeat/session
 */
router.post('/heartbeat/session', async (req: Request, res: Response) => {
  console.log('[Operator Session] Request received');

  try {
    const validation = HeartbeatSessionSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const { status } = validation.data;
    const sessionId = randomUUID();

    // Log session event
    const eventType = status === 'live'
      ? 'operator.heartbeat.started'
      : 'operator.heartbeat.stopped';

    await ingestOperatorEvent({
      vtid: 'VTID-0509',
      type: eventType,
      status: 'info',
      message: `Heartbeat session ${status}`,
      payload: { session_id: sessionId, status }
    });

    console.log(`[Operator Session] Session ${sessionId} set to ${status}`);

    return res.status(200).json({
      ok: true,
      session_id: sessionId,
      status: status,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('[Operator Session] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to update heartbeat session',
      details: error.message
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
 */
router.get('/deployments', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const result = await getDeploymentHistory(limit);

    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Database query failed',
        detail: result.error,
      });
    }

    // Format for UI feed
    const deployments = (result.deployments || []).map((d) => ({
      swv_id: d.swv_id,
      created_at: d.created_at,
      git_commit: d.git_commit,
      status: d.status,
      initiator: d.initiator,
      deploy_type: d.deploy_type,
      service: d.service,
      environment: d.environment,
    }));

    return res.status(200).json(deployments);
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

export default router;
