/**
 * VTID-04875 — Overview Phase 1a: the service-health summary builder,
 * extracted verbatim from the inline GET /api/v1/admin/health/summary
 * handler (routes/admin-health.ts, VTID-04661) so the Command Hub Overview's
 * /ops/attention service-health adapter (plan A, REVISION 2 F3) can call it
 * in-process without a req/res.
 *
 * What it does, unchanged: runs every SERVICE_HEALTH_REGISTRY check once over
 * LOOPBACK (http://127.0.0.1:$PORT, default 8080) and classifies the results
 * (services/service-health-probe.ts).
 *
 * The loopback self-probe is deliberate and is kept (plan REVISION 3 N1): the
 * summary is service health **as seen from the serving task** — the very
 * process answering this request probes its own routes. On a multi-task ECS
 * service each task reports its own view; it is not an ALB-level or
 * cross-task view, and a dead sibling task is not visible from here.
 *
 * The optional `authHeader` is forwarded verbatim as `Authorization` to every
 * probe, so admin-gated health routes answer instead of reporting no_access.
 * The route passes the caller's own header (it is behind requireAdminAuth);
 * an in-process caller without a header gets no_access for gated routes.
 *
 * Cache semantics, unchanged: one module-level cache shared by every caller
 * (route and in-process alike), fresh for SUMMARY_CACHE_MS (30s) measured
 * from when the run finished; concurrent callers share one in-flight run.
 * `now` only decides cache freshness (defaults to Date.now()). A failed run
 * is not cached and rejects; the route maps that to 500 summary_failed.
 * The route's responses are pinned byte-for-byte by
 * test/vtid-04875-health-summary-builder.test.ts.
 */

import { SERVICE_HEALTH_REGISTRY, SERVICE_HEALTH_GROUPS } from '../constants/service-health-registry';
import { probeAllHealthEndpoints, summarize, type HealthSummary } from './service-health-probe';

export const SUMMARY_CACHE_MS = 30_000;
export const SUMMARY_PROBE_TIMEOUT_MS = 5_000;

let summaryCache: { at: number; value: Omit<HealthSummary, 'cached'> } | null = null;
let summaryInFlight: Promise<Omit<HealthSummary, 'cached'>> | null = null;

export function resetHealthSummaryCacheForTests(): void {
  summaryCache = null;
  summaryInFlight = null;
}

export interface BuildHealthSummaryInput {
  /** Forwarded verbatim as the probes' Authorization header. */
  authHeader?: string;
  /** Clock used for the cache-freshness check (ms since epoch). */
  now?: number;
}

export async function buildHealthSummary(input: BuildHealthSummaryInput = {}): Promise<HealthSummary> {
  const now = input.now ?? Date.now();
  if (summaryCache && now - summaryCache.at < SUMMARY_CACHE_MS) {
    return { ...summaryCache.value, cached: true };
  }
  if (!summaryInFlight) {
    const headers: Record<string, string> = {};
    if (typeof input.authHeader === 'string') headers.Authorization = input.authHeader;
    const port = process.env.PORT || '8080';
    summaryInFlight = probeAllHealthEndpoints(SERVICE_HEALTH_REGISTRY, {
      baseUrl: `http://127.0.0.1:${port}`,
      headers,
      timeoutMs: SUMMARY_PROBE_TIMEOUT_MS,
    })
      .then((items) => {
        const value = summarize(items, SERVICE_HEALTH_GROUPS, new Date().toISOString());
        summaryCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        summaryInFlight = null;
      });
  }
  const value = await summaryInFlight;
  return { ...value, cached: false };
}
