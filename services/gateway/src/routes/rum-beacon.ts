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
 *
 * VTID-05062: a second beacon kind, `{ "kind": "nav", ... }`, measures one
 * in-app navigation (SCREEN_READY ms + first-viewport images re-fetched on a
 * return visit). It has its own schema and becomes its own OASIS topic,
 * `screen.nav.measured`, so its integer image counts never mix with the
 * timing values that consumers of `screen.latency.measured` (e.g. the
 * routine-audits p75 rollup) aggregate. Metric beacons are untouched: any
 * body without `kind: 'nav'` takes the original path exactly as before.
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

// VTID-05062: one in-app navigation (route change) measured on the client.
// `screen` is the matched route pattern (ids collapsed), `nav` is 'return'
// when the route was already shown in this session.
const NavBeaconSchema = z.object({
  kind: z.literal('nav'),
  screen: z.string().min(1).max(256),
  nav: z.enum(['first', 'return']),
  ready_ms: z.number().finite().min(0).max(60000),
  img_refetch: z.number().int().min(0).max(500),
  img_total: z.number().int().min(0).max(500),
  timed_out: z.boolean(),
  session: z.string().min(1).max(128),
  captured_at: z.string().datetime({ offset: true }),
  user_agent: z.string().max(512).optional(),
  platform: z.enum(['ios', 'android', 'desktop', 'other']).optional(),
});

export type RumNavBeacon = z.infer<typeof NavBeaconSchema>;

function isNavBeacon(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).kind === 'nav';
}

async function handleNavBeacon(raw: unknown, res: Response) {
  const parse = NavBeaconSchema.safeParse(raw);
  if (!parse.success) {
    return res.status(400).json({ ok: false, error: 'invalid_beacon', issues: parse.error.issues });
  }
  const beacon = parse.data;

  try {
    await emitOasisEvent({
      vtid: 'VTID-05062',
      type: 'screen.nav.measured',
      source: 'gateway/rum-beacon',
      status: 'success',
      message: `${beacon.nav} nav ${beacon.ready_ms.toFixed(0)}ms on ${beacon.screen} (img_refetch ${beacon.img_refetch}/${beacon.img_total})`,
      payload: {
        screen: beacon.screen,
        nav: beacon.nav,
        ready_ms: beacon.ready_ms,
        img_refetch: beacon.img_refetch,
        img_total: beacon.img_total,
        timed_out: beacon.timed_out,
        session: beacon.session,
        captured_at: beacon.captured_at,
        user_agent: beacon.user_agent,
        platform: beacon.platform,
      },
    });
    return res.status(204).end();
  } catch (err) {
    // Same contract as metric beacons: never block the frontend.
    console.error('[rum-beacon] nav emit failed:', err);
    return res.status(204).end();
  }
}

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

  if (isNavBeacon(raw)) {
    return handleNavBeacon(raw, res);
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
