/**
 * VTID-05070 — Kiro's staging screenshots (Phase 5 of the Kiro runs plan).
 * Mounted at /api/v1/operator/kiro/media.
 *
 *   GET  /quota                   the current run's screenshot budget       (Kiro session pass)
 *   POST /   (image/png, ≤ 5 MB)  store one screenshot, append `kiro.image` (Kiro session pass)
 *        ?viewport=desktop|mobile&page_url=<https url>
 *   GET  /:threadId/:mediaId      a fresh 1 h signed URL, owner only        (exafy_admin JWT)
 *
 * Callers of the first two: the kiro-browser sidecar of the kiro-runner task, with the Kiro
 * session's pass (the same pass the `vitana` read tools use, kiro-mcp-token.ts) — user and
 * thread come from the signed pass, never from the request. The image is checked by its
 * PNG magic bytes, stored privately in `operator-media` at kiro/<user>/<thread>/<uuid>.png
 * (kiro-media-store.ts) and appended to the thread's running Kiro run as a `kiro.image`
 * event (kiro-runs.ts), so the console shows it in the step list and replays it after a
 * reload. At most KIRO_RUN_SCREENSHOT_LIMIT (10) per run: the 11th answers 429
 * "screenshot limit reached for this run".
 *
 * Off (404) unless KIRO_MCP_ENABLED=true, like the MCP route. OASIS
 * `operator.kiro.screenshot_stored` carries ids, viewport and size — never the URL or image.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAdminAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { checkKiroMcpCaller } from './operator-kiro-mcp';
import { emitOasisEvent } from '../services/oasis-event-service';
import { activeKiroRunFor, appendKiroRunEvent, countKiroRunEvents, KIRO_RUN_SCREENSHOT_LIMIT } from '../services/kiro/kiro-runs';
import { KIRO_MEDIA_MAX_BYTES, KIRO_MEDIA_URL_TTL_S, kiroMediaPath, pngDimensions, putKiroScreenshot, signKiroMedia } from '../services/kiro/kiro-media-store';

const router = Router();

export const KIRO_SCREENSHOT_LIMIT_ERROR = 'screenshot limit reached for this run';
const VIEWPORTS = new Set(['desktop', 'mobile']);

async function caller(req: Request, res: Response) {
  const c = await checkKiroMcpCaller(req.headers.authorization);
  if (!c.ok) { res.status(c.status).json({ ok: false, error: c.error }); return null; }
  return c;
}

/** The run a screenshot belongs to and how many it already has. */
async function budget(threadId: string, userId: string): Promise<{ runId: string; used: number } | { error: string; status: number }> {
  const run = await activeKiroRunFor(threadId, userId);
  if (!run) return { status: 409, error: 'no running Kiro run for this thread' };
  const used = await countKiroRunEvents(run.id, 'kiro.image');
  if (used === null) return { status: 503, error: 'store_unavailable' };
  return { runId: run.id, used };
}

router.get('/quota', async (req: Request, res: Response) => {
  const c = await caller(req, res);
  if (!c) return;
  const b = await budget(c.threadId, c.userId);
  if ('error' in b) return res.status(b.status).json({ ok: false, error: b.error });
  return res.json({ ok: true, run_id: b.runId, used: b.used, limit: KIRO_RUN_SCREENSHOT_LIMIT, remaining: Math.max(0, KIRO_RUN_SCREENSHOT_LIMIT - b.used) });
});

router.post('/', express.raw({ type: 'image/png', limit: KIRO_MEDIA_MAX_BYTES }), async (req: Request, res: Response) => {
  const c = await caller(req, res);
  if (!c) return;
  if (!req.is('image/png') || !Buffer.isBuffer(req.body)) return res.status(415).json({ ok: false, error: 'image/png body required' });
  const png = req.body as Buffer;
  const dims = pngDimensions(png);
  if (!dims) return res.status(415).json({ ok: false, error: 'not a PNG' });
  const viewport = String(req.query.viewport ?? '');
  if (!VIEWPORTS.has(viewport)) return res.status(400).json({ ok: false, error: 'viewport must be desktop or mobile' });
  const pageUrl = String(req.query.page_url ?? '');
  if (pageUrl.length > 2048 || !/^https?:\/\//.test(pageUrl)) return res.status(400).json({ ok: false, error: 'page_url must be the page URL' });

  const b = await budget(c.threadId, c.userId);
  if ('error' in b) return res.status(b.status).json({ ok: false, error: b.error });
  if (b.used >= KIRO_RUN_SCREENSHOT_LIMIT) return res.status(429).json({ ok: false, error: KIRO_SCREENSHOT_LIMIT_ERROR });

  const stored = await putKiroScreenshot(c.userId, c.threadId, png);
  if (!stored.ok) return res.status(502).json({ ok: false, error: `storage failed: ${stored.error}` });
  const url = await signKiroMedia(stored.path);
  const payload = {
    media_id: stored.mediaId,
    viewport,
    width: dims.width,
    height: dims.height,
    page_url: pageUrl,
    url,
    url_expires_at: url ? new Date(Date.now() + KIRO_MEDIA_URL_TTL_S * 1000).toISOString() : null,
  };
  const appended = await appendKiroRunEvent(b.runId, 'kiro.image', payload);
  if (!appended.ok) console.error(`[VTID-05070] kiro.image event not appended to run ${b.runId}: ${appended.error}`);
  await emitOasisEvent({
    vtid: 'VTID-05070',
    type: 'operator.kiro.screenshot_stored',
    source: 'gateway-operator',
    status: 'info',
    message: `Kiro stored a ${viewport} screenshot`,
    actor_id: c.userId,
    actor_role: 'admin',
    surface: 'command-hub',
    payload: { run_id: b.runId, thread_id: c.threadId, media_id: stored.mediaId, viewport, width: dims.width, height: dims.height, bytes: png.length, event: appended.ok ? appended.via : 'failed' },
  }).catch(() => undefined);
  return res.status(201).json({ ok: true, media_id: stored.mediaId, run_id: b.runId, url, width: dims.width, height: dims.height, event_appended: appended.ok });
});

/** The console: a fresh signed URL for one of the caller's own screenshots (a replayed run's URL may have expired). */
router.get('/:threadId/:mediaId', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  // The path is built from the caller's own id: another user's screenshot has no path to reach.
  const path = kiroMediaPath(userId, req.params.threadId, req.params.mediaId);
  if (!path) return res.status(400).json({ ok: false, error: 'INVALID_MEDIA_ID' });
  const url = await signKiroMedia(path);
  if (!url) return res.status(404).json({ ok: false, error: 'not_found' });
  return res.json({ ok: true, url, expires_in: KIRO_MEDIA_URL_TTL_S });
});

// A body over 5 MB (or a broken one) answers JSON, not the default HTML error page.
router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'image larger than 5 MB' });
  return res.status(400).json({ ok: false, error: 'invalid body' });
});

export default router;
