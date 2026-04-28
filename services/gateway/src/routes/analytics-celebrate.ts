/**
 * Analytics — Celebration ingestion
 *
 * Mounted at: /api/v1/analytics
 *
 * Lightweight POST endpoint for the frontend's `celebrate()` funnel
 * (Vitana Index lift, tier-up, pillar-threshold, streak, at-risk). Writes
 * one row to `analytics_celebrate_events` per call; throttled events are
 * persisted with `throttled=true` so we can audit suppression rates.
 *
 * Auth: optional. The frontend usually posts authenticated, but anonymous
 * sessions are accepted (user_id stays null) so the engagement loop is
 * never blocked by auth state.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';

const router = Router();
const LOG_PREFIX = '[Analytics:Celebrate]';

const CelebrateEventSchema = z.object({
  kind: z.enum(['index-lift', 'tier-up', 'pillar-threshold', 'streak', 'at-risk']),
  magnitude: z.number().optional(),
  source: z.string().max(64).optional(),
  throttled: z.boolean().optional().default(false),
  meta: z.record(z.any()).optional(),
});

router.post('/celebrate', async (req: Request, res: Response) => {
  let body: z.infer<typeof CelebrateEventSchema>;
  try {
    body = CelebrateEventSchema.parse(req.body ?? {});
  } catch (err: any) {
    return res.status(400).json({ ok: false, error: err?.message ?? 'invalid payload' });
  }

  const supa = getSupabase();
  if (!supa) {
    // Fire-and-forget — analytics must never block the user.
    console.warn(`${LOG_PREFIX} supabase not configured; dropping event`, body.kind);
    return res.status(202).json({ ok: true, persisted: false });
  }

  // Best-effort user / tenant attribution. The frontend POSTs include the
  // Supabase access token in cookies/Authorization; the gateway middleware
  // already exposes `req.user` for authenticated calls. Anonymous sessions
  // pass through — analytics for logged-out users still get aggregated.
  const userId =
    (req as any).user?.id ??
    (req as any).userId ??
    null;
  const tenantId =
    (req as any).tenantId ??
    (req as any).tenant?.id ??
    null;

  try {
    const { error } = await supa.from('analytics_celebrate_events').insert({
      user_id: userId,
      tenant_id: tenantId,
      kind: body.kind,
      magnitude: body.magnitude ?? null,
      source: body.source ?? null,
      throttled: body.throttled ?? false,
      meta: body.meta ?? {},
    });
    if (error) {
      console.warn(`${LOG_PREFIX} insert failed:`, error.message);
      return res.status(202).json({ ok: true, persisted: false, error: error.message });
    }
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} insert threw:`, err?.message);
    return res.status(202).json({ ok: true, persisted: false });
  }

  return res.status(202).json({ ok: true, persisted: true });
});

export default router;
export { router as analyticsCelebrateRouter };
