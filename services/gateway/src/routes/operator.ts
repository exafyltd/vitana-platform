/**
 * Operator Routes - VTID-0509 + VTID-0510 + VTID-0525 + VTID-0531 + VTID-0532 + VTID-0536 + VTID-01018
 *
 * VTID-0509: Operator Console API (chat, heartbeat, history, upload, session)
 * VTID-0510: Software Version Tracking (deployments)
 * VTID-0525: Operator Command Hub (NL -> Schema -> Deploy Orchestrator)
 * VTID-0531: Operator Chat → OASIS Integration & Thread/VTID Hardening
 * VTID-0532: Operator Task Extractor + VTID/Planner Handoff
 * VTID-0536: Gemini Operator Tools Bridge (autopilot.create_task, get_status, list_recent_tasks)
 * VTID-01018: Operator → OASIS Reliability (Hard Contract Lock)
 *             - Mandatory operator.action.started/completed/failed lifecycle
 *             - Canonical payload validation with hard rejection
 *             - Atomicity: started must persist before terminal event
 *             - Failure enforcement: OASIS write failure = action failure
 *
 * Final API endpoints (after mounting at /api/v1/operator):
 * - POST /api/v1/operator/chat - Operator chat with AI (+ task extraction VTID-0532 + tools VTID-0536)
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
// VTID-0536: Gemini Operator Tools Bridge
import { processWithGemini } from '../services/gemini-operator';
import {
  ingestOperatorEvent,
  getTasksSummary,
  getRecentEvents,
  getCicdHealth,
  getOperatorHistory,
  ingestChatMessageEvent,
  validateVtidExists,
  getChatThreadHistory,
  createOperatorTask,
  CreatedTask
} from '../services/operator-service';
// VTID-01149: Unified Task-Creation Intake
import {
  detectTaskCreationIntent,
  hasActiveIntake,
  getIntakeState,
  startIntake,
  processIntakeAnswer,
  getNextQuestion,
  completeIntakeAndSchedule,
  looksLikeAnswer,
  generateIntakeStartMessage,
  INTAKE_QUESTIONS
} from '../services/task-intake-service';
import { OperatorChatMessageSchema, OperatorChatRole, OperatorChatMode } from '../types/operator-chat';
import { getDeploymentHistory, getNextSWV, insertSoftwareVersion, SoftwareVersion } from '../lib/versioning';
// Phase 0 staging build (P0.4): VTID allocator + Cloud Run Admin + admin auth.
import { allocateVtid } from '../services/operator-service';
import { describeService, listRevisions, updateTrafficToRevision, shortRevisionName } from '../services/cloud-run-admin';
// Note: deployOrchestrator + emitOasisEvent are imported mid-file (lines ~590).
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
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
// VTID-01018: Hard contract enforcement for operator actions
import { executeWithOasisContract, OperatorActionContext } from '../services/operator-action-contract';
import { OperatorActionResult, OasisWriteFailedError } from '../types/cicd';

const router = Router();

// VTID-01018: Helper to extract operator ID from request (default to 'system' for now)
function getOperatorId(req: Request): string {
  // TODO: Extract from auth headers when authentication is implemented
  return (req.headers['x-operator-id'] as string) || 'system';
}

// VTID-01018: Helper to extract operator role from request
function getOperatorRole(req: Request): 'operator' | 'admin' | 'system' {
  const role = req.headers['x-operator-role'] as string;
  if (role === 'admin' || role === 'operator') return role;
  return 'system';
}

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
 * VTID-0532: Added task detection and automatic VTID/Task creation
 */
