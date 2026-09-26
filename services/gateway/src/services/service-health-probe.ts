/**
 * VTID-04661 — server-side Service Health probe for the Command Hub panel.
 *
 * Before this module the panel probed every check from the browser: one
 * fetch per registry entry, each with its own 6 s timeout, fired in
 * parallel on every refresh. With the registry growing past 100 entries
 * that is 100+ requests per open Command Hub tab. `GET
 * /api/v1/admin/health/summary` now runs the probes once, server side,
 * over loopback, and serves the result to every caller from a short cache.
 *
 * `classifyHealthResponse` is the one place that decides what a response
 * means. The panel's browser fallback carries a copy of the same rules
 * (`classifyHealthProbe` in command-hub/app.js); a parity test pins them.
 * Two rules changed from the old browser logic:
 *
 *   - HTTP 2xx with `{ ok: false }` and no `status` field is DOWN. It used to
 *     read as healthy because only `body.status` was consulted.
 *   - 401/403 is `no_access`, not `degraded`: the probe could not look, which
 *     says nothing about whether the service works.
 */

import type { ServiceHealthEndpoint } from '../constants/service-health-registry';

export type HealthProbeStatus = string;

export interface HealthProbeResult {
  name: string;
  url: string;
  group: string;
  status: HealthProbeStatus;
  healthy: boolean;
  http_status: number | null;
  latency_ms: number;
  details: unknown;
}

/** Status strings that count as healthy. */
export const HEALTHY_STATUSES = ['ok', 'healthy', 'ok_governance_limited'];

/** Status strings a check may report that are not failures of the check. */
const KNOWN_BAD_STATUSES = ['down', 'degraded', 'warning', 'error', 'unhealthy', 'unavailable', 'misconfigured'];

/** Largest `details` payload kept per check; bigger bodies are summarised. */
export const MAX_DETAILS_BYTES = 16 * 1024;

export function classifyHealthResponse(
  httpStatus: number | null,
  body: unknown,
): { status: HealthProbeStatus; healthy: boolean } {
  if (httpStatus === null) return { status: 'down', healthy: false };
  if (httpStatus === 401 || httpStatus === 403) return { status: 'no_access', healthy: false };

  const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const reported = obj && typeof obj.status === 'string' ? obj.status.toLowerCase() : null;

  if (httpStatus >= 200 && httpStatus < 300) {
    if (reported) {
      return { status: reported, healthy: HEALTHY_STATUSES.includes(reported) };
    }
    if (obj && obj.ok === false) return { status: 'down', healthy: false };
    return { status: 'healthy', healthy: true };
  }

  // Non-2xx: a check that reports its own bad status (e.g. 503 {status:'degraded'})
  // keeps it; anything else is down (404 = route missing, 5xx = broken).
  if (reported && KNOWN_BAD_STATUSES.includes(reported)) return { status: reported, healthy: false };
  return { status: 'down', healthy: false };
}

function capDetails(body: unknown): unknown {
  if (body === undefined) return null;
  try {
    const raw = JSON.stringify(body);
    if (raw && raw.length > MAX_DETAILS_BYTES) {
      return { truncated: true, bytes: raw.length };
    }
  } catch {
    return null;
  }
  return body;
}

export interface ProbeOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function probeHealthEndpoint(ep: ServiceHealthEndpoint, opts: ProbeOptions): Promise<HealthProbeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  const start = Date.now();
  try {
    const res = await doFetch(opts.baseUrl + ep.url, {
      headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
      signal: controller.signal,
    });
    const latency = Date.now() - start;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const { status, healthy } = classifyHealthResponse(res.status, body);
    return { ...ep, status, healthy, http_status: res.status, latency_ms: latency, details: capDetails(body) };
  } catch {
    return { ...ep, status: 'down', healthy: false, http_status: null, latency_ms: -1, details: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAllHealthEndpoints(
  endpoints: ServiceHealthEndpoint[],
  opts: ProbeOptions,
): Promise<HealthProbeResult[]> {
  return Promise.all(endpoints.map((ep) => probeHealthEndpoint(ep, opts)));
}

export interface HealthSummary {
  ok: true;
  checked_at: string;
  cached: boolean;
  total: number;
  healthy: number;
  failing: number;
  no_access: number;
  groups: string[];
  items: HealthProbeResult[];
}

export function summarize(items: HealthProbeResult[], groups: string[], checkedAt: string): Omit<HealthSummary, 'cached'> {
  const healthy = items.filter((i) => i.healthy).length;
  const noAccess = items.filter((i) => i.status === 'no_access').length;
  return {
    ok: true,
    checked_at: checkedAt,
    total: items.length,
    healthy,
    failing: items.length - healthy - noAccess,
    no_access: noAccess,
    groups,
    items,
  };
}
