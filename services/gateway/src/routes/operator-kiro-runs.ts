/**
 * VTID-05065: Kiro runs — one server-side record per Kiro turn (services/kiro/kiro-runs.ts).
 * Mounted at /api/v1/operator/kiro/runs. exafy_admin only; a run is visible to, and
 * cancellable by, the user who started it (user id from the verified identity only).
 *
 *   POST /                       { thread_id, message, engine?, attachments? } → 202 { run_id, status }
 *                                (VTID-05067: attachments = up to 4 of the caller's own
 *                                operator_media ids; 400 too_many_attachments / invalid_attachment)
 *                                (running, or queued behind the thread's current run;
 *                                409 queue_full when 2 are already queued)
 *   GET  /?thread_id=            the caller's latest 20 runs of that thread
 *   GET  /:id                    one run
 *   GET  /:id/stream?after_seq=  SSE: the stored events after after_seq (or Last-Event-ID),
 *                                then live; ends after the terminal status event.
 *                                A dropped stream (or an expired JWT) reconnects with a
 *                                fresh token and the last seen seq — nothing lost, nothing twice.
 *   POST /:id/cancel             queued → cancelled; running → Kiro's own cancel
 *
 * Approval cards are answered on the existing POST /api/v1/operator/kiro/permissions/:requestId.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  startKiroRun, getKiroRun, listKiroRuns, cancelKiroRun, followKiroRun, kiroThreadOwnership, type KiroRunEvent,
} from '../services/kiro/kiro-runs';
import { ensureOperatorThread, isOperatorThreadsEnabled } from '../services/operator-threads';
import { ingestChatMessageEvent } from '../services/operator-service';
import { loadOperatorMediaForUser, operatorMediaOasisRef, OPERATOR_MEDIA_LIMITS } from '../services/operator-media';

const router = Router();

export const KIRO_RUN_MESSAGE_MAX_CHARS = 50_000;
export const KIRO_RUN_STREAM_HEARTBEAT_MS = 15_000;

const uuid = z.string().uuid();
const StartBody = z.object({
  thread_id: uuid,
  message: z.string().trim().min(1).max(KIRO_RUN_MESSAGE_MAX_CHARS),
  engine: z.literal('kiro').optional(),
  // VTID-05067: images pasted / dropped into the composer (POST /api/v1/operator/media first).
  attachments: z.array(uuid).optional().default([]),
});

function caller(req: AuthenticatedRequest): string | null {
  return req.identity?.user_id ?? null;
}

router.post('/', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = StartBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_BODY' });
  const userId = caller(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const { thread_id: threadId, message, attachments } = parsed.data;
  if (new Set(attachments).size > OPERATOR_MEDIA_LIMITS.maxPerMessage) {
    return res.status(400).json({ ok: false, error: 'too_many_attachments', max: OPERATOR_MEDIA_LIMITS.maxPerMessage });
  }

  // The thread must be the caller's own Kiro thread (or a new one).
  const own = await kiroThreadOwnership(threadId);
  if ((own.owner && own.owner !== userId) || own.otherRunOwners.some((u) => u !== userId)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (own.engine && own.engine !== 'kiro') return res.status(409).json({ ok: false, error: 'thread_not_kiro' });
  // Every image must exist and be the caller's own.
  const media = await loadOperatorMediaForUser(attachments, userId);
  if (!media.ok) return res.status(400).json({ ok: false, error: media.error === 'too_many' ? 'too_many_attachments' : 'invalid_attachment' });

  // impact-allow-no-oasis: the run itself emits operator.kiro.run_started/run_finished
  // (kiro-runs.ts) and the turn records the chat events, exactly like POST /chat.
  if (isOperatorThreadsEnabled()) {
    await ensureOperatorThread({ threadId, identity: { user_id: userId, role: 'admin' }, userText: message, engine: 'kiro' });
  }
  const requestId = randomUUID();
  await ingestChatMessageEvent({ threadId, role: 'operator', mode: 'chat', message, attachmentsCount: media.media.length, metadata: { channel: 'kiro_run', request_id: requestId } });

  const started = await startKiroRun({
    threadId,
    userId,
    message,
    turn: {
      requestId, createdAt: new Date().toISOString(), mode: 'chat',
      attachments: media.media.map((m) => ({ oasis_ref: operatorMediaOasisRef(m.id), kind: 'image' })),
      media: media.media.map((m) => ({ media_id: m.id, mime_type: m.mime_type })),
    },
    requirePersisted: true,
  });
  if (!started.ok) {
    return res.status(started.error === 'queue_full' ? 409 : 503).json({ ok: false, error: started.error });
  }
  return res.status(202).json({ ok: true, run_id: started.run_id, status: started.status });
});

router.get('/', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const threadId = uuid.safeParse(req.query.thread_id);
  if (!threadId.success) return res.status(400).json({ ok: false, error: 'INVALID_THREAD_ID' });
  const userId = caller(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const runs = await listKiroRuns(threadId.data, userId);
  if (!runs) return res.status(503).json({ ok: false, error: 'store_unavailable' });
  return res.json({ ok: true, runs });
});

/** The run, when it exists and belongs to the caller; otherwise the response is already sent. */
async function ownRun(req: AuthenticatedRequest, res: Response) {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ ok: false, error: 'INVALID_RUN_ID' }); return null; }
  const run = await getKiroRun(id.data);
  if (!run) { res.status(404).json({ ok: false, error: 'not_found' }); return null; }
  if (!caller(req) || run.user_id !== caller(req)) { res.status(403).json({ ok: false, error: 'forbidden' }); return null; }
  return run;
}

router.get('/:id', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const run = await ownRun(req, res);
  if (!run) return;
  return res.json({ ok: true, run });
});

router.get('/:id/stream', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const raw = req.query.after_seq ?? req.header('last-event-id') ?? '0';
  const afterSeq = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(afterSeq) || afterSeq < 0 || String(afterSeq) !== String(raw).trim()) {
    return res.status(400).json({ ok: false, error: 'INVALID_AFTER_SEQ' });
  }
  const run = await ownRun(req, res);
  if (!run) return;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Same client-gone detection as /chat/stream: on the response, not the request.
  let closed = false;
  res.on('close', () => { if (!res.writableEnded) closed = true; });
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, KIRO_RUN_STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();

  const write = (ev: KiroRunEvent): void => {
    if (closed || res.writableEnded) return;
    res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify({ seq: ev.seq, ...ev.payload })}\n\n`);
  };
  try {
    await followKiroRun(run.id, afterSeq, write, () => closed || res.writableEnded);
  } catch (err) {
    if (!closed && !res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: 'stream_failed', details: err instanceof Error ? err.message : String(err) })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

router.post('/:id/cancel', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ ok: false, error: 'INVALID_RUN_ID' });
  // impact-allow-no-oasis: a cancelled run emits operator.kiro.run_finished (kiro-runs.ts).
  const r = await cancelKiroRun(id.data, caller(req));
  if (!r.ok) {
    const status = r.error === 'forbidden' ? 403 : r.error === 'not_found' ? 404 : 409;
    return res.status(status).json({ ok: false, error: r.error });
  }
  return res.json({ ok: true, status: r.status });
});

export default router;
