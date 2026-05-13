/**
 * VTID-02957 (PR-L2): Unit tests for the pure missing-test-scanner logic.
 *
 * The networked allocate path is tested via the route layer separately;
 * these tests cover only the pure derivation + dedupe logic so a bug in
 * capability spelling or gap detection is caught locally.
 */

import {
  deriveCapability,
  suggestedCommandKey,
  gapDedupeKey,
  scanMissingContracts,
  type ExistingContractRef,
} from '../src/services/missing-test-scanner';

describe('deriveCapability', () => {
  it('strips the /api/v1/ prefix and snake_cases the path', () => {
    expect(deriveCapability('/api/v1/auth/health')).toBe('auth_health');
    expect(deriveCapability('/api/v1/orb/health')).toBe('orb_health');
  });

  it('replaces hyphens with underscores for snake_case parity with allowlist keys', () => {
    expect(deriveCapability('/api/v1/canary-target/health')).toBe('canary_target_health');
    expect(deriveCapability('/api/v1/scheduled-notifications/health')).toBe(
      'scheduled_notifications_health',
    );
  });

  it('preserves multi-segment paths', () => {
    expect(deriveCapability('/api/v1/operator/deployments/health')).toBe(
      'operator_deployments_health',
    );
    expect(deriveCapability('/api/v1/conversation/tool-health')).toBe(
      'conversation_tool_health',
    );
  });

  it('strips any non [a-z0-9_] characters defensively', () => {
    // Bizarre / future endpoints — the scanner should never produce
    // invalid capability strings that would later fail the route regex.
    expect(deriveCapability('/api/v1/foo.bar/health')).toBe('foobar_health');
    expect(deriveCapability('/api/v1/X.Y/health')).toBe('xy_health');
  });

  it('handles non /api/v1/ prefixed paths (e.g. /alive, /command-hub/...)', () => {
    expect(deriveCapability('/alive')).toBe('alive');
    expect(deriveCapability('/command-hub/health')).toBe('command_hub_health');
  });
});

describe('suggestedCommandKey', () => {
  it('prefixes with gateway. matching the allowlist convention', () => {
    expect(suggestedCommandKey('auth_health')).toBe('gateway.auth_health');
    expect(suggestedCommandKey('canary_target_health')).toBe('gateway.canary_target_health');
  });
});

describe('gapDedupeKey', () => {
  it('joins capability:service:contract_type — matches the test_contracts composite UNIQUE', () => {
    expect(gapDedupeKey('auth_health', 'gateway', 'live_probe')).toBe(
      'auth_health:gateway:live_probe',
    );
  });
});

describe('scanMissingContracts', () => {
  const sampleMap: Record<string, string> = {
    '/alive': 'services/gateway/src/index.ts',
    '/api/v1/auth/health': 'services/gateway/src/routes/auth.ts',
    '/api/v1/canary-target/health': 'services/gateway/src/routes/canary-target.ts',
  };

  it('returns ALL endpoints as gaps when no contracts exist yet', () => {
    const gaps = scanMissingContracts(sampleMap, []);
    expect(gaps).toHaveLength(3);
    expect(gaps.map((g) => g.capability).sort()).toEqual([
      'alive',
      'auth_health',
      'canary_target_health',
    ]);
  });

  it('excludes endpoints that already have a matching capability:service:live_probe contract', () => {
    const existing: ExistingContractRef[] = [
      { capability: 'auth_health', service: 'gateway', contract_type: 'live_probe' },
    ];
    const gaps = scanMissingContracts(sampleMap, existing);
    expect(gaps.map((g) => g.capability)).not.toContain('auth_health');
    expect(gaps.map((g) => g.capability).sort()).toEqual(['alive', 'canary_target_health']);
  });

  it('does NOT exclude when only the capability matches but service or contract_type differ (dedupe is the full triple)', () => {
    // A contract for 'auth_health' on a DIFFERENT service should not cover
    // the gateway live_probe gap. The dedupe is the composite UNIQUE, not
    // just the capability slug.
    const existing: ExistingContractRef[] = [
      { capability: 'auth_health', service: 'worker-runner', contract_type: 'live_probe' },
      { capability: 'auth_health', service: 'gateway', contract_type: 'jest' },
    ];
    const gaps = scanMissingContracts(sampleMap, existing);
    expect(gaps.map((g) => g.capability)).toContain('auth_health');
  });

  it('every gap carries the four fields the LLM needs to write both the test + the allowlist entry', () => {
    const [gap] = scanMissingContracts(
      { '/api/v1/orb/health': 'services/gateway/src/routes/orb-live.ts' },
      [],
    );
    expect(gap).toMatchObject({
      capability: 'orb_health',
      contract_type: 'live_probe',
      service: 'gateway',
      environment: 'dev',
      target_endpoint: '/api/v1/orb/health',
      target_file: 'services/gateway/src/routes/orb-live.ts',
      suggested_command_key: 'gateway.orb_health',
      dedupe_key: 'orb_health:gateway:live_probe',
    });
  });

  it('returns an empty list when every endpoint is already covered', () => {
    const existing: ExistingContractRef[] = [
      { capability: 'alive', service: 'gateway', contract_type: 'live_probe' },
      { capability: 'auth_health', service: 'gateway', contract_type: 'live_probe' },
      { capability: 'canary_target_health', service: 'gateway', contract_type: 'live_probe' },
    ];
    expect(scanMissingContracts(sampleMap, existing)).toEqual([]);
  });

  it('sorts gaps deterministically by endpoint path (so the cockpit renders consistently)', () => {
    const gaps = scanMissingContracts(sampleMap, []);
    const endpoints = gaps.map((g) => g.target_endpoint);
    const sorted = [...endpoints].sort();
    expect(endpoints).toEqual(sorted);
  });

  it('is pure — same inputs produce same outputs across invocations', () => {
    const a = scanMissingContracts(sampleMap, []);
    const b = scanMissingContracts(sampleMap, []);
    expect(a).toEqual(b);
  });
});
