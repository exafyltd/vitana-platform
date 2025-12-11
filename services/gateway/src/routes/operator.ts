/**
 * Operator Routes - VTID-0509 + VTID-0510 + VTID-0525 + VTID-0531
 *
 * VTID-0509: Operator Console API (chat, heartbeat, history, upload, session)
 * VTID-0510: Software Version Tracking (deployments)
 * VTID-0525: Operator Command Hub (NL -> Schema -> Deploy Orchestrator)
 * VTID-0531: Operator Chat → OASIS Integration & Thread/VTID Hardening
 *
 * Final API endpoints (after mounting at /api/v1/operator):
 * - POST /api/v1/operator/chat - Operator chat with AI
 * - GET  /api/v1/operator/chat/:threadId - Get chat thread history (VTID-0531)
 * - POST /api/v1/operator/command - Natural language command (VTID-0525)
 * - POST /api/v1/operator/deploy - Deploy orchestrator (VTID-0525)
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
import {
  ingestOperatorEvent,
  getTasksSummary,
  getRecentEvents,
  getCicdHealth,
  getOperatorHistory,
  ingestChatMessageEvent,
  validateVtidExists,
  getChatThreadHistory
} from '../services/operator-service';
import { OperatorChatMessageSchema, OperatorChatRole, OperatorChatMode } from '../types/operator-chat';
import { getDeploymentHistory, getNextSWV, insertSoftwareVersion } from '../lib/versioning';
// VTID-0525-B: naturalLanguageService disabled for MVP - using simple command matching
// import { naturalLanguageService } from '../services/natural-language-service';
import {
  OperatorCommandRequestSchema,
  OperatorDeployRequestSchema,
  OperatorCommandResponse,
  OperatorDeployResponse,
  // VTID-0525-B: Schemas unused in MVP
  // ALLOWED_COMMAND_SERVICES,
} from '../types/operator-command';
import cicdEvents from '../services/oasis-event-service';

const router = Router();

// ==================== VTID-0509 Schemas ====================

// VTID-0531: Use extended schema from types/operator-chat.ts (OperatorChatMessageSchema)
// which adds threadId, vtid, role, mode, metadata to the original ChatMessageSchema

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
 * VTID-0531: Extended with threadId, vtid, role, mode support and unified OASIS event logging
 */