router.post('/chat', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[Operator Chat] Request ${requestId} started`);

  try {
    // VTID-0531: Use extended schema with threadId, vtid, role, mode
    const validation = OperatorChatMessageSchema.safeParse(req.body);
    if (!validation.success) {
      console.warn(`[Operator Chat] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      });
    }

    const { message, attachments, role, mode, metadata, conversation_id, context } = validation.data;

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

    // =========================================================================
    // VTID-01149: Unified Task-Creation Intake Mode
    // Check for active intake session OR detect task creation intent
    // Uses the same logic as ORB for consistency (Section 2)
    // =========================================================================

    const rawMessage = message ?? '';

    // VTID-01149: Intake flow DISABLED — in-memory state lost on deploy/restart/scale.
    // Task creation handled by Gemini autopilot_create_task tool or /task command.
    // Re-enable with persistent storage (Redis/DB) for intake state.
    /* INTAKE FLOW DISABLED
    if (hasActiveIntake(threadId)) {
      ... intake Q&A handling removed to fix tsc strict null errors ...
      ... see git history for full implementation ...
    }
    END INTAKE FLOW */

    // Check if this message indicates task creation intent and start intake
    // Only if not already in intake mode
    // Skip if explicit /task command (that goes through legacy flow for backwards compatibility)
    const isSlashTask = rawMessage.trim().toLowerCase().startsWith('/task ');

    // VTID-01149: Intake detection DISABLED — Gemini handles task creation via autopilot_create_task tool
    // Re-enable with persistent storage (Redis/DB) for intake state.
    /* INTAKE DETECTION DISABLED
    if (!isSlashTask && !hasActiveIntake(threadId) && detectTaskCreationIntent(rawMessage)) {
      ... intake start + first question removed to fix tsc strict null errors ...
      ... see git history for full implementation ...
    }
    END INTAKE DETECTION */

    // VTID-0532: Task detection logic (legacy path for /task command)
    // A message is treated as a task request if:
    // - mode === 'task', OR
    // - message starts with '/task ' (case-insensitive, leading spaces allowed)
    // Note: rawMessage and isSlashTask already defined above in VTID-01149 section
    const isTaskRequest = mode === 'task' || isSlashTask;

    // VTID-0532: Extract raw description for task
    let rawDescription = '';
    if (isTaskRequest) {
      if (isSlashTask) {
        // "/task Add a Governance History tab..." -> "Add a Governance History tab..."
        rawDescription = rawMessage.trim().slice(5).trim();
      } else {
        // mode === 'task' and no /task prefix - use full message
        rawDescription = rawMessage;
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

    // VTID-0532: Create VTID + Task if this is a task request
    let createdTask: CreatedTask | undefined;
    if (isTaskRequest) {
      console.log(`[VTID-0532] Task request detected (mode=${mode}, isSlashTask=${isSlashTask})`);
      createdTask = await createOperatorTask({
        rawDescription,
        sourceThreadId: threadId,
        sourceMessageId: operatorMessageId
      });

      if (createdTask) {
        console.log(`[VTID-0532] Task created: ${createdTask.vtid} - "${createdTask.title}"`);
      } else {
        console.warn(`[VTID-0532] Task creation failed for request ${requestId}`);
      }
    }

    // VTID-0536: Use Gemini Operator Tools Bridge for AI processing
    // This enables function calling for autopilot.create_task, get_status, and list_recent_tasks
    // Falls back to local routing if Gemini API is not configured
    // VTID-01027: Pass conversation history for session memory
    console.log(`[VTID-01027] Processing with conversation_id: ${conversation_id}, context messages: ${context?.length || 0}`);
    const geminiResult = await processWithGemini({
      text: message,
      threadId,
      attachments: attachments.map(a => ({ oasis_ref: a.oasis_ref, kind: a.kind })),
      context: {
        vtid: validatedVtid || 'VTID-0536',
        request_id: requestId,
        mode: mode
      },
      // VTID-01027: Conversation history for context
      conversationHistory: context || [],
      conversationId: conversation_id
    });

    // VTID-0536: Check if Gemini created a task via tools (in addition to explicit /task command)
    let geminiCreatedTask: CreatedTask | undefined;
    if (geminiResult.toolResults) {
      const createTaskResult = geminiResult.toolResults.find(
        tr => tr.name === 'autopilot_create_task' && tr.response.ok
      );
      if (createTaskResult && createTaskResult.response.vtid) {
        geminiCreatedTask = {
          vtid: createTaskResult.response.vtid as string,
          title: createTaskResult.response.title as string || 'Untitled',
          mode: 'plan-only'
        };
      }
    }

    // Use the task created by explicit /task command or by Gemini tools
    const finalCreatedTask = createdTask || geminiCreatedTask;

    // VTID-0531: Log assistant response with unified event type
    const assistantEventResult = await ingestChatMessageEvent({
      threadId,
      vtid: validatedVtid,
      role: 'assistant',
      mode: mode as OperatorChatMode,
      message: geminiResult.reply,
      metadata: {
        request_id: requestId,
        ...(geminiResult.meta || {}),
        // VTID-0532 + VTID-0536: Include created task reference if task was created
        ...(finalCreatedTask ? { createdTaskVtid: finalCreatedTask.vtid } : {}),
        // VTID-0536: Include tool calls info if any
        ...(geminiResult.toolResults ? { toolCalls: geminiResult.toolResults.map(tr => tr.name) } : {})
      }
    });

    const assistantMessageId = assistantEventResult.eventId || randomUUID();

    console.log(`[Operator Chat] Request ${requestId} completed successfully (thread: ${threadId})`);

    // VTID-0531 + VTID-0532 + VTID-0536: Extended response with threadId, messageId, createdAt, and optional createdTask
    const response: Record<string, unknown> = {
      ok: true,
      reply: geminiResult.reply,
      attachments: attachments,
      oasis_ref: `OASIS-CHAT-${requestId.slice(0, 8).toUpperCase()}`,
      meta: geminiResult.meta || {},
      // VTID-0531: Extended fields
      threadId,
      messageId: assistantMessageId,  // ID of the assistant response event
      createdAt
    };

    // VTID-0532 + VTID-0536: Add createdTask when a task was created (explicit or via tools)
    if (finalCreatedTask) {
      response.createdTask = finalCreatedTask;
    }

    // VTID-0536: Include tool results if any tools were called
    if (geminiResult.toolResults && geminiResult.toolResults.length > 0) {
      response.toolResults = geminiResult.toolResults;
    }

    return res.status(200).json(response);

  } catch (error: any) {
    console.warn(`[Operator Chat] Error:`, error);

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
    console.warn('[Operator Chat History] Error:', error);
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
 * VTID-01004: Heartbeat events are now diagnostics-only (not persisted to OASIS)
 */
router.get('/heartbeat', async (_req: Request, res: Response) => {
  console.log('[Operator Heartbeat] Snapshot requested');

  try {
    // VTID-01004: Heartbeat event is logged for diagnostics only
    // The ingestOperatorEvent function will block this from OASIS ingestion
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
    console.warn('[Operator Heartbeat] Error:', error);
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
    console.warn('[Operator History] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to fetch operator history',
      details: error.message
    });
  }
});

/**
 * POST /heartbeat/session → /api/v1/operator/heartbeat/session
 * VTID-01004: Heartbeat session events are diagnostics-only (not persisted to OASIS)
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

    // VTID-01004: Heartbeat session event is logged for diagnostics only
    // The ingestOperatorEvent function will block this from OASIS ingestion
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
    console.warn('[Operator Session] Error:', error);
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
    console.warn('[Operator Upload] Error:', error);
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
import { triggerWorkflow } from '../services/github-service';
import { emitOasisEvent } from '../services/oasis-event-service';
// VTID-0525-B: DeployCommandSchema and TaskCommandSchema unused in MVP
// import { DeployCommandSchema, TaskCommandSchema } from '../types/operator-command';

/**
 * POST /deploy → /api/v1/operator/deploy
 * Deploy orchestrator: uses the shared deploy service (same as Publish modal).
 * This is the single orchestrator that executes deployment workflows.
 * VTID-01018: Updated with hard OASIS contract enforcement.
 */
router.post('/deploy', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[VTID-01018] Operator Deploy ${requestId} started`);

  try {
    const validation = OperatorDeployRequestSchema.safeParse(req.body);
    if (!validation.success) {
      console.warn(`[VTID-01018] Deploy validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        vtid: req.body?.vtid || 'UNKNOWN',
        service: req.body?.service || 'UNKNOWN',
        environment: req.body?.environment || 'dev',
        error: 'Validation failed',
      } as OperatorDeployResponse);
    }

    const { vtid, service, environment, source } = validation.data;
    const operatorId = getOperatorId(req);
    const operatorRole = getOperatorRole(req);

    // VTID-01018: Execute deploy with hard OASIS contract
    const actionContext: OperatorActionContext = {
      vtid,
      operatorId,
      operatorRole,
      actionType: 'deploy',
      actionPayload: {
        service,
        environment,
        source,
        request_id: requestId,
      },
    };

    const result = await executeWithOasisContract(actionContext, async () => {
      // Use the shared deploy orchestrator (same implementation as Publish modal)
      const deployResult = await deployOrchestrator.executeDeploy({
        vtid,
        service,
        environment,
        source,
      });

      if (!deployResult.ok) {
        throw new Error(deployResult.error || 'Deploy execution failed');
      }

      return deployResult;
    });

    if (!result.ok) {
      // VTID-01018: Return structured error with OASIS failure details
      return res.status(500).json({
        ok: false,
        vtid,
        service,
        environment,
        error: result.oasis_error?.reason || 'Deploy failed with OASIS contract violation',
        operator_action_id: result.operator_action_id,
      } as OperatorDeployResponse);
    }

    const deployData = result.data as { workflow_run_id?: number; workflow_url?: string };

    return res.status(200).json({
      ok: true,
      vtid,
      service,
      environment,
      workflow_run_id: deployData.workflow_run_id,
      workflow_url: deployData.workflow_url,
      operator_action_id: result.operator_action_id,
    } as OperatorDeployResponse);

  } catch (error: any) {
    console.error(`[VTID-01018] Unhandled deploy error:`, error);
    return res.status(500).json({
      ok: false,
      vtid: req.body?.vtid || 'UNKNOWN',
      service: req.body?.service || 'UNKNOWN',
      environment: 'dev',
      error: error.message,
    } as OperatorDeployResponse);
  }
});

/**
 * POST /command → /api/v1/operator/command
 *
 * VTID-0525-B: Simplified MVP command parser.
 * VTID-01018: Updated with hard OASIS contract enforcement.
 *
 * - Simple deterministic matching (no NL parsing for now)
 * - Only supports explicit deploy commands: "deploy gateway to dev", "deploy oasis-operator to dev"
 * - Uses placeholder VTID instead of auto-creating in vtid_ledger
 * - Uses existing CICD bridge (same as Publish modal)
 * - MANDATORY: All actions emit started + terminal OASIS events
 */
