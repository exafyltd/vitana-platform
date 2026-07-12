/**
 * DEV-COMHU-03404: Overview trend data — hourly rollup of oasis_events for
 * the last 24h, so Command Hub Overview metric tiles can show a sparkline
 * instead of a bare instantaneous count. Without this, "Errors (24h): 5"
 * looks identical whether errors are falling or accelerating.
 *
 * Read-only and side-effect-free. Mounted at /api/v1/ops/overview-timeseries.
 * Dev-only (requireDevRole) — same auth shape as autonomy-pulse.ts, since
 * this is internal Command Hub telemetry, not a public API.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();

// Same shape as routes/autonomy-pulse.ts's requireDevRole: internal-service
// bypass header for server-to-server calls, otherwise requireAuth + the
// exafy_admin flag.
async function requireDevRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.get('X-Gateway-Internal') === (process.env.GATEWAY_INTERNAL_TOKEN || '__dev__') &&
      process.env.GATEWAY_INTERNAL_TOKEN) {
    return next();
  }
  let authFailed = false;
  await requireAuth(req as AuthenticatedRequest, res, () => {
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity) {
      authFailed = true;
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    if (identity.exafy_admin === true) return next();
    authFailed = true;
    res.status(403).json({ ok: false, error: 'Overview timeseries requires developer access (exafy_admin)' });
  });
  if (authFailed) return;
}

router.use(requireDevRole);

const LOOKBACK_HOURS = 24;
// Cap per-series row fetch so a noisy window can't blow up the query.
const MAX_ROWS_PER_SERIES = 5000;

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

interface EventRow {
  created_at: string;
}

async function pgGetTimestamps(
  config: { url: string; key: string },
  filter: string,
  since: string,
): Promise<string[]> {
  try {
    const r = await fetch(
      `${config.url}/rest/v1/oasis_events?${filter}&created_at=gt.${encodeURIComponent(since)}` +
        `&select=created_at&order=created_at.asc&limit=${MAX_ROWS_PER_SERIES}`,
      { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` } },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as EventRow[];
    return rows.map((row) => row.created_at);
  } catch {
    return [];
  }
}

// Buckets a list of ISO timestamps into LOOKBACK_HOURS 1-hour buckets ending
// now, oldest first — so the array can be dropped straight into a sparkline.
// Exported for unit testing (test/ops-overview-timeseries.test.ts).
export function bucketize(timestamps: string[]): number[] {
  const now = Date.now();
  const buckets = new Array(LOOKBACK_HOURS).fill(0);
  for (const ts of timestamps) {
    const t = new Date(ts).getTime();
    const hoursAgo = Math.floor((now - t) / 3_600_000);
    const idx = LOOKBACK_HOURS - 1 - hoursAgo;
    if (idx >= 0 && idx < LOOKBACK_HOURS) buckets[idx]++;
  }
  return buckets;
}

router.get('/', async (_req: Request, res: Response) => {
  const config = getSupabaseConfig();
  if (!config) {
    return res.status(500).json({ ok: false, error: 'Gateway misconfigured — missing Supabase env vars' });
  }

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString();

  const [errorTimestamps, deployTimestamps] = await Promise.all([
    pgGetTimestamps(config, 'status=eq.error', since),
    // Mirrors the topic filter the Overview client already uses for its
    // deploy-events query (topic=cicd.deploy).
    pgGetTimestamps(config, 'topic=ilike.*cicd.deploy*', since),
  ]);

  return res.json({
    ok: true,
    generated_at: new Date().toISOString(),
    lookback_hours: LOOKBACK_HOURS,
    series: {
      errors: bucketize(errorTimestamps),
      deploys: bucketize(deployTimestamps),
    },
  });
});

export default router;
