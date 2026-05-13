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

export interface CapabilityGap {
  /** Stable dedupe key: capability:service:contract_type — matches the
   *  composite UNIQUE on test_contracts so a duplicate row is impossible. */
  dedupe_key: string;
  /** Suggested capability slug (snake_case, derived from endpoint path). */
  capability: string;
  /** Always 'live_probe' in PR-L2; jest/typecheck contracts are scanned
   *  in PR-L3 via a separate discovery (test/*.test.ts files). */
  contract_type: 'live_probe';
  /** Service the endpoint lives in. Currently always 'gateway' since the
   *  scanner only reads gateway routes. */
  service: 'gateway';
  /** Default environment for newly discovered capabilities. */
  environment: 'dev';
  /** The endpoint path, e.g. '/api/v1/auth/health'. */
  target_endpoint: string;
  /** The source file from ENDPOINT_FILE_MAP. */
  target_file: string;
  /** Suggested command_key for the allowlist entry the LLM will need to
   *  add (e.g. 'gateway.auth_health'). Always 'gateway.<capability>'. */
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

export function suggestedCommandKey(capability: string): string {
  return `gateway.${capability}`;
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
 * Pure scanner. Given the current ENDPOINT_FILE_MAP entries + the set
 * of existing contracts (by capability:service:contract_type), returns
 * every endpoint that does not yet have a `live_probe` contract.
 *
 * Sorted by endpoint path so the cockpit renders deterministically.
 */
export function scanMissingContracts(
  endpointMap: Record<string, string>,
  existing: ExistingContractRef[],
): CapabilityGap[] {
  const covered = new Set<string>();
  for (const c of existing) {
    covered.add(gapDedupeKey(c.capability, c.service, c.contract_type));
  }

  const gaps: CapabilityGap[] = [];
  for (const [endpoint, file] of Object.entries(endpointMap)) {
    const capability = deriveCapability(endpoint);
    const dedupe_key = gapDedupeKey(capability, 'gateway', 'live_probe');
    if (covered.has(dedupe_key)) continue;
    gaps.push({
      dedupe_key,
      capability,
      contract_type: 'live_probe',
      service: 'gateway',
      environment: 'dev',
      target_endpoint: endpoint,
      target_file: file,
      suggested_command_key: suggestedCommandKey(capability),
    });
  }

  gaps.sort((a, b) => (a.target_endpoint < b.target_endpoint ? -1 : 1));
  return gaps;
}

/**
 * Convenience: read the canonical ENDPOINT_FILE_MAP. Lets route handlers
 * call `scanMissingContractsAgainstLiveRegistry(existing)` without
 * importing self-healing types directly.
 */
export function scanMissingContractsAgainstLiveRegistry(
  existing: ExistingContractRef[],
): CapabilityGap[] {
  return scanMissingContracts(ENDPOINT_FILE_MAP, existing);
}