router.post('/chat', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[Operator Chat] Request ${requestId} started`);

  try {
    // VTID-0531: Use extended schema with threadId, vtid, role, mode
    const validation = OperatorChatMessageSchema.safeParse(req.body);
    if (!validation.success) {
      console.error(`[Operator Chat] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const { message, attachments, role, mode, metadata } = validation.data;

    // VTID-0531: Normalize threadId - generate if missing
    const threadId = validation.data.threadId || randomUUID();
    const createdAt = new Date().toISOString();

    // VTID-0531: Validate VTID if provided (warn but don't fail)
    let validatedVtid: string | undefined = validation.data.vtid;
    if (validatedVtid) {
      const vtidExists = await validateVtidExists(validatedVtid);
      if (!vtidExists) {
        console.warn(`[Operator Chat] VTID validation failed for ${validatedVtid}, continuing without VTID link`);
        // Don't clear vtid - still include in payload but vtid column will be null
      }
    }

    // VTID-0531: Log operator message with unified event type
    const operatorEventResult = await ingestChatMessageEvent({
      threadId,
      vtid: validatedVtid,
      role: role as OperatorChatRole,
      mode: mode as OperatorChatMode,
      message: message,
      attachmentsCount: attachments.length,
      metadata
    });

    const operatorMessageId = operatorEventResult.eventId || requestId;

    // Call AI orchestrator
    const aiResult = await processMessage({
      text: message,
      attachments: attachments,
      oasisContext: {
        vtid: validatedVtid || 'VTID-0509',
        request_id: requestId
      }
    });

    // VTID-0531: Log assistant response with unified event type
    const assistantEventResult = await ingestChatMessageEvent({
      threadId,
      vtid: validatedVtid,
      role: 'assistant',
      mode: mode as OperatorChatMode,
      message: aiResult.reply,
      metadata: {
        request_id: requestId,
        ...(aiResult.meta || {})
      }
    });

    const assistantMessageId = assistantEventResult.eventId || randomUUID();

    console.log(`[Operator Chat] Request ${requestId} completed successfully (thread: ${threadId})`);

    // VTID-0531: Extended response with threadId, messageId, createdAt
    return res.status(200).json({
      ok: true,
      reply: aiResult.reply,
      attachments: attachments,
      oasis_ref: `OASIS-CHAT-${requestId.slice(0, 8).toUpperCase()}`,
      meta: aiResult.meta || {},
      // VTID-0531: Extended fields
      threadId,
      messageId: assistantMessageId,  // ID of the assistant response event
      createdAt
    });

  } catch (error: any) {
    console.error(`[Operator Chat] Error:`, error);

    // Log error event using legacy method (for backwards compatibility)
    await ingestOperatorEvent({
      vtid: 'VTID-0509',
      type: 'operator.chat.error',
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
 * GET /chat/:threadId → /api/v1/operator/chat/:threadId
 * VTID-0531: Thread history read endpoint
 */
router.get('/chat/:threadId', async (req: Request, res: Response) => {
  console.log('[Operator Chat History] Request received');

  try {
    const { threadId } = req.params;

    // Validate threadId format (UUID)
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(threadId)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid threadId format',
        details: 'threadId must be a valid UUID'
      });
    }

    const messages = await getChatThreadHistory(threadId);

    console.log(`[Operator Chat History] Returning ${messages.length} messages for thread ${threadId}`);

    return res.status(200).json({
      ok: true,
      data: messages
    });

  } catch (error: any) {
    console.error('[Operator Chat History] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to fetch chat thread history',
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

// ==================== VTID-0525 Routes ====================
// VTID-0525-B: Operator Command Hub - Simplified MVP
// Simple command matching for deploy commands using existing CICD infrastructure

import deployOrchestrator from '../services/deploy-orchestrator';
import { emitOasisEvent } from '../services/oasis-event-service';
// VTID-0525-B: DeployCommandSchema and TaskCommandSchema unused in MVP
// import { DeployCommandSchema, TaskCommandSchema } from '../types/operator-command';

/**
 * POST /deploy → /api/v1/operator/deploy
 * Deploy orchestrator: uses the shared deploy service (same as Publish modal).
 * This is the single orchestrator that executes deployment workflows.
 */
router.post('/deploy', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[Operator Deploy] Request ${requestId} started`);

  try {
    const validation = OperatorDeployRequestSchema.safeParse(req.body);
    if (!validation.success) {
      console.error(`[Operator Deploy] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        vtid: req.body?.vtid || 'UNKNOWN',
        service: req.body?.service || 'UNKNOWN',
        environment: req.body?.environment || 'dev',
        error: 'Validation failed',
      } as OperatorDeployResponse);
    }

    const { vtid, service, environment, source } = validation.data;

    // Use the shared deploy orchestrator (same implementation as Publish modal)
    const result = await deployOrchestrator.executeDeploy({
      vtid,
      service,
      environment,
      source,
    });

    return res.status(result.ok ? 200 : 500).json(result as OperatorDeployResponse);

  } catch (error: any) {
    console.error(`[Operator Deploy] Error:`, error);
    return res.status(500).json({
      ok: false,
      vtid: req.body?.vtid || 'UNKNOWN',
      service: req.body?.service || 'UNKNOWN',
      environment: 'dev',
      error: error.message
    } as OperatorDeployResponse);
  }
});

/**
 * POST /command → /api/v1/operator/command
 *
 * VTID-0525-B: Simplified MVP command parser.
 * - Simple deterministic matching (no NL parsing for now)
 * - Only supports explicit deploy commands: "deploy gateway to dev", "deploy oasis-operator to dev"
 * - Uses placeholder VTID instead of auto-creating in vtid_ledger
 * - Uses existing CICD bridge (same as Publish modal)
 */
