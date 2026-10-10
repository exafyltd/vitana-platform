/**
 * Screen Load Time — synthetic basic test (VTID-SCREEN-LOAD-01).
 *
 * The frontend also ships a Real User Monitoring beacon (vitana-v1
 * src/lib/rum.ts → POST /api/v1/rum/beacon → `screen.latency.measured` and,
 * since VTID-05062, `screen.nav.measured` OASIS events). That pipe is gated
 * by FEATURE_LATENCY_TELEMETRY_ENV, which is `staging+prod` — real members'
 * production devices report into it; the daily report below reads it.
 *
 * This route is a second, independent signal: a scheduled Playwright job
 * (e2e/community-mobile/shared/screen-load-timing.spec.ts, run on a cron via
 * .github/workflows/SCREEN-LOAD-TIMING.yml) cold-loads a handful of key
 * mobile screens against STAGING (VTID-04648 — browser suites never run
 * against production) and POSTs each measured load time here. Each
 * result becomes a `screen.load.synthetic_test` OASIS event — same event
 * store, same table, different topic, so it survives independent of the RUM
 * feature flag.
 *
 * GET /health aggregates the most recent run into the same
 * `{ status: 'ok' | 'degraded' | 'down' }` shape every other Command Hub
 * "basic test" health endpoint returns, so it slots into the existing
 * Overview service-health grid (fetchServiceHealth in command-hub/app.js)
 * with zero special-casing on the frontend.
 *
 * VTID-05062 adds the daily PRODUCTION report (services/screen-load-daily-report.ts):
 *   POST /daily-report/run — service-token only, once per UTC day (idempotent;
 *     `?force=true` re-runs), called by .github/workflows/SCREEN-LOAD-DAILY.yml.
 *     Emits `screen.load.daily_report` and posts one Google Chat summary.
 *   GET  /daily-report     — latest report in the same health shape.
 * Both coexist with /health (the synthetic cold-load job), which is unchanged.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { emitOasisEvent } from '../services/oasis-event-service';
import { getSupabase } from '../lib/supabase';
import * as repo from './screen-load-health-repository';
import { notifyGChat } from '../services/self-healing-snapshot-service';
import { VITANA_ENV } from '../env';
import {
  DAILY_REPORT_TOPIC,
  buildDailyReport,
  createLiveDailyReportDeps,
  utcDay,
  type DailyReport,
} from '../services/screen-load-daily-report';

const VTID = 'VTID-SCREEN-LOAD-01';
const TOPIC = 'screen.load.synthetic_test';

// A screen counts "slow" past this many ms, and "healthy" requires the p75
// across the last run to stay under it. Generous on purpose — this is a
// full authenticated SPA route load (JS bundle + data fetch + render), not
// a bare LCP paint, so it runs hotter than the RUM LCP thresholds in rum.ts.
const SLOW_THRESHOLD_MS = 6000;
// VTID-04661: two freshness tiers. The workflow is scheduled every 30 min,
// but GitHub runs scheduled workflows best-effort — measured 2026-09-26,
// consecutive runs landed 3-5.5h apart. A single 3h cutoff therefore read
// "down" most of the day while every run was green. A report older than
// LAGGING_AFTER_MS is 'degraded' (reason scheduler_lag); only nothing in
// STALE_AFTER_MS — the job is really broken or not reporting — is 'down'.
const LAGGING_AFTER_MS = 3 * 60 * 60 * 1000;
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

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
 * Service-token gate for /report, mirroring the orb-agent pattern in
 * routes/oasis-emit.ts: only the SCREEN-LOAD-TIMING.yml runner (which holds
 * GATEWAY_SERVICE_TOKEN as a repo secret) may write results, so nobody can
 * forge a "healthy" or "down" reading by POSTing arbitrary timings.
 */
function requireApiKey(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ ok: false, error: 'missing_bearer_token' });
    return;
  }
  const serviceToken = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  if (serviceToken.length === 0 || token !== serviceToken) {
    res.status(401).json({ ok: false, error: 'invalid_service_token' });
    return;
  }
  next();
}

