/**
 * RUM beacon receiver — Phase 1 W1 (VTID-03177 PROFILE).
 *
 * Accepts small JSON beacons from the vitana-v1 frontend (see
 * `vitana-v1/src/lib/rum.ts`) and translates each into a
 * `screen.latency.measured` OASIS event. The beacon is intentionally a thin
 * pipe — no per-metric business logic, no aggregation. Dashboards do that
 * downstream.
 *
 * Gated by `FEATURE_LATENCY_TELEMETRY_ENV` so flipping the flag off drops
 * traffic at the edge.
 *
 * Beacon shape (matches `RumBeacon` in vitana-v1):
 *   {
 *     "screen": "/community/feed",
 *     "metric": "LCP" | "TTFB" | "CLS" | "FCP" | "INP",
 *     "value":   1234.5,           // number, units defined per metric (ms or unitless)
 *     "rating":  "good" | "needs-improvement" | "poor",
 *     "session": "anonymous-uuid",
 *     "captured_at": "2026-05-28T12:34:56.789Z",
 *     "user_agent": "Mozilla/...",
 *     "ts_origin_ms": 1748434496789
 *   }
 *
 * Hard limits: body size <= 4 KiB, single event per beacon (no batching in
 * W1 — keep the receiver dumb; batching is a W2 enhancement if volume needs
 * it).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { emitOasisEvent } from '../services/oasis-event-service';
import { isFeatureLive } from '../services/feature-flags';

const FEATURE_NAME = 'LATENCY_TELEMETRY';
const MAX_BODY_BYTES = 4 * 1024;

const BeaconSchema = z.object({
  screen: z.string().min(1).max(256),
  metric: z.enum(['LCP', 'TTFB', 'CLS', 'FCP', 'INP']),
  value: z.number().finite(),
  rating: z.enum(['good', 'needs-improvement', 'poor']).optional(),
  session: z.string().min(1).max(128),
  captured_at: z.string().min(20).max(40),
  user_agent: z.string().max(512).optional(),
  ts_origin_ms: z.number().int().nonnegative().optional(),
  // Device split (vitana-v1 RUM W2): lets the rollup compare iOS vs Android
  // vs desktop, and Appilix WebView vs plain browser, without re-parsing UAs.
  platform: z.enum(['ios', 'android', 'desktop', 'other']).optional(),
  webview: z.boolean().optional(),
});

export type RumBeacon = z.infer<typeof BeaconSchema>;

const router = Router();

router.post('/beacon', async (req: Request, res: Response) => {
  if (!isFeatureLive(FEATURE_NAME)) {
    // Silently 204 when telemetry is off — frontends don't need to know.
    return res.status(204).end();
  }

  const raw = req.body;
  if (raw && typeof raw === 'object' && JSON.stringify(raw).length > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: 'beacon_too_large' });
  }

  const parse = BeaconSchema.safeParse(raw);
  if (!parse.success) {
    return res.status(400).json({ ok: false, error: 'invalid_beacon', issues: parse.error.issues });
  }
  const beacon = parse.data;

  try {
    await emitOasisEvent({
      vtid: 'VTID-03177',
      type: 'screen.latency.measured',
      source: 'gateway/rum-beacon',
      status: 'success',
      message: `${beacon.metric} ${beacon.value.toFixed(1)} on ${beacon.screen}`,
      payload: {
        screen: beacon.screen,
        metric: beacon.metric,
        value: beacon.value,
        rating: beacon.rating,
        session: beacon.session,
        captured_at: beacon.captured_at,
        user_agent: beacon.user_agent,
        ts_origin_ms: beacon.ts_origin_ms,
        platform: beacon.platform,
        webview: beacon.webview,
      },
    });
    return res.status(204).end();
  } catch (err) {
    // Beacon failures must never block the frontend; return 204 and log.
    console.error('[rum-beacon] emit failed:', err);
    return res.status(204).end();
  }
});

export { router as rumBeaconRouter };