router.post('/command', async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[VTID-01018] Operator Command ${requestId} started`);

  try {
    const validation = OperatorCommandRequestSchema.safeParse(req.body);
    if (!validation.success) {
      console.warn(`[VTID-01018] Validation failed:`, validation.error.errors);
      return res.status(400).json({
        ok: false,
        vtid: 'UNKNOWN',
        reply: 'Invalid request: ' + validation.error.errors.map(e => e.message).join(', '),
        error: 'Validation failed',
      } as OperatorCommandResponse);
    }

    const { message, environment } = validation.data;
    const normalized = message.trim().toLowerCase();
    const operatorId = getOperatorId(req);
    const operatorRole = getOperatorRole(req);

    // VTID-0525-B: Generate a simple placeholder VTID
    const timestamp = Date.now().toString(36).toUpperCase();
    const vtid = `OASIS-CMD-${timestamp}`;
    console.log(`[VTID-01018] Using placeholder VTID: ${vtid}`);

    // VTID-01018: Helper to execute deploy with hard contract
    const executeDeployWithContract = async (service: 'gateway' | 'oasis-operator' | 'oasis-projector'): Promise<OperatorCommandResponse> => {
      const actionContext: OperatorActionContext = {
        vtid,
        operatorId,
        operatorRole,
        actionType: 'deploy',
        actionPayload: {
          service,
          environment: 'dev',
          message,
          request_id: requestId,
        },
      };

      const result = await executeWithOasisContract(actionContext, async () => {
        // Execute deploy using the shared orchestrator
        const deployResult = await deployOrchestrator.executeDeploy({
          vtid,
          service,
          environment: 'dev',
          source: 'operator.console.chat',
        });

        if (!deployResult.ok) {
          throw new Error(deployResult.error || 'Deploy execution failed');
        }

        return deployResult;
      });

      if (!result.ok) {
        // VTID-01018: OASIS write failed OR action failed - return structured error
        const errorResponse: OperatorCommandResponse = {
          ok: false,
          vtid,
          reply: result.oasis_error
            ? `Deploy blocked: OASIS event write failed - ${result.oasis_error.reason}`
            : `Deploy failed for ${service}: unknown error`,
          error: result.oasis_error?.reason || 'oasis_write_failed',
          operator_action_id: result.operator_action_id,
        };
        return errorResponse;
      }

      const deployData = result.data as { workflow_url?: string };
      return {
        ok: true,
        vtid,
        reply: `Deploy requested: ${service} to dev. CI/CD pipeline started. ${deployData.workflow_url ? `Workflow: ${deployData.workflow_url}` : ''}`,
        command: { action: 'deploy' as const, service, environment: 'dev' as const, vtid, branch: 'main', dry_run: false },
        workflow_url: deployData.workflow_url,
        operator_action_id: result.operator_action_id,
      };
    };

    // VTID-0525-B: Simple deterministic command matching (MVP)
    // Check for deploy gateway command
    if (normalized === 'deploy gateway to dev' || normalized.startsWith('deploy gateway')) {
      console.log(`[VTID-01018] Matched: deploy gateway`);
      const response = await executeDeployWithContract('gateway');
      return res.status(response.ok ? 200 : 500).json(response);
    }

    // Check for deploy oasis-operator command
    if (normalized === 'deploy oasis-operator to dev' || normalized.startsWith('deploy oasis-operator')) {
      console.log(`[VTID-01018] Matched: deploy oasis-operator`);
      const response = await executeDeployWithContract('oasis-operator');
      return res.status(response.ok ? 200 : 500).json(response);
    }

    // Check for deploy oasis-projector command
    if (normalized === 'deploy oasis-projector to dev' || normalized.startsWith('deploy oasis-projector')) {
      console.log(`[VTID-01018] Matched: deploy oasis-projector`);
      const response = await executeDeployWithContract('oasis-projector');
      return res.status(response.ok ? 200 : 500).json(response);
    }

    // VTID-01018: Unrecognized command - emit failed action event
    console.log(`[VTID-01018] Unrecognized command: "${message}"`);

    const actionContext: OperatorActionContext = {
      vtid,
      operatorId,
      operatorRole,
      actionType: 'command',
      actionPayload: { message, request_id: requestId },
    };

    const result = await executeWithOasisContract(actionContext, async () => {
      throw new Error('Command not recognized');
    });

    return res.status(200).json({
      ok: false,
      vtid,
      reply: 'I currently only understand commands like "Deploy gateway to dev". Natural language commands will be added in a future update.',
      error: 'Command not recognized',
      operator_action_id: result.operator_action_id,
    } as OperatorCommandResponse);

  } catch (error: any) {
    console.error(`[VTID-01018] Unhandled error:`, error);
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
// Phase 0 staging build (P0.4): 30s in-process cache of active Cloud Run
// revision per service so the CLOCK dropdown's `is_active` field doesn't burn
// a Cloud Run Admin API call per row.
const ACTIVE_REV_CACHE: Map<string, { activeRevision: string | null; expiresAt: number }> = new Map();
const ACTIVE_REV_TTL_MS = 30_000;

async function getActiveRevisionCached(service: string): Promise<string | null> {
  const cached = ACTIVE_REV_CACHE.get(service);
  if (cached && cached.expiresAt > Date.now()) return cached.activeRevision;
  try {
    const summary = await describeService(service);
    const active = summary.activeRevision;
    ACTIVE_REV_CACHE.set(service, { activeRevision: active, expiresAt: Date.now() + ACTIVE_REV_TTL_MS });
    return active;
  } catch (err) {
    console.warn(`[Operator] active-revision lookup failed for ${service}: ${err instanceof Error ? err.message : 'unknown'}`);
    return null;
  }
}

/**
 * Compute the display label the CLOCK history view shows in its "deploy type"
 * column. Derives a richer label from the storage-side (deploy_type, environment,
 * source_revision) triple — no DB schema change needed.
 *
 *   environment=staging,    deploy_type=normal,   source=null  → "staging-deploy"
 *   environment=production, deploy_type=normal,   source!=null → "staging-publish"
 *   environment=production, deploy_type=normal,   source=null  → "deploy"
 *   *,                       deploy_type=rollback              → "revert"
 */
function displayDeployType(row: SoftwareVersion): string {
  if (row.deploy_type === 'rollback') return 'revert';
  if (row.environment === 'staging' || row.environment === 'staging-supabase') return 'staging-deploy';
  if (row.source_revision) return 'staging-publish';
  return 'deploy';
}

const REVERT_AGE_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;

router.get('/deployments', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const serviceFilter = (req.query.service as string | undefined)?.trim();
    const envFilter = (req.query.environment as string | undefined)?.trim();

    const result = await getDeploymentHistory(limit);

    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Database query failed',
        detail: result.error,
      });
    }

    let rows = result.deployments || [];
    if (serviceFilter) rows = rows.filter(r => r.service === serviceFilter);
    if (envFilter) rows = rows.filter(r => r.environment === envFilter);

    // Active-revision cache lookup is done once per distinct service to keep
    // this endpoint O(unique-services) Cloud Run calls instead of O(rows).
    const distinctServices = Array.from(new Set(rows.map(r => r.service)));
    const activeByService = new Map<string, string | null>();
    await Promise.all(
      distinctServices.map(async svc => {
        activeByService.set(svc, await getActiveRevisionCached(svc));
      })
    );

    const nowMs = Date.now();

    const deployments = rows.map((d) => {
      const createdMs = d.created_at ? Date.parse(d.created_at) : nowMs;
      const ageMs = nowMs - createdMs;
      const cloudRev = d.cloud_run_revision ?? null;
      const activeShort = activeByService.get(d.service)
        ? shortRevisionName(activeByService.get(d.service) as string)
        : null;
      const isActive = !!(cloudRev && activeShort && cloudRev === activeShort);

      return {
        swv_id: d.swv_id,
        created_at: d.created_at,
        git_commit: d.git_commit,
        status: d.status,
        initiator: d.initiator,
        initiator_id: d.initiator_id ?? null,
        deploy_type: d.deploy_type,
        // Phase 0 staging build: derived display label.
        display_deploy_type: displayDeployType(d),
        service: d.service,
        environment: d.environment,
        cloud_run_revision: cloudRev,
        source_revision: d.source_revision ?? null,
        is_active: isActive,
        revert_eligible:
          d.status === 'success' &&
          !!cloudRev &&
          ageMs < REVERT_AGE_LIMIT_MS &&
          !isActive, // can't revert to the row that IS active
      };
    });

    return res.status(200).json(deployments);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[Operator] Error fetching deployments: ${errorMessage}`);
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
    const { service, git_commit, deploy_type, initiator, environment, cloud_run_revision } = req.body;

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
      // BOOTSTRAP-PHASE0-UX: persist the Cloud Run revision name so the
      // CLOCK dropdown can flag the LIVE row. EXEC-DEPLOY now sends this.
      cloud_run_revision: typeof cloud_run_revision === 'string' && cloud_run_revision.length > 0 ? cloud_run_revision : null,
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
    console.warn(`[Operator] Error recording deployment: ${errorMessage}`);
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

