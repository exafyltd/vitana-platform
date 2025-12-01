/**
 * Operator Routes - VTID-0509 + VTID-0510 + VTID-0525
 *
 * VTID-0509: Operator Console API (chat, heartbeat, history, upload, session)
 * VTID-0510: Software Version Tracking (deployments)
 * VTID-0525: Operator Command Hub (NL -> Schema -> Deploy Orchestrator)
 *
 * Final API endpoints (after mounting at /api/v1/operator):
 * - POST /api/v1/operator/chat - Operator chat with AI
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
import { ingestOperatorEvent, getTasksSummary, getRecentEvents, getCicdHealth, getOperatorHistory } from '../services/operator-service';
import { getDeploymentHistory, getNextSWV, insertSoftwareVersion } from '../lib/versioning';
import { naturalLanguageService } from '../services/natural-language-service';
import {
  OperatorCommandRequestSchema,
  OperatorDeployRequestSchema,
  OperatorCommandResponse,
  OperatorDeployResponse,
  ALLOWED_COMMAND_SERVICES,
} from '../types/operator-command';
import cicdEvents from '../services/oasis-event-service';

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

// ==================== VTID-0525 Routes ====================
// Operator Command Hub: NL -> Schema -> Deploy/Task Orchestrator
// Single front door to VTID creation, OASIS events, safe deploy orchestrator, and task creation

import deployOrchestrator from '../services/deploy-orchestrator';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  DeployCommandSchema,
  TaskCommandSchema,
} from '../types/operator-command';

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
 * Natural language command parser and executor.
 * Single front door for Operator Console Chat:
 * - Auto-creates VTID if not provided
 * - Writes operator.chat.request and operator.action.scheduled events to OASIS
 * - For deploy: Uses the shared deploy orchestrator (same as Publish modal)
 * - For task: Creates Command Hub tasks
 */
