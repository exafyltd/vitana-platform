/**
 * VTID-02957 (PR-L2): Missing-Test Scanner.
 *
 * Walks the registered set of HTTP capabilities (ENDPOINT_FILE_MAP) and
 * reports every endpoint that does NOT yet have a row in test_contracts.
 * For each gap, the scanner derives a suggested capability key + command
 * key so the LLM bridge can write both a test file AND the allowlist
 * entry in one PR.
 *
 * PR-L2 scope:
 *   - Pure scanner logic (this file) — testable without DB
 *   - GET /api/v1/test-contracts/missing — list gaps
 *   - POST /api/v1/test-contracts/missing/:dedupe_key/allocate — allocate
 *     one VTID for a specific gap with metadata.repair_kind='write_test'
 *   - Dedupe vs existing in-flight VTIDs so re-runs don't multiply
 *
 * Out of scope for PR-L2 (lands in PR-L3):
 *   - Automatic scheduled run (cron / scheduler)
 *   - Bulk allocation of all gaps in one call
 *   - Bridging to the autopilot Cloud Run Job (the existing self-healing
 *     injector handles the bridge once a VTID + recommendation exist)
 */

import { ENDPOINT_FILE_MAP } from '../types/self-healing';

/**
 * VTID-02978 (M1): worker-runner endpoints the scanner should consider.
 * Mirrors the shape of gateway's ENDPOINT_FILE_MAP but lives here in
 * the scanner (worker-runner doesn't share a types package with gateway,
 * and the surface is small enough not to warrant one).
 */
export const WORKER_RUNNER_ENDPOINT_FILE_MAP: Record<string, string> = {
  '/alive': 'services/worker-runner/src/index.ts',
  '/ready': 'services/worker-runner/src/index.ts',
  '/live': 'services/worker-runner/src/index.ts',
  '/metrics': 'services/worker-runner/src/index.ts',
  '/api/v1/canary-target/health': 'services/worker-runner/src/routes/canary-target.ts',
};

export interface CapabilityGap {
  /** Stable dedupe key: capability:service:contract_type — matches the
   *  composite UNIQUE on test_contracts so a duplicate row is impossible. */
  dedupe_key: string;
  /** Suggested capability slug (snake_case, derived from endpoint path,
   *  prefixed by service when not 'gateway'). */
  capability: string;
  /** Always 'live_probe' in PR-L2; jest/typecheck contracts are scanned
   *  in PR-L3 via a separate discovery (test/*.test.ts files). */
  contract_type: 'live_probe';
  /** Service the endpoint lives in. M1 added worker-runner alongside gateway. */
  service: 'gateway' | 'worker-runner';
  /** Default environment for newly discovered capabilities. */
  environment: 'dev';
  /** The endpoint path, e.g. '/api/v1/auth/health'. */
  target_endpoint: string;
  /** The source file from the endpoint map. */
  target_file: string;
  /** Suggested command_key for the allowlist entry the LLM will need to
   *  add (e.g. 'gateway.auth_health' or 'worker_runner.alive'). */
  suggested_command_key: string;
}

/**
 * Convert an endpoint path to a snake_case capability slug.
 *
 *   /api/v1/auth/health              → 'auth_health'
 *   /api/v1/canary-target/health     → 'canary_target_health'
 *   /api/v1/scheduled-notifications/health
 *                                    → 'scheduled_notifications_health'
 *
 * Pure / deterministic. Strips the common '/api/v1/' prefix because
 * every gateway capability shares it, leaves anything else alone. The
 * LLM repair PR can rename the capability if it prefers something
 * shorter — the dedupe key only ties to this specific capability
 * spelling, so a future rename would simply create a new contract row
 * (no orphaning).
 */
