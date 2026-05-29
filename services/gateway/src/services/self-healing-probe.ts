/**
 * Self-healing endpoint probe — shared between the report-time pre-probe gate
 * (services/gateway/src/routes/self-healing.ts) and the periodic reconciler
 * (services/gateway/src/services/self-healing-reconciler.ts).
 *
 * Voice synthetic endpoints (voice-error://<class>) are intentionally reported
 * as not-healthy so reconciler/preflight callers keep them in the queue and
 * let the dedicated Synthetic Voice Probe verify them instead.
 */

const DEFAULT_GATEWAY_URL =
  process.env.GATEWAY_URL || 'https://gateway.vitanaland.com';
const DEFAULT_TIMEOUT_MS = 5_000;

export interface ProbeResult {
  healthy: boolean;
  http_status: number | null;
  latency_ms: number;
  content_type?: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Override base URL (mainly for tests). Defaults to env GATEWAY_URL. */
  gatewayUrl?: string;
}

function isVoiceSyntheticEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('voice-error://');
}

function buildProbeUrl(endpoint: string, gatewayUrl: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  if (endpoint.startsWith('/')) return `${gatewayUrl}${endpoint}`;
  return `${gatewayUrl}/${endpoint}`;
}

export async function probeEndpoint(
  endpoint: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  if (isVoiceSyntheticEndpoint(endpoint)) {
    return { healthy: false, http_status: null, latency_ms: 0 };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gatewayUrl = opts.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const url = buildProbeUrl(endpoint, gatewayUrl);
  const started = Date.now();

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const latency_ms = Date.now() - started;
    const content_type = res.headers.get('content-type') || undefined;
    return {
      healthy: res.ok,
      http_status: res.status,
      latency_ms,
      content_type,
    };
  } catch {
    return {
      healthy: false,
      http_status: null,
      latency_ms: Date.now() - started,
    };
  }
}

/**
 * Stricter check used by the pre-probe gate: an endpoint is only "already
 * healed" if it returned 2xx AND a JSON content-type. HTML 2xx (e.g. an SPA
 * catch-all returning index.html for a missing API route) does NOT count.
 */
export function isJsonHealthy(result: ProbeResult): boolean {
  if (!result.healthy) return false;
  if (result.http_status === null || result.http_status < 200 || result.http_status >= 300) {
    return false;
  }
  if (!result.content_type) return false;
  return result.content_type.toLowerCase().includes('application/json');
}