/**
 * POST /report — called by the scheduled Playwright job after each run.
 * Batches all screens from one run into one call; each screen still becomes
 * its own OASIS event so per-screen history stays queryable.
 */
router.post('/report', requireApiKey, async (req: Request, res: Response) => {
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
 * every other service, unauthenticated (see fetchServiceHealth in
 * command-hub/app.js) — same convention as every other per-service health
 * endpoint. Exposes only aggregate timing numbers, nothing sensitive.
 * Reads the most recent run out of oasis_events rather than re-running
 * anything live (the actual test runs on its own cron).
 */
router.get('/health', async (_req: Request, res: Response) => { // public-route
  const sb = getSupabase();
  if (!sb) {
    return res.status(200).json({ status: 'down', reason: 'supabase_unconfigured' });
  }

  const since = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data, error } = await repo.fetchRecentScreenLoadHealthEvents(sb, TOPIC, since);

  if (error) {
    return res.status(200).json({ status: 'down', reason: 'query_failed', detail: error.message });
  }

  if (!data || data.length === 0) {
    return res.status(200).json({
      status: 'down',
      reason: 'no_recent_runs',
      message: `No screen-load-timing results in the last ${Math.round(STALE_AFTER_MS / 3600000)}h — the scheduled job is not running, or its report is being rejected (see the SCREEN-LOAD-TIMING run's 'Check the report was accepted' step).`,
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

  const lagging = Date.now() - latestAt > LAGGING_AFTER_MS;
  const status: 'ok' | 'degraded' | 'down' =
    failed.length > 0 || p75Ms === null
      ? 'down'
      : p75Ms > SLOW_THRESHOLD_MS || lagging
        ? 'degraded'
        : 'ok';

  return res.status(200).json({
    status,
    ...(status === 'degraded' && lagging && !(p75Ms !== null && p75Ms > SLOW_THRESHOLD_MS)
      ? { reason: 'scheduler_lag', message: `Last report is ${Math.round((Date.now() - latestAt) / 60000)} min old — the schedule runs late; results are still from a real run.` }
      : {}),
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

// ---------------------------------------------------------------------------
// VTID-05062 — daily production screen-load report
// ---------------------------------------------------------------------------

const DAILY_VTID = 'VTID-05062';
// The daily job runs once per UTC day; a report older than this means the
// schedule (or its auth) is broken, so GET /daily-report reads 'down'.
const DAILY_REPORT_STALE_MS = 36 * 60 * 60 * 1000;

type RunOutcome =
  | { ok: true; created: boolean; report: DailyReport; gchat?: { ok: boolean; webhook_set: boolean } }
  | { ok: false; status: number; error: string; detail?: string };

// Two concurrent run calls on the same task share one build (and one GChat
// post). Across tasks the workflow's own concurrency group serialises runs.
let inFlightRun: { day: string; promise: Promise<RunOutcome> } | null = null;

async function runDailyReport(force: boolean): Promise<RunOutcome> {
  const sb = getSupabase();
  if (!sb) return { ok: false, status: 503, error: 'supabase_unconfigured' };

  const now = new Date();
  const today = utcDay(now);

  if (!force) {
    const { data, error } = await repo.fetchLatestDailyReportEvent(sb, DAILY_REPORT_TOPIC, {
      reportDate: today,
      env: VITANA_ENV,
    });
    if (error) return { ok: false, status: 500, error: 'query_failed', detail: error.message };
    if (data && data.length > 0 && data[0].metadata) {
      return { ok: true, created: false, report: data[0].metadata as unknown as DailyReport };
    }
  }

  const report = await buildDailyReport(createLiveDailyReportDeps(sb, now));
  const emitted = await emitOasisEvent({
    vtid: DAILY_VTID,
    type: DAILY_REPORT_TOPIC,
    source: 'gateway/screen-load-daily-report',
    status: report.status === 'green' ? 'success' : report.status === 'red' ? 'error' : 'info',
    message: `Screen loading ${report.report_date}: ${report.status}${report.worst ? ` (worst ${report.worst.screen})` : ''}`,
    payload: report as unknown as Record<string, unknown>,
  });
  if (!emitted.ok) {
    // Not recorded → the next call would build again; do not post to GChat
    // for a report the idempotency check cannot see.
    return { ok: false, status: 500, error: 'emit_failed', detail: emitted.error };
  }
  const gchat = await notifyGChat(report.gchat_text);
  return { ok: true, created: true, report, gchat: { ok: gchat.ok, webhook_set: gchat.webhook_set } };
}

/**
 * POST /daily-report/run — service token only (same gate as /report).
 * Idempotent per UTC day: returns today's report if one exists, unless
 * `?force=true`.
 */
router.post('/daily-report/run', requireApiKey, async (req: Request, res: Response) => {
  const force = req.query.force === 'true' || req.query.force === '1';
  const day = utcDay(new Date());
  try {
    let outcome: RunOutcome;
    if (!force && inFlightRun && inFlightRun.day === day) {
      outcome = await inFlightRun.promise;
      if (outcome.ok) outcome = { ok: true, created: false, report: outcome.report };
    } else {
      const promise = runDailyReport(force);
      inFlightRun = { day, promise };
      try {
        outcome = await promise;
      } finally {
        if (inFlightRun?.promise === promise) inFlightRun = null;
      }
    }
    if (!outcome.ok) {
      return res.status(outcome.status).json({ ok: false, error: outcome.error, detail: outcome.detail });
    }
    return res.status(200).json({
      ok: true,
      created: outcome.created,
      status: outcome.report.status,
      health: outcome.report.health,
      report: outcome.report,
      ...(outcome.gchat ? { gchat: outcome.gchat } : {}),
    });
  } catch (err) {
    console.error('[screen-load-health] daily report failed:', err);
    return res.status(500).json({ ok: false, error: 'daily_report_failed', detail: (err as Error)?.message });
  }
});

/**
 * GET /daily-report — latest daily report in the Command Hub health shape.
 * Unauthenticated like /health: aggregate numbers only, nothing sensitive.
 */
router.get('/daily-report', async (_req: Request, res: Response) => { // public-route
  const sb = getSupabase();
  if (!sb) {
    return res.status(200).json({ status: 'down', reason: 'supabase_unconfigured' });
  }
  const { data, error } = await repo.fetchLatestDailyReportEvent(sb, DAILY_REPORT_TOPIC, { env: VITANA_ENV });
  if (error) {
    return res.status(200).json({ status: 'down', reason: 'query_failed', detail: error.message });
  }
  const row = data && data.length > 0 ? data[0] : null;
  const report = (row?.metadata ?? null) as unknown as DailyReport | null;
  if (!row || !report || !report.health) {
    return res.status(200).json({
      status: 'down',
      reason: 'no_report',
      message: 'No daily screen-load report yet — see the SCREEN-LOAD-DAILY workflow.',
    });
  }
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  const stale = ageMs > DAILY_REPORT_STALE_MS;
  return res.status(200).json({
    status: stale ? 'down' : report.health,
    ...(stale
      ? { reason: 'report_stale', message: `Last daily report is ${Math.round(ageMs / 3600000)}h old — the SCREEN-LOAD-DAILY schedule is not running.` }
      : {}),
    checked_at: new Date().toISOString(),
    report_status: report.status,
    report_date: report.report_date,
    generated_at: report.generated_at,
    worst: report.worst,
    build: report.build,
    lcp_p75_ms: report.lcp_p75_ms,
    screens: report.screens,
    budgets: report.budgets,
  });
});

/**
 * GET / — router status/self-description only, no data. Mirrors the
 * convention other routers use.
 */
router.get('/', (_req: Request, res: Response) => { // public-route
  return res.status(200).json({
    ok: true,
    service: 'screen-load-health',
    vtid: VTID,
    endpoints: [
      'POST /api/v1/frontend/screen-load/report',
      'GET /api/v1/frontend/screen-load/health',
      'POST /api/v1/frontend/screen-load/daily-report/run',
      'GET /api/v1/frontend/screen-load/daily-report',
    ],
    timestamp: new Date().toISOString(),
  });
});

export { router as screenLoadHealthRouter };