export function deriveCapability(endpoint: string): string {
  return endpoint
    .replace(/^\/api\/v\d+\//, '')
    .replace(/^\//, '')
    .replace(/[/-]/g, '_')
    .replace(/[^a-z0-9_]/gi, '')
    .toLowerCase();
}

/**
 * VTID-02978 (M1): command_key prefix follows the service to keep keys
 * aligned with the allowlist convention (gateway.X vs worker_runner.X).
 * Service slug uses underscores so the prefix stays a valid JS
 * identifier-shape; the migration uses the same convention.
 */
export function suggestedCommandKey(capability: string, service: 'gateway' | 'worker-runner' = 'gateway'): string {
  const prefix = service === 'worker-runner' ? 'worker_runner' : 'gateway';
  // Strip the service prefix from the capability if it already starts
  // with it (e.g. capability='worker_runner_alive' → key='worker_runner.alive')
  const trimmed =
    service === 'worker-runner' && capability.startsWith('worker_runner_')
      ? capability.slice('worker_runner_'.length)
      : capability;
  return `${prefix}.${trimmed}`;
}

export function gapDedupeKey(capability: string, service: string, contract_type: string): string {
  return `${capability}:${service}:${contract_type}`;
}

/**
 * Existing contract minimal shape — the scanner only needs these three
 * columns to compute "already covered".
 */
export interface ExistingContractRef {
  capability: string;
  service: string;
  contract_type: string;
}

/**
 * Pure scanner. Given an endpoint map for a specific service + the set
 * of existing contracts (by capability:service:contract_type), returns
 * every endpoint that does not yet have a `live_probe` contract.
 *
 * Sorted by endpoint path so the cockpit renders deterministically.
 *
 * VTID-02978 (M1): added `service` parameter. Capability slugs are
 * namespaced by service ('worker_runner_alive' vs 'gateway_alive') so
 * worker-runner and gateway can both have an /alive endpoint without
 * dedupe collision.
 */
export function scanMissingContracts(
  endpointMap: Record<string, string>,
  existing: ExistingContractRef[],
  service: 'gateway' | 'worker-runner' = 'gateway',
): CapabilityGap[] {
  const covered = new Set<string>();
  for (const c of existing) {
    covered.add(gapDedupeKey(c.capability, c.service, c.contract_type));
  }

  const gaps: CapabilityGap[] = [];
  for (const [endpoint, file] of Object.entries(endpointMap)) {
    const baseCapability = deriveCapability(endpoint);
    // Namespace by service so `/alive` on worker-runner doesn't collide
    // with `/alive` on gateway. Gateway keeps its bare slug for backward
    // compatibility with PR-L2 contracts already in the registry.
    const capability =
      service === 'worker-runner'
        ? `worker_runner_${baseCapability}`
        : baseCapability;
    const dedupe_key = gapDedupeKey(capability, service, 'live_probe');
    if (covered.has(dedupe_key)) continue;
    gaps.push({
      dedupe_key,
      capability,
      contract_type: 'live_probe',
      service,
      environment: 'dev',
      target_endpoint: endpoint,
      target_file: file,
      suggested_command_key: suggestedCommandKey(capability, service),
    });
  }

  gaps.sort((a, b) => (a.target_endpoint < b.target_endpoint ? -1 : 1));
  return gaps;
}

/**
 * Convenience: walk gateway's ENDPOINT_FILE_MAP and worker-runner's
 * analog in one call. The route handler uses this to produce a single
 * list of gaps across both services.
 */
export function scanMissingContractsAgainstLiveRegistry(
  existing: ExistingContractRef[],
): CapabilityGap[] {
  const gatewayGaps = scanMissingContracts(ENDPOINT_FILE_MAP, existing, 'gateway');
  const workerRunnerGaps = scanMissingContracts(
    WORKER_RUNNER_ENDPOINT_FILE_MAP,
    existing,
    'worker-runner',
  );
  return [...gatewayGaps, ...workerRunnerGaps].sort((a, b) =>
    a.target_endpoint < b.target_endpoint ? -1 : 1,
  );
}
