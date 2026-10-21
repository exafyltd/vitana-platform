/**
 * VTID-02954 (PR-L1): Test-contract probe URLs per service.
 *
 * Each test_contracts row carries a `service` column. The allowlist
 * looks the base URL up here so a single probe helper can target any
 * Cloud Run service. Tests override via env so beforeEach can swap.
 *
 * Read at call time so overrides set after import still take effect.
 *
 * VTID-02978 (M1): added worker-runner so the failure scanner can
 * probe worker-runner's /alive, /metrics, /ready, /live, and a future
 * operator-armed canary endpoint.
 */
import { gatewayBaseUrl } from '../env';

export function contractGatewayBaseUrl(): string {
  return (
    process.env.GATEWAY_INTERNAL_BASE_URL ||
    process.env.GATEWAY_PUBLIC_URL ||
    gatewayBaseUrl()
  );
}

export function contractWorkerRunnerBaseUrl(): string {
  return (
    process.env.WORKER_RUNNER_INTERNAL_BASE_URL ||
    process.env.WORKER_RUNNER_PUBLIC_URL ||
    // VTID-04318: worker-runner has no public URL on AWS (CLAUDE.md §1b —
    // it polls outward, no ALB). The old default was a deleted Cloud Run
    // host; an unset URL now fails the probe as base_url_not_configured.
    ''
  );
}

/**
 * Generic per-service URL lookup. Returns null for unknown services so
 * a typo in the migration (e.g. service='worker-runer') surfaces at
 * runtime as a 502 instead of silently probing gateway.
 */
export function contractServiceBaseUrl(service: string): string | null {
  switch (service) {
    case 'gateway':
      return contractGatewayBaseUrl();
    case 'worker-runner':
      return contractWorkerRunnerBaseUrl();
    default:
      return null;
  }
}
