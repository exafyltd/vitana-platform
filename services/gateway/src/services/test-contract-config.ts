/**
 * VTID-02954 (PR-L1): Gateway base URL used by test-contract probes.
 * Tests can override via process.env.GATEWAY_INTERNAL_BASE_URL.
 *
 * Default is the production Cloud Run URL. The probes go through the
 * public URL so they exercise the same Cloud Run routing layer real
 * traffic uses (TLS termination, load balancer, etc.) — running probes
 * via localhost would miss those failure modes.
 *
 * Read at call time (not module-load) so env overrides in tests take
 * effect when beforeEach runs after the import has already happened.
 */

export function contractGatewayBaseUrl(): string {
  return (
    process.env.GATEWAY_INTERNAL_BASE_URL ||
    process.env.GATEWAY_PUBLIC_URL ||
    'https://gateway-86804897789.us-central1.run.app'
  );
}