// ==================== VTID-0541: OASIS Repair Endpoints ====================

/**
 * POST /repair/vtid-0540 → /api/v1/operator/repair/vtid-0540
 * VTID-0541 D1: Retroactively register VTID-0540 in OASIS
 * This endpoint implements the repair script logic directly
 */
router.post('/repair/vtid-0540', async (req: Request, res: Response) => {
  console.log('[VTID-0541] Repair endpoint called for VTID-0540');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return res.status(503).json({
      ok: false,
      error: 'Supabase not configured',
      message: 'Cannot perform repair without database connection'
    });
  }

  try {
    const timestamp = new Date().toISOString();
    const results: { step: string; success: boolean; message: string }[] = [];

    // Step 1: Check if VTID-0540 already exists
    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.VTID-0540&select=vtid&limit=1`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!checkResp.ok) {
      throw new Error(`Failed to check VTID-0540 existence: ${checkResp.status}`);
    }

    const existingData = await checkResp.json() as any[];
    const vtidExists = existingData.length > 0;

    if (vtidExists) {
      results.push({ step: 'check_vtid', success: true, message: 'VTID-0540 already exists in ledger' });
    } else {
      // Step 2: Create VTID-0540 entry
      const vtid0540Entry = {
        vtid: 'VTID-0540',
        title: 'Gemini Vertex ADC Health Gate Fix',
        summary: 'Updated assistant routes health check to verify Vertex AI configuration. Retroactively registered by VTID-0541.',
        layer: 'DEV',
        module: 'GW',
        status: 'deployed',
        metadata: { repair_vtid: 'VTID-0541', note: 'Retroactively registered' }
      };

      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(vtid0540Entry)
      });

      if (insertResp.ok) {
        results.push({ step: 'create_vtid', success: true, message: 'VTID-0540 created in ledger' });
      } else {
        const text = await insertResp.text();
        results.push({ step: 'create_vtid', success: false, message: `Failed to create VTID: ${text}` });
      }
    }

    // Step 3: Create deploy success event
    const deployEvent = {
      id: randomUUID(),
      vtid: 'VTID-0540',
      topic: 'deploy.service.success',
      service: 'gateway',
      role: 'CICD',
      model: 'exec-deploy',
      status: 'success',
      message: 'VTID-0540: Gemini Vertex ADC Health Gate Fix deployed successfully',
      metadata: {
        service: 'gateway',
        environment: 'dev',
        repair_vtid: 'VTID-0541',
        note: 'Deployment event retroactively created by VTID-0541'
      },
      created_at: '2025-12-15T10:05:00.000Z'
    };

    const eventResp = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(deployEvent)
    });

    if (eventResp.ok) {
      results.push({ step: 'create_event', success: true, message: 'Deploy success event created' });
    } else {
      results.push({ step: 'create_event', success: false, message: 'Event may already exist' });
    }

    // Step 4: Emit repair completion event
    const repairEvent = {
      id: randomUUID(),
      vtid: 'VTID-0541',
      topic: 'repair.vtid.completed',
      service: 'gateway',
      role: 'SYSTEM',
      model: 'repair-endpoint',
      status: 'success',
      message: 'VTID-0541: VTID-0540 retroactively registered via repair endpoint',
      metadata: {
        target_vtid: 'VTID-0540',
        results
      },
      created_at: timestamp
    };

    await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(repairEvent)
    });

    console.log('[VTID-0541] Repair completed:', results);

    return res.status(200).json({
      ok: true,
      vtid: 'VTID-0541',
      target: 'VTID-0540',
      message: 'VTID-0540 retroactively registered in OASIS',
      results,
      timestamp
    });

  } catch (error: any) {
    console.error('[VTID-0541] Repair failed:', error);
    return res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Repair operation failed'
    });
  }
});

// ====================================================================
// Phase 0 staging build (handoff brief P0.4): publish / revert / revisions
// ====================================================================
//
// Three new admin-gated endpoints power the PUBLISH and CLOCK buttons in the
// Command Hub top bar:
//
//   GET  /api/v1/operator/revisions?service=gateway[-staging]
//        — list recent Cloud Run revisions for the CLOCK history view.
//
//   POST /api/v1/operator/publish
//        — promote the current `gateway-staging` active revision to `gateway`
//          (production) via EXEC-DEPLOY.yml. Records source_revision in the
//          software_versions row so the CLOCK history view can render
//          "staging-publish" against the new prod revision.
//
//   POST /api/v1/operator/revert  { service, target_revision }
//        — route 100% of traffic to a past revision via Cloud Run
//          updateService(traffic). Records a deploy_type=rollback row.
//
// All three require an admin JWT (exafy_admin role). The Cloud Run Admin
// API calls run with the gateway's service account ADC — the one-time IAM
// grant (`roles/run.developer`) is documented in the handoff brief.
// --------------------------------------------------------------------

/**
 * GET /revisions → /api/v1/operator/revisions?service=<svc>&limit=<n>
 *
 * Returns Cloud Run revisions for `service` newest-first. Defaults to
 * `gateway` if service param omitted. CLOCK dropdown uses this to render the
 * "all past revisions" tab alongside the software_versions tab.
 */
router.get('/revisions', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const service = ((req.query.service as string | undefined) || 'gateway').trim();
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 100);

    if (!['gateway', 'gateway-staging', 'community-app', 'community-app-staging'].includes(service)) {
      return res.status(400).json({ ok: false, error: 'unsupported_service', service });
    }

    const revisions = await listRevisions(service, limit);
    return res.status(200).json({ ok: true, service, revisions });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[Operator] /revisions failed: ${errorMessage}`);
    return res.status(500).json({ ok: false, error: 'internal_error', detail: errorMessage });
  }
});

