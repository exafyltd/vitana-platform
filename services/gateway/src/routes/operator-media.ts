/**
 * VTID-05067: images for the Command Hub Operator Console (paste / drop / paperclip).
 * Mounted at /api/v1/operator/media. exafy_admin only (requireAdminAuth); an image is
 * readable by the admin who uploaded it and nobody else (user id from the verified
 * identity only).
 *
 *   POST /?thread_id=<uuid>   raw image body (Content-Type image/png|jpeg|webp|gif, ≤ 5 MB,
 *                             type checked against the magic bytes)
 *                             → 201 { ok, media_id, oasis_ref, url, mime_type, size_bytes }
 *                             `url` is a 1-hour signed URL (private bucket `operator-media`)
 *   GET  /:id                 the owner's image re-signed → { ok, media_id, url, mime_type }
 *
 * A message carries at most 4 images; that is checked where the run or chat turn starts
 * (routes/operator-kiro-runs.ts, routes/operator.ts), not here.
 */
import express, { Router, Response } from 'express';
import { z } from 'zod';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  OPERATOR_MEDIA_LIMITS, OPERATOR_MEDIA_TYPES, storeOperatorMedia, getOperatorMedia, signOperatorMedia, operatorMediaOasisRef,
} from '../services/operator-media';
import { kiroThreadOwnership } from '../services/kiro/kiro-runs';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();
const uuid = z.string().uuid();

// Raw bytes for the four image types only; anything else leaves req.body empty and is refused below.
const rawImage = express.raw({ type: [...OPERATOR_MEDIA_TYPES], limit: OPERATOR_MEDIA_LIMITS.maxBytes });

function caller(req: AuthenticatedRequest): string | null {
  return req.identity?.user_id ?? null;
}

router.post('/', requireAdminAuth, (req: AuthenticatedRequest, res: Response, next) => {
  rawImage(req, res, (err?: unknown) => {
    if (err) {
      const tooLarge = (err as { type?: string }).type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? 'too_large' : 'INVALID_BODY' });
      return;
    }
    next();
  });
}, async (req: AuthenticatedRequest, res: Response) => {
  const userId = caller(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const threadId = uuid.safeParse(req.query.thread_id);
  if (!threadId.success) return res.status(400).json({ ok: false, error: 'INVALID_THREAD_ID' });
  const declared = String(req.header('content-type') || '');
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!Buffer.isBuffer(req.body)) {
    return res.status(415).json({ ok: false, error: 'unsupported_type', allowed: OPERATOR_MEDIA_TYPES });
  }

  // The thread, when it exists, must be the caller's own.
  const own = await kiroThreadOwnership(threadId.data);
  if (own.owner && own.owner !== userId) return res.status(403).json({ ok: false, error: 'forbidden' });

  const stored = await storeOperatorMedia({ userId, threadId: threadId.data, bytes, declaredType: declared });
  if (!stored.ok) return res.status(stored.status).json({ ok: false, error: stored.error });

  await emitOasisEvent({
    vtid: 'VTID-05067',
    type: 'operator.media.uploaded',
    source: 'gateway-operator',
    status: 'info',
    message: 'Operator Console image stored',
    actor_id: userId,
    actor_role: 'admin',
    surface: 'command-hub',
    payload: { media_id: stored.media.id, thread_id: threadId.data, mime_type: stored.media.mime_type, size_bytes: stored.media.size_bytes },
  }).catch(() => undefined);

  return res.status(201).json({
    ok: true,
    media_id: stored.media.id,
    oasis_ref: stored.oasis_ref,
    url: stored.url,
    mime_type: stored.media.mime_type,
    size_bytes: stored.media.size_bytes,
  });
});

router.get('/:id', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ ok: false, error: 'INVALID_MEDIA_ID' });
  const userId = caller(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const row = await getOperatorMedia(id.data);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.user_id !== userId) return res.status(403).json({ ok: false, error: 'forbidden' });
  const url = await signOperatorMedia(row.object_path);
  if (!url) return res.status(503).json({ ok: false, error: 'storage_unavailable' });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, media_id: row.id, oasis_ref: operatorMediaOasisRef(row.id), url, mime_type: row.mime_type, thread_id: row.thread_id });
});

export default router;
