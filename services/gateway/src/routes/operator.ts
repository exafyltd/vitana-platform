/**
 * VTID-0509: Operator Console API Routes
 * Implements: chat, heartbeat, history, upload, session endpoints
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { processMessage } from '../services/ai-orchestrator';
import { ingestOperatorEvent, getTasksSummary, getRecentEvents, getCicdHealth, getOperatorHistory } from '../services/operator-service';

const router = Router();

// --- Schemas ---

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

// --- Routes ---

/**
 * POST /operator/chat - DEV-AICOR-0027 Operator Chat
 * Logs request/response events and calls AI orchestrator
 */
router.post('/operator/chat', async (req: Request, res: Response) => {
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
 * GET /operator/health - Simple health check
 */
router.get('/operator/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'operator-api',
    timestamp: new Date().toISOString(),
    status: 'healthy'
  });
});

/**
 * GET /operator/heartbeat - Heartbeat snapshot
 * Aggregates task status, recent events, and CICD health
 */
router.get('/operator/heartbeat', async (_req: Request, res: Response) => {
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
      status: 'ok',
      timestamp: new Date().toISOString(),
      vtid: 'VTID-0509',
      tasks: tasksSummary,
      events: recentEvents,
      cicd: cicdHealth
    };

    console.log('[Operator Heartbeat] Snapshot generated:', {
      tasks_total: snapshot.tasks.total,
      events_count: snapshot.events.length
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
 * GET /operator/history - Operator history
 * Returns filtered events from OASIS
 */
router.get('/operator/history', async (req: Request, res: Response) => {
  console.log('[Operator History] Request received');

  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const history = await getOperatorHistory(limit);

    console.log(`[Operator History] Returning ${history.length} events`);

    return res.status(200).json({
      ok: true,
      count: history.length,
      data: history
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
 * POST /operator/heartbeat/session - Start/stop heartbeat session
 */
router.post('/operator/heartbeat/session', async (req: Request, res: Response) => {
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
 * POST /operator/upload - File upload
 * Creates OASIS file reference and logs upload event
 */
router.post('/operator/upload', async (req: Request, res: Response) => {
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

export default router;