const STAGING_PUBLISH_BAKE_MS = (() => {
  const raw = parseInt(process.env.STAGING_PUBLISH_BAKE_SECONDS || '3600', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : 60 * 60 * 1000;
})();

/**
 * POST /publish → /api/v1/operator/publish
 *
 * Body: { confirm_short_sha?: string }  (recommended; not strictly required —
 * the UI's type-to-confirm flow gates the click, the server does its own checks)
 *
 * Flow:
 *   1. requireAdminAuth — admin JWT present + exafy_admin role on identity.
 *   2. Resolve gateway-staging's currently-serving revision (Cloud Run Admin).
 *   3. Read the commit SHA from the revision's env (GIT_COMMIT_SHA) and/or
 *      from software_versions by cloud_run_revision. Fail if neither yields a
 *      SHA — without it the audit trail breaks.
 *   4. Bake-time guard: refuse if the staging revision is <STAGING_PUBLISH_BAKE_SECONDS
 *      seconds old (default 3600 = 1h). Set env to 0 to disable for smoke tests.
 *   5. Allocate a VTID via the canonical allocator (EXEC-DEPLOY gate needs it
 *      in vtid_ledger).
 *   6. Call deployOrchestrator.executeDeploy({ service:'gateway',
 *      environment:'production', source:'api' }) — this dispatches EXEC-DEPLOY.
 *   7. Insert software_versions row with source_revision=<staging revision short
 *      name>, initiator_id=<admin uuid>, deploy_type='normal'. cloud_run_revision
 *      stays NULL — EXEC-DEPLOY's post-deploy step backfills it.
 *   8. Emit production.publish.requested + production.publish.completed events.
 */
router.post('/publish', requireAdminAuth, async (req: Request, res: Response) => {
  const requestId = randomUUID();
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    // Step 2: resolve staging service state.
    let stagingSummary;
    try {
      stagingSummary = await describeService('gateway-staging');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      await emitOasisEvent({
        vtid: 'BOOTSTRAP-PUBLISH',
        type: 'production.publish.failed',
        source: 'gateway-operator',
        status: 'error',
        message: `publish: cannot describe gateway-staging (${msg})`,
        actor_id: identity.user_id,
        actor_role: 'admin',
        surface: 'command-hub',
        payload: { request_id: requestId, stage: 'describe_staging' },
      });
      return res.status(502).json({ ok: false, error: 'staging_unreachable', detail: msg });
    }

    if (!stagingSummary.activeRevision) {
      return res.status(409).json({ ok: false, error: 'staging_has_no_active_revision' });
    }

    const stagingRevShort = stagingSummary.activeRevisionShort!;
    const stagingCommit = stagingSummary.activeRevisionCommit;
    if (!stagingCommit) {
      // Fall back: look up software_versions by cloud_run_revision = stagingRevShort.
      // For Phase 0 a missing SHA is recoverable but flag-worthy; we still
      // refuse to ship without one so the audit trail is complete.
      return res.status(409).json({
        ok: false,
        error: 'staging_commit_unknown',
        detail: `Active staging revision ${stagingRevShort} has no GIT_COMMIT_SHA env var. STAGE-DEPLOY must set this on the revision before publish can proceed.`,
      });
    }

    // Step 4: bake-time guard.
    let ageMs = 0;
    try {
      const rev = (await listRevisions('gateway-staging', 5)).find(r => r.shortName === stagingRevShort);
      if (rev?.createdAt) ageMs = Date.now() - Date.parse(rev.createdAt);
    } catch {
      ageMs = STAGING_PUBLISH_BAKE_MS; // can't read age — treat as old enough; we already verified active rev
    }
    if (STAGING_PUBLISH_BAKE_MS > 0 && ageMs < STAGING_PUBLISH_BAKE_MS) {
      const remainingSec = Math.ceil((STAGING_PUBLISH_BAKE_MS - ageMs) / 1000);
      return res.status(409).json({
        ok: false,
        error: 'bake_time_not_met',
        detail: `Staging revision ${stagingRevShort} is only ${Math.floor(ageMs / 1000)}s old; needs ${STAGING_PUBLISH_BAKE_MS / 1000}s. Wait ${remainingSec}s, or set STAGING_PUBLISH_BAKE_SECONDS=0 to override.`,
      });
    }

    // Step 5: allocate VTID. EXEC-DEPLOY's hard gate requires the ledger row.
    const allocation = await allocateVtid('publish.api', 'INFRA', 'GATEWAY');
    if (!allocation.ok || !allocation.vtid) {
      return res.status(503).json({
        ok: false,
        error: 'vtid_allocation_failed',
        detail: allocation.message || allocation.error || 'unknown',
      });
    }
    const vtid = allocation.vtid;

    // Step 6: publish-requested event before dispatching.
    await emitOasisEvent({
      vtid,
      type: 'production.publish.requested',
      source: 'gateway-operator',
      status: 'info',
      message: `publish: gateway-staging ${stagingRevShort} (${stagingCommit.slice(0, 7)}) → gateway`,
      actor_id: identity.user_id,
      actor_role: 'admin',
      surface: 'command-hub',
      payload: {
        request_id: requestId,
        source_revision: stagingRevShort,
        source_commit: stagingCommit,
        staging_age_seconds: Math.floor(ageMs / 1000),
        confirm_short_sha: typeof req.body?.confirm_short_sha === 'string' ? req.body.confirm_short_sha : null,
      },
    });

    // Voice-first canary mode: defaults to TRUE (recommended for voice).
    // body.mode='full' opts out of canary for low-risk shipments where the
    // operator wants 100% immediately. Body shape:
    //   { confirm_short_sha?: string, mode?: 'canary'|'full' }
    const mode: 'canary' | 'full' = (req.body?.mode === 'full') ? 'full' : 'canary';
    const isCanary = mode === 'canary';

    // Step 7: dispatch the production deploy (EXEC-DEPLOY.yml).
    const deployResult = await deployOrchestrator.executeDeploy({
      vtid,
      service: 'gateway',
      environment: 'production',
      source: 'api',
      canary: isCanary,
      // Ship the EXACT staging commit we resolved + displayed (no main-HEAD drift).
      commitSha: stagingCommit,
    });

    if (!deployResult.ok) {
      await emitOasisEvent({
        vtid,
        type: 'production.publish.failed',
        source: 'gateway-operator',
        status: 'error',
        message: `publish: EXEC-DEPLOY dispatch failed — ${deployResult.error || 'unknown'}`,
        actor_id: identity.user_id,
        actor_role: 'admin',
        surface: 'command-hub',
        payload: {
          request_id: requestId,
          mode,
          source_revision: stagingRevShort,
          source_commit: stagingCommit,
          deploy_error: deployResult.error,
          governance_blocked: deployResult.blocked,
          governance_violations: deployResult.violations,
        },
      });
      return res.status(500).json({
        ok: false,
        vtid,
        error: 'deploy_dispatch_failed',
        detail: deployResult.error,
        blocked: deployResult.blocked,
        violations: deployResult.violations,
      });
    }

    // Step 7b: One-button-both (workstream C) — also promote the FRONTEND.
    // The community app is a separate Cloud Run service in exafyltd/vitana-v1.
    // It must be REBUILT from the tested commit with prod .env (its staging image
    // bakes staging URLs and must never be image-promoted), so we cross-repo
    // dispatch vitana-v1's DEPLOY.yml with the staging commit SHA.
    //
    // Best-effort: the gateway deploy already succeeded; a frontend failure (or a
    // missing cross-repo token) is surfaced separately and does NOT fail publish.
    let frontendPromote: { ok: boolean; detail?: string; source_commit?: string | null } = {
      ok: false,
      detail: 'not_attempted',
    };
    try {
      const FRONTEND_REPO = process.env.FRONTEND_DEPLOY_REPO || 'exafyltd/vitana-v1';
      // PAT (or fine-grained token) with `actions:write` on vitana-v1. The default
      // platform token (GITHUB_SAFE_MERGE_TOKEN) does not span repos.
      const FRONTEND_TOKEN = process.env.FRONTEND_DEPLOY_TOKEN;
      if (!FRONTEND_TOKEN) {
        frontendPromote = {
          ok: false,
          detail: 'FRONTEND_DEPLOY_TOKEN not set — frontend NOT promoted. Run vitana-v1 DEPLOY.yml manually, or set the secret to enable one-button-both.',
        };
      } else {
        // Resolve the commit currently serving on community-app-staging so we
        // ship the exact tested frontend bits (empty → vitana-v1 main HEAD).
        let feCommit: string | null = null;
        try {
          const feStaging = await describeService('community-app-staging');
          feCommit = feStaging.activeRevisionCommit;
        } catch {
          feCommit = null;
        }
        await triggerWorkflow(
          FRONTEND_REPO,
          'DEPLOY.yml',
          'main',
          {
            reason: `publish-both via Command Hub (gateway ${stagingCommit.slice(0, 7)}); frontend ${feCommit ? feCommit.slice(0, 7) : 'main HEAD'}`,
            commit_sha: feCommit || '',
          },
          FRONTEND_TOKEN,
        );
        frontendPromote = { ok: true, source_commit: feCommit };
      }
    } catch (e) {
      frontendPromote = { ok: false, detail: e instanceof Error ? e.message : 'frontend_dispatch_failed' };
    }

    // Step 8: record the publish row in software_versions. cloud_run_revision
    // stays null — STAGE/EXEC-DEPLOY post-deploy step (P0.7) is responsible
    // for backfilling it once the new prod revision is healthy.
    const swvId = await getNextSWV();
    await insertSoftwareVersion({
      swv_id: swvId,
      service: 'gateway',
      git_commit: stagingCommit,
      deploy_type: 'normal',
      initiator: 'user',
      status: 'success', // optimistic — true success is the EXEC-DEPLOY post-deploy event
      environment: 'production',
      cloud_run_revision: null,
      source_revision: stagingRevShort,
      initiator_id: identity.user_id,
    });

    // Emit different terminal events depending on mode.
    // Canary mode: the deploy DOES NOT promote to 100%; emit .requested only.
    //              Operator promotes later via /operator/promote, which emits
    //              production.canary.promoted (or .aborted on discard).
    // Full mode:   same behavior as before — emit production.publish.completed.
    const terminalType = isCanary ? 'production.canary.requested' : 'production.publish.completed';
    const terminalMessage = isCanary
      ? `canary publish requested: ${stagingRevShort} (${stagingCommit.slice(0, 7)}) → 10/90 split scheduled; EXEC-DEPLOY ${deployResult.workflow_url ?? 'dispatched'}`
      : `publish: ${stagingRevShort} promoted; EXEC-DEPLOY ${deployResult.workflow_url ?? 'dispatched'}`;
    await emitOasisEvent({
      vtid,
      type: terminalType,
      source: 'gateway-operator',
      status: 'success',
      message: terminalMessage,
      actor_id: identity.user_id,
      actor_role: 'admin',
      surface: 'command-hub',
      payload: {
        request_id: requestId,
        vtid,
        swv_id: swvId,
        mode,
        source_revision: stagingRevShort,
        source_commit: stagingCommit,
        workflow_run_id: deployResult.workflow_run_id,
        workflow_url: deployResult.workflow_url,
        frontend_promote: frontendPromote,
      },
    });

    return res.status(200).json({
      ok: true,
      vtid,
      swv_id: swvId,
      source_revision: stagingRevShort,
      source_commit: stagingCommit,
      workflow_run_id: deployResult.workflow_run_id,
      workflow_url: deployResult.workflow_url,
      frontend_promote: frontendPromote,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] /publish failed: ${errorMessage}`);
    return res.status(500).json({ ok: false, error: 'internal_error', detail: errorMessage });
  }
});

/**
 * POST /revert → /api/v1/operator/revert
 *
 * Body: { service: 'gateway' | 'gateway-staging', target_revision: string,
 *         confirm_short_sha?: string }
 *
 * Flow:
 *   1. requireAdminAuth.
 *   2. Validate `service` is one of the two Cloud Run services we manage.
 *   3. Validate target_revision exists in the recent revisions list and is
 *      not the currently-active one.
 *   4. Refuse if target_revision is older than 90 days (revert age limit).
 *   5. Call Cloud Run updateService(traffic) → 100% to target.
 *   6. Insert software_versions row with deploy_type='rollback',
 *      cloud_run_revision=<target>, initiator_id=<admin uuid>.
 *   7. Emit production.revert.completed or staging.revert.completed.
 */
// ====================================================================
// Shared revert core + both-repos revert (one-click clock revert).
//
// The Command Hub clock-revert reverts BOTH the backend (gateway) and the
// frontend (community-app) together, so a "go back to the previous version"
// click restores the whole product, not just the API. Both are fast Cloud Run
// traffic shifts to an existing revision (no rebuild). The gateway service
// account must hold roles/run.developer on the community-app services for the
// frontend half; absent that, the frontend result reports shift_failed with the
// IAM detail and the backend revert still stands (we surface partials, never
// hide them).
// ====================================================================

type RevertStatus =
  | 'reverted'
  | 'already_active'
  | 'not_found'
  | 'too_old'
  | 'shift_failed'
  | 'no_target'
  | 'resolve_failed';

interface RevertOutcome {
  status: RevertStatus;
  ok: boolean; // true only for 'reverted'
  service: string;
  target_revision?: string;
  target_commit?: string | null;
  operation_name?: string;
  swv_id?: string;
  detail?: string;
}

/** Cloud Run service pairing: backend ↔ frontend, per environment. */
const REVERT_SIBLING: Record<string, string> = {
  gateway: 'community-app',
  'community-app': 'gateway',
  'gateway-staging': 'community-app-staging',
  'community-app-staging': 'gateway-staging',
};

function isBackendService(service: string): boolean {
  return service === 'gateway' || service === 'gateway-staging';
}

function revertOutcomeToHttp(o: RevertOutcome): number {
  switch (o.status) {
    case 'reverted': return 200;
    case 'not_found': return 404;
    case 'already_active': return 409;
    case 'too_old': return 409;
    case 'shift_failed': return 502;
    default: return 500;
  }
}

/**
 * Validate a target revision, shift 100% traffic to it, record a `rollback`
 * software_versions row, and emit the terminal OASIS event. Used by both
 * POST /revert (single service) and POST /revert-both (gateway + community-app
 * together). Returns a structured outcome; callers decide HTTP status and
 * partial-failure handling. Works for any of the four managed Cloud Run
 * services — environment (production/staging) is derived from the `-staging`
 * suffix.
 */
async function revertOneService(
  service: string,
  targetRevisionRaw: string,
  identity: { user_id: string },
  requestId: string,
): Promise<RevertOutcome> {
  const targetShort = shortRevisionName(targetRevisionRaw);
  const isStaging = service.endsWith('-staging');
  const environment = isStaging ? 'staging' : 'production';

  const revisions = await listRevisions(service, 100);
  const target = revisions.find(r => r.shortName === targetShort);
  if (!target) {
    return {
      status: 'not_found', ok: false, service, target_revision: targetShort,
      detail: `revision ${targetShort} not found in last 100 revisions of ${service}`,
    };
  }
  if (target.isActive) {
    return {
      status: 'already_active', ok: false, service, target_revision: targetShort,
      target_commit: target.commitSha, detail: `${service} is already serving ${targetShort}`,
    };
  }
  const ageMs = target.createdAt ? Date.now() - Date.parse(target.createdAt) : 0;
  if (ageMs > REVERT_AGE_LIMIT_MS) {
    return {
      status: 'too_old', ok: false, service, target_revision: targetShort,
      detail: `revision ${targetShort} is ${Math.floor(ageMs / (24 * 60 * 60 * 1000))} days old; >90d. Re-deploy that commit instead.`,
    };
  }

  const result = await updateTrafficToRevision(service, targetShort);
  if (!result.ok) {
    await emitOasisEvent({
      vtid: 'BOOTSTRAP-REVERT',
      type: isStaging ? 'staging.deploy.failed' : 'production.publish.failed',
      source: 'gateway-operator',
      status: 'error',
      message: `revert: ${service} → ${targetShort} traffic-shift failed (${result.error})`,
      actor_id: identity.user_id,
      actor_role: 'admin',
      surface: 'command-hub',
      payload: { request_id: requestId, service, target_revision: targetShort, error: result.error },
    });
    return {
      status: 'shift_failed', ok: false, service, target_revision: targetShort,
      target_commit: target.commitSha, detail: result.error,
    };
  }

  ACTIVE_REV_CACHE.delete(service); // invalidate cache so next /deployments shows new active
  const swvId = await getNextSWV();
  await insertSoftwareVersion({
    swv_id: swvId,
    service,
    git_commit: target.commitSha || '(unknown)',
    deploy_type: 'rollback',
    initiator: 'user',
    status: 'success',
    environment,
    cloud_run_revision: targetShort,
    source_revision: null,
    initiator_id: identity.user_id,
  });

  await emitOasisEvent({
    vtid: 'BOOTSTRAP-REVERT',
    type: isStaging ? 'staging.revert.completed' : 'production.revert.completed',
    source: 'gateway-operator',
    status: 'success',
    message: `revert: ${service} now serving ${targetShort}`,
    actor_id: identity.user_id,
    actor_role: 'admin',
    surface: 'command-hub',
    payload: {
      request_id: requestId,
      service,
      target_revision: targetShort,
      target_commit: target.commitSha,
      operation_name: result.operationName,
      swv_id: swvId,
    },
  });

  return {
    status: 'reverted', ok: true, service, target_revision: targetShort,
    target_commit: target.commitSha, operation_name: result.operationName, swv_id: swvId,
  };
}

/**
 * POST /api/v1/operator/revert-both → /api/v1/operator/revert-both
 *
 * One-click "go back to the previous version" across BOTH repos. Reverts the
 * anchor service (the clicked clock row) to `target_revision`, then reverts its
 * paired sibling to the revision that sibling was serving at the anchor's deploy
 * time (`target_created_at`), falling back to the sibling's immediately-previous
 * revision when no timestamp is supplied. Anchor success drives the HTTP status;
 * the sibling result is always reported alongside (skips/failures included).
 */
router.post('/revert-both', requireAdminAuth, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: the state-transition events (production/staging.
  // revert.completed) are emitted inside revertOneService() for each service
  // this handler reverts, not in the handler body.
  const requestId = randomUUID();
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const service = (req.body?.service || '').toString().trim();
  const targetRevisionRaw = (req.body?.target_revision || '').toString().trim();
  const anchorCreatedAt = (req.body?.target_created_at || '').toString().trim();

  const sibling = REVERT_SIBLING[service];
  if (!sibling) {
    return res.status(400).json({
      ok: false, error: 'invalid_service',
      detail: 'service must be gateway, gateway-staging, community-app, or community-app-staging',
    });
  }
  if (!targetRevisionRaw) {
    return res.status(400).json({ ok: false, error: 'missing_target_revision' });
  }

  try {
    // 1. Revert the anchor (the service whose clock row was clicked).
    const anchor = await revertOneService(service, targetRevisionRaw, identity, requestId);

    // 2. Resolve + revert the sibling. Time-correlate to the anchor deploy when
    //    we have its timestamp; otherwise step the sibling back one revision.
    let siblingOutcome: RevertOutcome;
    try {
      const sibRevs = await listRevisions(sibling, 100);
      const sorted = sibRevs.slice().sort((a, b) =>
        Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'));
      const active = sorted.find(r => r.isActive) || null;
      const notActive = (shortName: string) => !active || active.shortName !== shortName;

      let chosen = undefined as (typeof sorted)[number] | undefined;
      const anchorMs = anchorCreatedAt ? Date.parse(anchorCreatedAt) : NaN;
      if (!Number.isNaN(anchorMs)) {
        chosen = sorted.find(r => {
          const t = Date.parse(r.createdAt || '0');
          return !Number.isNaN(t) && t <= anchorMs && notActive(r.shortName);
        });
      }
      if (!chosen) {
        chosen = sorted.find(r => notActive(r.shortName)); // immediately-previous
      }

      if (!chosen) {
        siblingOutcome = {
          status: 'no_target', ok: false, service: sibling,
          detail: `${sibling} has no earlier revision to revert to.`,
        };
      } else if (active && chosen.shortName === active.shortName) {
        siblingOutcome = {
          status: 'already_active', ok: false, service: sibling,
          target_revision: chosen.shortName, target_commit: chosen.commitSha,
          detail: `${sibling} already serving ${chosen.shortName}`,
        };
      } else {
        siblingOutcome = await revertOneService(sibling, chosen.shortName, identity, requestId);
      }
    } catch (sibErr) {
      siblingOutcome = {
        status: 'resolve_failed', ok: false, service: sibling,
        detail: sibErr instanceof Error ? sibErr.message : 'unknown',
      };
    }

    // 3. Respond. backend/frontend convenience aliases + raw anchor/sibling.
    const backend = isBackendService(service) ? anchor : siblingOutcome;
    const frontend = isBackendService(service) ? siblingOutcome : anchor;
    const siblingSettled = siblingOutcome.ok || siblingOutcome.status === 'already_active';

    return res.status(anchor.ok ? 200 : revertOutcomeToHttp(anchor)).json({
      ok: anchor.ok,
      both_ok: anchor.ok && siblingSettled,
      backend,
      frontend,
      anchor,
      sibling: siblingOutcome,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] /revert-both failed: ${errorMessage}`);
    return res.status(500).json({ ok: false, error: 'internal_error', detail: errorMessage });
  }
});