router.post('/command', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[VTID-0525-B] Operator Command ${requestId} started`);

  try {
    const validation = OperatorCommandRequestSchema.safeParse(req.body);
    if (!validation.success) {
      console.error(`[VTID-0525-B] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        vtid: 'UNKNOWN',
        reply: 'Invalid request: ' + validation.error.errors.map(e => e.message).join(', '),
        error: 'Validation failed',
      } as OperatorCommandResponse);
    }

    const { message, environment } = validation.data;
    const normalized = message.trim().toLowerCase();

    // VTID-0525-B: Generate a simple placeholder VTID
    const timestamp = Date.now().toString(36).toUpperCase();
    const vtid = `OASIS-CMD-${timestamp}`;
    console.log(`[VTID-0525-B] Using placeholder VTID: ${vtid}`);

    // VTID-0525-B: Simple deterministic command matching (MVP)
    // Supported commands:
    // - "deploy gateway to dev"
    // - "deploy oasis-operator to dev"
    // - "deploy oasis-projector to dev"

    // Check for deploy gateway command
    if (normalized === 'deploy gateway to dev' ||
        normalized.startsWith('deploy gateway')) {
      console.log(`[VTID-0525-B] Matched: deploy gateway`);

      // Write operator event to OASIS
      await emitOasisEvent({
        vtid,
        type: 'operator.action.scheduled' as any,
        source: 'operator.console.chat',
        status: 'info',
        message: `Scheduled deploy: gateway to dev`,
        payload: {
          action_type: 'deploy',
          service: 'gateway',
          environment: 'dev',
        },
      }).catch(err => console.error('[VTID-0525-B] Event emit failed:', err));

      // Execute deploy using the shared orchestrator (same as Publish modal)
      const deployResult = await deployOrchestrator.executeDeploy({
        vtid,
        service: 'gateway',
        environment: 'dev',
        source: 'operator.console.chat',
      });

      const reply = deployResult.ok
        ? `Deploy requested: gateway to dev. CI/CD pipeline started. ${deployResult.workflow_url ? `Workflow: ${deployResult.workflow_url}` : ''}`
        : `Deploy failed for gateway: ${deployResult.error}`;

      return res.status(200).json({
        ok: deployResult.ok,
        vtid,
        reply,
        command: { action: 'deploy', service: 'gateway', environment: 'dev' },
        workflow_url: deployResult.workflow_url,
        error: deployResult.error,
      } as OperatorCommandResponse);
    }

    // Check for deploy oasis-operator command
    if (normalized === 'deploy oasis-operator to dev' ||
        normalized.startsWith('deploy oasis-operator')) {
      console.log(`[VTID-0525-B] Matched: deploy oasis-operator`);

      await emitOasisEvent({
        vtid,
        type: 'operator.action.scheduled' as any,
        source: 'operator.console.chat',
        status: 'info',
        message: `Scheduled deploy: oasis-operator to dev`,
        payload: {
          action_type: 'deploy',
          service: 'oasis-operator',
          environment: 'dev',
        },
      }).catch(err => console.error('[VTID-0525-B] Event emit failed:', err));

      const deployResult = await deployOrchestrator.executeDeploy({
        vtid,
        service: 'oasis-operator',
        environment: 'dev',
        source: 'operator.console.chat',
      });

      const reply = deployResult.ok
        ? `Deploy requested: oasis-operator to dev. CI/CD pipeline started. ${deployResult.workflow_url ? `Workflow: ${deployResult.workflow_url}` : ''}`
        : `Deploy failed for oasis-operator: ${deployResult.error}`;

      return res.status(200).json({
        ok: deployResult.ok,
        vtid,
        reply,
        command: { action: 'deploy', service: 'oasis-operator', environment: 'dev' },
        workflow_url: deployResult.workflow_url,
        error: deployResult.error,
      } as OperatorCommandResponse);
    }

    // Check for deploy oasis-projector command
    if (normalized === 'deploy oasis-projector to dev' ||
        normalized.startsWith('deploy oasis-projector')) {
      console.log(`[VTID-0525-B] Matched: deploy oasis-projector`);

      await emitOasisEvent({
        vtid,
        type: 'operator.action.scheduled' as any,
        source: 'operator.console.chat',
        status: 'info',
        message: `Scheduled deploy: oasis-projector to dev`,
        payload: {
          action_type: 'deploy',
          service: 'oasis-projector',
          environment: 'dev',
        },
      }).catch(err => console.error('[VTID-0525-B] Event emit failed:', err));

      const deployResult = await deployOrchestrator.executeDeploy({
        vtid,
        service: 'oasis-projector',
        environment: 'dev',
        source: 'operator.console.chat',
      });

      const reply = deployResult.ok
        ? `Deploy requested: oasis-projector to dev. CI/CD pipeline started. ${deployResult.workflow_url ? `Workflow: ${deployResult.workflow_url}` : ''}`
        : `Deploy failed for oasis-projector: ${deployResult.error}`;

      return res.status(200).json({
        ok: deployResult.ok,
        vtid,
        reply,
        command: { action: 'deploy', service: 'oasis-projector', environment: 'dev' },
        workflow_url: deployResult.workflow_url,
        error: deployResult.error,
      } as OperatorCommandResponse);
    }

    // VTID-0525-B: Unrecognized command - return helpful message
    console.log(`[VTID-0525-B] Unrecognized command: "${message}"`);
    return res.status(200).json({
      ok: false,
      vtid,
      reply: 'I currently only understand commands like "Deploy gateway to dev". Natural language commands will be added in a future update.',
      error: 'Command not recognized',
    } as OperatorCommandResponse);

  } catch (error: any) {
    console.error(`[VTID-0525-B] Error:`, error);
    return res.status(500).json({
      ok: false,
      vtid: 'UNKNOWN',
      reply: `Operator command failed due to an internal error.`,
      error: error.message,
    } as OperatorCommandResponse);
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
