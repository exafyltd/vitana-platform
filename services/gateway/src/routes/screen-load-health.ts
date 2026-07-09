/**
 * Screen Load Time — synthetic basic test (VTID-SCREEN-LOAD-01).
 *
 * The frontend already ships a Real User Monitoring beacon (vitana-v1
 * src/lib/rum.ts → POST /api/v1/rum/beacon → `screen.latency.measured` OASIS
 * events), but that pipe is gated `staging-only` — production traffic never
 * reaches it, so there is currently no way to answer "how long do screens
 * take to load" from real data.
 *
 * This route is a second, independent signal: a scheduled Playwright job
 * (e2e/community-mobile/shared/screen-load-timing.spec.ts, run on a cron via
 * .github/workflows/SCREEN-LOAD-TIMING.yml) loads a handful of key mobile
 * screens against production and POSTs each measured load time here. Each
 * result becomes a `screen.load.synthetic_test` OASIS event — same event
 * store, same table, different topic, so it survives independent of the RUM
 * feature flag.
 *
 * GET /health aggregates the most recent run into the same
 * `{ status: 'ok' | 'degraded' | 'down' }` shape every other Command Hub
 * "basic test" health endpoint returns, so it slots into the existing
 * Overview service-health grid (fetchServiceHealth in command-hub/app.js)
 * with zero special-casing on the frontend.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { emitOasisEvent } from '../services/oasis-event-service';
import { getSupabase } from '../lib/supabase';

const VTID = 'VTID-SCREEN-LOAD-01';
const TOPIC = 'screen.load.synthetic_test';

// A screen counts "slow" past this many ms, and "healthy" requires the p75
// across the last run to stay under it. Generous on purpose — this is a
// full authenticated SPA route load (JS bundle + data fetch + render), not
// a bare LCP paint, so it runs hotter than the RUM LCP thresholds in rum.ts.
const SLOW_THRESHOLD_MS = 6000;
// A run counts "stale" (→ down, not just degraded) if nothing has reported
// in this long — catches the cron itself being broken, not just a slow app.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000; // 3h — covers a couple of missed 30-min runs

const ReportSchema = z.object({
  run_id: z.string().min(1).max(128),
  environment: z.enum(['production', 'staging']).default('production'),
  results: z
    .array(
      z.object({
        screen: z.string().min(1).max(256),
        duration_ms: z.number().finite().nonnegative(),
        lcp_ms: z.number().finite().nonnegative().nullable().optional(),
        status: z.enum(['ok', 'error']).default('ok'),
        error: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const router = Router();

/**
 * POST /report — called by the scheduled Playwright job after each run.
 * Batches all screens from one run into one call; each screen still becomes
 * its own OASIS event so per-screen history stays queryable.
 */
router.post('/report', async (req: Request, res: Response) => {
  const parse = ReportSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ ok: false, error: 'invalid_report', issues: parse.error.issues });
  }
  const { run_id, environment, results } = parse.data;

  try {
    await Promise.all(
      results.map((r) =>
        emitOasisEvent({
          vtid: VTID,
          type: TOPIC,
          source: 'e2e/screen-load-timing',
          status: r.status === 'error' ? 'error' : r.duration_ms > SLOW_THRESHOLD_MS ? 'warning' : 'success',
          message:
            r.status === 'error'
              ? `${r.screen} failed to load: ${r.error ?? 'unknown error'}`
              : `${r.screen} loaded in ${r.duration_ms}ms`,
          payload: {
            run_id,
            environment,
            screen: r.screen,
            duration_ms: r.duration_ms,
            lcp_ms: r.lcp_ms ?? null,
            load_status: r.status,
            error: r.error ?? null,
          },
        }),
      ),
    );
    return res.status(204).end();
  } catch (err) {
    console.error('[screen-load-health] report ingest failed:', err);
    return res.status(500).json({ ok: false, error: 'ingest_failed' });
  }
});

/**
 * GET /health — Command Hub Overview's "basic test" grid polls this like
 * every other service. Reads the most recent run out of oasis_events rather
 * than re-running anything live (the actual test runs on its own cron).
 */
router.get('/health', async (_req: Request, res: Response) => {
  const sb = getSupabase();
  if (!sb) {
    return res.status(200).json({ status: 'down', reason: 'supabase_unconfigured' });
  }

  const since = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data, error } = await sb
    .from('oasis_events')
    .select('created_at, metadata')
    .eq('topic', TOPIC)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    return res.status(200).json({ status: 'down', reason: 'query_failed', detail: error.message });
  }

  if (!data || data.length === 0) {
    return res.status(200).json({
      status: 'down',
      reason: 'no_recent_runs',
      message: `No screen-load-timing results in the last ${Math.round(STALE_AFTER_MS / 3600000)}h — the scheduled job may be broken.`,
    });
  }

  // Keep only the most recent run (results within 5 min of the newest event).
  const latestAt = new Date(data[0].created_at).getTime();
  const latestRun = data.filter((row) => latestAt - new Date(row.created_at).getTime() < 5 * 60 * 1000);

  type Screen = { screen: string; duration_ms: number; lcp_ms: number | null; load_status: string };
  const screens: Screen[] = latestRun
    .map((row) => row.metadata as Record<string, unknown>)
    .filter((m): m is Record<string, unknown> => !!m)
    .map((m) => ({
      screen: String(m.screen ?? 'unknown'),
      duration_ms: Number(m.duration_ms ?? 0),
      lcp_ms: m.lcp_ms == null ? null : Number(m.lcp_ms),
      load_status: String(m.load_status ?? 'ok'),
    }));

  const failed = screens.filter((s) => s.load_status === 'error');
  const durations = screens.filter((s) => s.load_status === 'ok').map((s) => s.duration_ms).sort((a, b) => a - b);
  const p75Index = Math.min(durations.length - 1, Math.floor(durations.length * 0.75));
  const p75Ms = durations.length ? durations[p75Index] : null;
  const maxMs = durations.length ? durations[durations.length - 1] : null;

  const status: 'ok' | 'degraded' | 'down' =
    failed.length > 0 || p75Ms === null
      ? 'down'
      : p75Ms > SLOW_THRESHOLD_MS
        ? 'degraded'
        : 'ok';

  return res.status(200).json({
    status,
    checked_at: new Date().toISOString(),
    last_run_at: data[0].created_at,
    threshold_ms: SLOW_THRESHOLD_MS,
    p75_ms: p75Ms,
    max_ms: maxMs,
    screens_checked: screens.length,
    screens_failed: failed.map((s) => s.screen),
    screens,
  });
});

/**
 * GET / — router status, mirrors the convention other routers use.
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'screen-load-health',
    vtid: VTID,
    endpoints: [
      'POST /api/v1/frontend/screen-load/report',
      'GET /api/v1/frontend/screen-load/health',
    ],
    timestamp: new Date().toISOString(),
  });
});

export { router as screenLoadHealthRouter };