router.post('/revert', requireAdminAuth, async (req: Request, res: Response) => {
  const requestId = randomUUID();
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const service = (req.body?.service || '').toString().trim();
  const targetRevisionRaw = (req.body?.target_revision || '').toString().trim();

  if (service !== 'gateway' && service !== 'gateway-staging') {
    return res.status(400).json({ ok: false, error: 'invalid_service', detail: 'service must be "gateway" or "gateway-staging"' });
  }
  if (!targetRevisionRaw) {
    return res.status(400).json({ ok: false, error: 'missing_target_revision' });
  }
  const targetShort = shortRevisionName(targetRevisionRaw);

  try {
    // Step 3 + 4: validate revision exists, isn't currently active, isn't expired.
    const revisions = await listRevisions(service, 100);
    const target = revisions.find(r => r.shortName === targetShort);
    if (!target) {
      return res.status(404).json({ ok: false, error: 'target_revision_not_found', detail: `revision ${targetShort} not found in last 100 revisions of ${service}` });
    }
    if (target.isActive) {
      return res.status(409).json({ ok: false, error: 'target_already_active' });
    }
    const ageMs = target.createdAt ? Date.now() - Date.parse(target.createdAt) : 0;
    if (ageMs > REVERT_AGE_LIMIT_MS) {
      return res.status(409).json({ ok: false, error: 'target_revision_too_old', detail: `revision ${targetShort} is ${Math.floor(ageMs / (24 * 60 * 60 * 1000))} days old; >90d. Re-deploy that commit instead.` });
    }

    // Step 5: traffic shift.
    const result = await updateTrafficToRevision(service, targetShort);
    if (!result.ok) {
      const isProd = service === 'gateway';
      await emitOasisEvent({
        vtid: 'BOOTSTRAP-REVERT',
        type: isProd ? 'production.publish.failed' : 'staging.deploy.failed',
        source: 'gateway-operator',
        status: 'error',
        message: `revert: ${service} → ${targetShort} traffic-shift failed (${result.error})`,
        actor_id: identity.user_id,
        actor_role: 'admin',
        surface: 'command-hub',
        payload: { request_id: requestId, service, target_revision: targetShort, error: result.error },
      });
      return res.status(502).json({ ok: false, error: 'traffic_shift_failed', detail: result.error });
    }

    // Step 6: record rollback row.
    ACTIVE_REV_CACHE.delete(service); // invalidate cache so next /deployments shows new active
    const swvId = await getNextSWV();
    await insertSoftwareVersion({
      swv_id: swvId,
      service,
      git_commit: target.commitSha || '(unknown)',
      deploy_type: 'rollback',
      initiator: 'user',
      status: 'success',
      environment: service === 'gateway' ? 'production' : 'staging',
      cloud_run_revision: targetShort,
      source_revision: null,
      initiator_id: identity.user_id,
    });

    // Step 7: terminal event (topic depends on which stack).
    const topic = service === 'gateway' ? 'production.revert.completed' : 'staging.revert.completed';
    await emitOasisEvent({
      vtid: 'BOOTSTRAP-REVERT',
      type: topic,
      source: 'gateway-operator',
      status: 'success',
      message: `revert: ${service} now serving ${targetShort}`,
      actor_id: identity.user_id,
      actor_role: 'admin',
      surface: 'command-hub',
      payload: {
        request_id: requestId,
        service,
        target_revision: targetShort,
        target_commit: target.commitSha,
        operation_name: result.operationName,
        swv_id: swvId,
      },
    });

    return res.status(200).json({
      ok: true,
      service,
      target_revision: targetShort,
      target_commit: target.commitSha,
      operation_name: result.operationName,
      swv_id: swvId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] /revert failed: ${errorMessage}`);
    return res.status(500).json({ ok: false, error: 'internal_error', detail: errorMessage });
  }
});

// ====================================================================
// Voice-first canary endpoints (post-Phase 0 UX).  See docs/STAGING.md
// §"Canary publish" for the operator playbook.
//
//   POST /api/v1/operator/promote     — shift the canary revision to 100%
//   POST /api/v1/operator/abort-canary — drop the canary back to 0%, restore
//                                         the prior revision to 100%
//
// Both are admin-only.  Both inspect the current Cloud Run traffic split to
// resolve which revision is the canary (the one with the lower non-zero
// percent) vs the stable revision (the one with the higher percent).
// ====================================================================

router.post('/promote', requireAdminAuth, async (req: Request, res: Response) => {
  const requestId = randomUUID();
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const service = (req.body?.service || 'gateway').toString().trim();
  if (service !== 'gateway' && service !== 'gateway-staging') {
    return res.status(400).json({ ok: false, error: 'invalid_service' });
  }

  try {
    const summary = await describeService(service);
    if (summary.trafficSplit.length < 2) {
      return res.status(409).json({
        ok: false,
        error: 'no_canary_active',
        detail: `No canary split detected on ${service}. Traffic is already on a single revision.`,
      });
    }
    // Canary = lowest non-zero percent. Stable = highest.
    const sorted = [...summary.trafficSplit].sort((a, b) => a.percent - b.percent);
    const canary = sorted[0];
    const canaryShort = shortRevisionName(canary.revision);

    const result = await updateTrafficToRevision(service, canaryShort);
    if (!result.ok) {
      await emitOasisEvent({
        vtid: 'BOOTSTRAP-PROMOTE',
        type: 'production.publish.failed',
        source: 'gateway-operator',
        status: 'error',
        message: `promote: traffic-shift failed (${result.error})`,
        actor_id: identity.user_id,
        actor_role: 'admin',
        surface: 'command-hub',
        payload: { request_id: requestId, service, canary_revision: canaryShort, error: result.error },
      });
      return res.status(502).json({ ok: false, error: 'traffic_shift_failed', detail: result.error });
    }

    ACTIVE_REV_CACHE.delete(service);
    const swvId = await getNextSWV();
    await insertSoftwareVersion({
      swv_id: swvId,
      service,
      git_commit: '(canary-promote)',
      deploy_type: 'normal',
      initiator: 'user',
      status: 'success',
      environment: service === 'gateway' ? 'production' : 'staging',
      cloud_run_revision: canaryShort,
      source_revision: null,
      initiator_id: identity.user_id,
    });

    await emitOasisEvent({
      vtid: 'BOOTSTRAP-PROMOTE',
      type: 'production.canary.promoted',
      source: 'gateway-operator',
      status: 'success',
      message: `canary promoted: ${service} now serving ${canaryShort} at 100%`,
      actor_id: identity.user_id,
      actor_role: 'admin',
      surface: 'command-hub',
      payload: {
        request_id: requestId,
        service,
        canary_revision: canaryShort,
        previous_split: summary.trafficSplit,
        operation_name: result.operationName,
        swv_id: swvId,
      },
    });

    return res.status(200).json({
      ok: true,
      service,
      promoted_revision: canaryShort,
      operation_name: result.operationName,
      swv_id: swvId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] /promote failed: ${errorMessage}`);
    return res.status(500).json({ ok: false, error: 'internal_error', detail: errorMessage });
  }
});