router.post('/command', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[Operator Command] Request ${requestId} started`);

  try {
    const validation = OperatorCommandRequestSchema.safeParse(req.body);
    if (!validation.success) {
      console.error(`[Operator Command] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        vtid: 'UNKNOWN',
        reply: 'Invalid request: ' + validation.error.errors.map(e => e.message).join(', '),
        error: 'Validation failed',
      } as OperatorCommandResponse);
    }

    const { message, environment, default_branch } = validation.data;
    let vtid = validation.data.vtid;

    // Step 1: Ensure VTID exists (auto-create if missing)
    if (!vtid) {
      console.log(`[Operator Command] No VTID provided, creating one...`);
      const vtidResult = await deployOrchestrator.createVtid(
        'OASIS',
        'CMD',
        `Operator Command: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`
      );

      if (!vtidResult.ok || !vtidResult.vtid) {
        return res.status(500).json({
          ok: false,
          vtid: 'UNKNOWN',
          reply: 'Failed to create VTID for this command.',
          error: vtidResult.error || 'VTID creation failed',
        } as OperatorCommandResponse);
      }

      vtid = vtidResult.vtid;
      console.log(`[Operator Command] Created VTID: ${vtid}`);
    }

    // Step 2: Parse natural language into structured command using Gemini
    console.log(`[Operator Command] Parsing message: "${message}"`);
    const parsedCommand = await naturalLanguageService.parseCommand(message);

    // Step 3: Write operator.chat.request event to OASIS
    await emitOasisEvent({
      vtid,
      type: 'operator.chat.request' as any,
      source: 'operator.console.chat',
      status: 'info',
      message: `Chat request: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
      payload: {
        request_id: requestId,
        message,
        parsed_command: parsedCommand,
      },
    });

    // Check for parsing errors
    if (parsedCommand.error) {
      console.log(`[Operator Command] Parse error: ${parsedCommand.error}`);
      return res.status(200).json({
        ok: false,
        vtid,
        reply: `I couldn't understand that command: ${parsedCommand.error}. Try something like "Deploy gateway to dev" or "Show latest errors".`,
        error: parsedCommand.error,
      } as OperatorCommandResponse);
    }

    // Step 4: Handle based on action type
    if (parsedCommand.action === 'deploy') {
      // Validate deploy command
      const deployValidation = DeployCommandSchema.safeParse({
        action: 'deploy',
        service: parsedCommand.service,
        environment: parsedCommand.environment || environment,
        branch: parsedCommand.branch || default_branch,
        vtid: vtid,
        dry_run: parsedCommand.dry_run || false,
      });

      if (!deployValidation.success) {
        const errorDetails = deployValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        return res.status(200).json({
          ok: false,
          vtid,
          reply: `Invalid deploy command: ${errorDetails}. Make sure to specify a valid service (gateway, oasis-operator, oasis-projector).`,
          error: errorDetails,
        } as OperatorCommandResponse);
      }

      const command = deployValidation.data;

      // Handle dry_run
      if (command.dry_run) {
        return res.status(200).json({
          ok: true,
          vtid,
          reply: `[Dry Run] Would deploy ${command.service} to ${command.environment} from branch ${command.branch} (VTID: ${vtid}).`,
          command,
        } as OperatorCommandResponse);
      }

      // Write operator.action.scheduled event to OASIS
      await emitOasisEvent({
        vtid,
        type: 'operator.action.scheduled' as any,
        source: 'operator.console.chat',
        status: 'info',
        message: `Scheduled deploy: ${command.service} to ${command.environment}`,
        payload: {
          action_type: 'deploy',
          service: command.service,
          environment: command.environment,
          branch: command.branch,
        },
      });

      // Execute deploy using the shared orchestrator
      console.log(`[Operator Command] Executing deploy for ${command.service}`);
      const deployResult = await deployOrchestrator.executeDeploy({
        vtid: command.vtid,
        service: command.service,
        environment: command.environment,
        branch: command.branch,
        source: 'operator.console.chat',
      });

      // Generate operator reply
      const reply = deployResult.ok
        ? `Deploying ${command.service} to ${command.environment} via safe orchestrator for ${vtid}. ${deployResult.workflow_url ? `Workflow: ${deployResult.workflow_url}` : ''}`
        : `Deploy failed for ${command.service}: ${deployResult.error}`;

      return res.status(200).json({
        ok: deployResult.ok,
        vtid,
        reply,
        command,
        workflow_url: deployResult.workflow_url,
        error: deployResult.error,
      } as OperatorCommandResponse);
    }

    if (parsedCommand.action === 'task') {
      // Validate task command
      const taskValidation = TaskCommandSchema.safeParse({
        action: 'task',
        task_type: parsedCommand.task_type || 'operator.task.generic',
        title: parsedCommand.title || message.substring(0, 100),
        vtid: vtid,
      });

      if (!taskValidation.success) {
        const errorDetails = taskValidation.error.errors.map(e => e.message).join(', ');
        return res.status(200).json({
          ok: false,
          vtid,
          reply: `Invalid task command: ${errorDetails}`,
          error: errorDetails,
        } as OperatorCommandResponse);
      }

      const command = taskValidation.data;

      // Write operator.action.scheduled event to OASIS
      await emitOasisEvent({
        vtid,
        type: 'operator.action.scheduled' as any,
        source: 'operator.console.chat',
        status: 'info',
        message: `Scheduled task: ${command.task_type}`,
        payload: {
          action_type: 'task',
          task_type: command.task_type,
          title: command.title,
        },
      });

      // Create task using the existing task creation infrastructure
      console.log(`[Operator Command] Creating task: ${command.task_type}`);
      const taskResult = await deployOrchestrator.createTask(
        vtid,
        command.title,
        command.task_type,
        { original_message: message }
      );

      if (!taskResult.ok) {
        return res.status(200).json({
          ok: false,
          vtid,
          reply: `Failed to create task: ${taskResult.error}`,
          error: taskResult.error,
        } as OperatorCommandResponse);
      }

      const reply = `Scheduled ${command.task_type.split('.').pop()} task under ${vtid}. Task ID: ${taskResult.task_id}`;

      return res.status(200).json({
        ok: true,
        vtid,
        reply,
        command,
        task_id: taskResult.task_id,
      } as OperatorCommandResponse);
    }

    // Unknown action
    return res.status(200).json({
      ok: false,
      vtid,
      reply: `Unknown command action: ${parsedCommand.action}. Try "Deploy gateway to dev" or "Show latest errors".`,
      error: `Unknown action: ${parsedCommand.action}`,
    } as OperatorCommandResponse);

  } catch (error: any) {
    console.error(`[Operator Command] Error:`, error);
    return res.status(500).json({
      ok: false,
      vtid: req.body?.vtid || 'UNKNOWN',
      reply: `Command error: ${error.message}`,
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
