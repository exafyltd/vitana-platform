/**
 * VTID-emergency-gcp-shutdown — `vertexUnavailable` forces Nova through the
 * runtime/language gates instead of degrading to a permanently-dead Vertex.
 *
 * Context: the GCP project's billing was disabled, killing Vertex Live
 * entirely. Before this, any session whose language fell outside Nova's
 * verified set (en/de/fr/es), or whose runtime detection reported anything
 * other than 'aws-ecs', silently degraded to Vertex — which used to be a
 * real fallback and is now a guaranteed connection failure. `vertexUnavailable`
 * is caller-supplied (reads `VERTEX_LIVE_UNAVAILABLE=true`) so the selector
 * stays pure and untouched when unset — every assertion here that matters is
 * paired with the same scenario at `vertexUnavailable: false` to prove the
 * flag is the only thing that moved.
 */

import {
  selectUpstreamProvider,
  type UpstreamSelectorContext,
} from '../../../../src/orb/live/upstream/upstream-provider-selector';

const USER = '33333333-3333-4333-8333-333333333333';

const base = {
  envProviderOverride: undefined,
  systemConfigActiveProvider: undefined,
  livekitCredentials: undefined,
  identity: { userId: USER, tenantId: null },
} satisfies Partial<UpstreamSelectorContext>;

describe('vertexUnavailable — unsupported language forces Nova instead of Vertex', () => {
  it('unset (default), explicit request: unsupported language still degrades to vertex — unchanged behavior', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      nova: { enabled: true, identityAllowed: true, languageSupported: false, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('nova_language_unsupported');
  });

  it('true, explicit request: unsupported language is forced onto Nova with a distinct reason', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: true,
      nova: { enabled: true, identityAllowed: true, languageSupported: false, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.novaReady).toBe(false);
  });

});

describe('vertexUnavailable — unsupported runtime forces Nova instead of Vertex', () => {
  it('unset (default), explicit request: gcp-cloud-run runtime still degrades to vertex — unchanged behavior', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      nova: { enabled: true, identityAllowed: true, languageSupported: true, runtime: 'gcp-cloud-run' },
    });
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('nova_runtime_unsupported');
  });

  it('true, explicit request: gcp-cloud-run runtime is forced onto Nova with a distinct reason', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: true,
      nova: { enabled: true, identityAllowed: true, languageSupported: true, runtime: 'gcp-cloud-run' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.novaReady).toBe(false);
  });
});

describe('vertexUnavailable — the default (no-request) path also forces Nova', () => {
  it('true: default path with unsupported language forces Nova, reports canary=false', () => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: true,
      nova: {
        enabled: true,
        identityAllowed: true,
        languageSupported: false,
        runtime: 'aws-ecs',
        globalEnabled: true,
      },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.requested).toBeNull();
    expect(d.canary).toBe(false);
  });
});

describe('vertexUnavailable — does NOT override deliberate operator gates', () => {
  it('Nova disabled, explicit request: still vertex even with vertexUnavailable=true (nothing to force through)', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: true,
      nova: { enabled: false, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('nova_disabled');
  });

  it('identity not allowlisted, explicit request: still vertex even with vertexUnavailable=true — an operator "no" is not a technical gate', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: true,
      nova: { enabled: true, identityAllowed: false, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('nova_not_allowlisted');
  });

  it('all gates pass normally: vertexUnavailable=true does not change the happy-path reason', () => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: true,
      nova: { enabled: true, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_canary_allowlisted');
    expect(d.novaReady).toBe(true);
  });
});