router.post('/abort-canary', requireAdminAuth, async (req: Request, res: Response) => {
  const requestId = randomUUID();
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const service = (req.body?.service || 'gateway').toString().trim();
  if (service !== 'gateway' && service !== 'gateway-staging') {
    return res.status(400).json({ ok: false, error: 'invalid_service' });
  }

  try {
    const summary = await describeService(service);
    if (summary.trafficSplit.length < 2) {
      return res.status(409).json({
        ok: false,
        error: 'no_canary_active',
        detail: `No canary split detected on ${service}.`,
      });
    }
    // Stable = highest percent. Send that to 100%, dropping the canary.
    const sorted = [...summary.trafficSplit].sort((a, b) => b.percent - a.percent);
    const stable = sorted[0];
    const canary = sorted[sorted.length - 1];
    const stableShort = shortRevisionName(stable.revision);
    const canaryShort = shortRevisionName(canary.revision);

    const result = await updateTrafficToRevision(service, stableShort);
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: 'traffic_shift_failed', detail: result.error });
    }

    ACTIVE_REV_CACHE.delete(service);
    const swvId = await getNextSWV();
    await insertSoftwareVersion({
      swv_id: swvId,
      service,
      git_commit: '(canary-abort)',
      deploy_type: 'rollback',
      initiator: 'user',
      status: 'success',
      environment: service === 'gateway' ? 'production' : 'staging',
      cloud_run_revision: stableShort,
      source_revision: canaryShort,
      initiator_id: identity.user_id,
    });

    await emitOasisEvent({
      vtid: 'BOOTSTRAP-ABORT',
      type: 'production.canary.aborted',
      source: 'gateway-operator',
      status: 'warning',
      message: `canary discarded: ${service} restored to ${stableShort} (canary ${canaryShort} idled)`,
      actor_id: identity.user_id,
      actor_role: 'admin',
      surface: 'command-hub',
      payload: {
        request_id: requestId,
        service,
        canary_revision: canaryShort,
        stable_revision: stableShort,
        previous_split: summary.trafficSplit,
        operation_name: result.operationName,
        swv_id: swvId,
      },
    });

    return res.status(200).json({
      ok: true,
      service,
      stable_revision: stableShort,
      canary_revision_idled: canaryShort,
      operation_name: result.operationName,
      swv_id: swvId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] /abort-canary failed: ${errorMessage}`);
    return res.status(500).json({ ok: false, error: 'internal_error', detail: errorMessage });
  }
});

export default router;
