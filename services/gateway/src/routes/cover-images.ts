/**
 * VTID-02806h — Cover-image processing endpoints.
 *
 *   POST /api/v1/cover-images/outpaint
 *     Body:  { source_path: string, target_path: string }
 *     Auth:  requireAuth + requireTenant
 *     200 → { ok: true, url, path, method: 'outpaint' }
 *     400 → invalid_path | unsupported_mime | source_too_large
 *     403 → forbidden (caller doesn't own the path)
 *     404 → source_not_found
 *     422 → unsafe_prompt
 *     500 → provider_failed | storage_failed
 *
 * The browser uploads its narrower-than-16:9 source to
 * `staging/<uid>/...` (allowed by storage RLS), then calls this
 * endpoint to extend it to 16:9 via Vertex Imagen and write the
 * result to the final `user-universal/<uid>/...` or
 * `user-library/<uid>/...` path.
 */

import { Router, type Request, type Response } from 'express';
import {
  requireAuth,
  requireTenant,
  type AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  CoverOutpaintError,
  outpaintCoverImage,
} from '../services/cover-image-outpaint';

const router = Router();

router.post(
  '/outpaint',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response) => {
    const { identity } = req as AuthenticatedRequest;
    if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourcePath = typeof body.source_path === 'string' ? body.source_path : '';
    const targetPath = typeof body.target_path === 'string' ? body.target_path : '';
    if (!sourcePath || !targetPath) {
      return res
        .status(400)
        .json({ ok: false, error: 'bad_request', message: 'source_path and target_path required' });
    }

    try {
      const result = await outpaintCoverImage({
        sourcePath,
        targetPath,
        userId: identity.user_id,
      });
      return res.json({ ok: true, url: result.url, path: result.path, method: 'outpaint' });
    } catch (err) {
      if (err instanceof CoverOutpaintError) {
        const status =
          err.code === 'forbidden' ? 403
          : err.code === 'invalid_path' ? 400
          : err.code === 'source_not_found' ? 404
          : err.code === 'source_too_large' ? 413
          : err.code === 'unsupported_mime' ? 415
          : err.code === 'unsafe_prompt' ? 422
          : 500;
        return res.status(status).json({ ok: false, error: err.code, message: err.message });
      }
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error('[cover-images/outpaint] unexpected error:', err);
      return res.status(500).json({ ok: false, error: 'outpaint_failed', message: msg });
    }
  },
);

export default router;
