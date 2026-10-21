/**
 * VTID-05069: the live pipeline tree of a VTID for the Operator Console
 * (services/operator-runs/run-view.ts). Mounted at /api/v1/operator/runs.
 * exafy_admin only (requireAdminAuth, as every operator route). Read-only:
 * nothing here writes; Stop and Publish in the console call the EXISTING
 * cancel and PUBLISH routes.
 *
 *   GET /by-thread/:threadId   the VTIDs the thread works on (Kiro events with
 *                              its thread_id, VTIDs the assistant named in it;
 *                              newest 5) and their views — one GitHub search for
 *                              all of them. The caller's own thread only.
 *   GET /:vtid                 one view (?thread_id= adds that thread's Kiro runs)
 *   GET /:vtid/stream          SSE `view` frames: the view, then again only when it
 *                              changed (checked every 15 s while a node runs, 60 s
 *                              otherwise); ends 60 s after the run is terminal or
 *                              after 2 h — the console reconnects on focus.
 */
import { Router, Response } from 'express';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  buildRunView, buildThreadRuns, followRunView, RUN_VIEW_VTID_RE, RUN_VIEW_THREAD_RE, type RunView,
} from '../services/operator-runs/run-view';

const router = Router();

export const OPERATOR_RUNS_HEARTBEAT_MS = 15_000;

function threadParam(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true, value: null };
  return typeof raw === 'string' && RUN_VIEW_THREAD_RE.test(raw) ? { ok: true, value: raw } : { ok: false };
}

router.get('/by-thread/:threadId', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const threadId = req.params.threadId;
  if (!RUN_VIEW_THREAD_RE.test(threadId)) return res.status(400).json({ ok: false, error: 'INVALID_THREAD_ID' });
  const r = await buildThreadRuns(threadId, req.identity?.user_id ?? null);
  if (!r.ok) {
    const status = r.error === 'forbidden' ? 403 : r.error === 'invalid_thread' ? 400 : 503;
    return res.status(status).json({ ok: false, error: r.error });
  }
  return res.json(r);
});

router.get('/:vtid', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const vtid = req.params.vtid;
  if (!RUN_VIEW_VTID_RE.test(vtid)) return res.status(400).json({ ok: false, error: 'INVALID_VTID' });
  const thread = threadParam(req.query.thread_id);
  if (!thread.ok) return res.status(400).json({ ok: false, error: 'INVALID_THREAD_ID' });
  const r = await buildRunView(vtid, { threadId: thread.value });
  if (!r.ok) return res.status(400).json({ ok: false, error: 'INVALID_VTID' });
  return res.json({ ok: true, view: r.view });
});

router.get('/:vtid/stream', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const vtid = req.params.vtid;
  if (!RUN_VIEW_VTID_RE.test(vtid)) return res.status(400).json({ ok: false, error: 'INVALID_VTID' });
  const thread = threadParam(req.query.thread_id);
  if (!thread.ok) return res.status(400).json({ ok: false, error: 'INVALID_THREAD_ID' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  res.on('close', () => { if (!res.writableEnded) closed = true; });
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, OPERATOR_RUNS_HEARTBEAT_MS);
  heartbeat.unref?.();

  const send = (view: RunView): void => {
    if (closed || res.writableEnded) return;
    res.write(`event: view\ndata: ${JSON.stringify(view)}\n\n`);
  };
  try {
    const end = await followRunView(vtid, thread.value, send, () => closed || res.writableEnded);
    if (!closed && !res.writableEnded) res.write(`event: end\ndata: ${JSON.stringify({ reason: end })}\n\n`);
  } catch (err) {
    if (!closed && !res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: 'stream_failed', details: err instanceof Error ? err.message : String(err) })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

export default router;
