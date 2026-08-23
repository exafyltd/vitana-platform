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

describe('vertexUnavailable — VTID-03703: now forces through EVERY gate, none excepted', () => {
  // VTID-03703 corrects the prior (wrong) design in this describe block.
  // Live traffic (VTID-03688) proved "nova_disabled"/"nova_not_allowlisted"
  // are NOT safe to still pin to Vertex once Vertex is dead: real sessions
  // reached a genuine Vertex connect this way and died with upstream code
  // 1007. There is no longer any gate that may return `provider: 'vertex'`
  // while `vertexUnavailable` is true — see the new assertions below.

  it('Nova disabled, explicit request, unset (default): still vertex — unchanged behavior', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      nova: { enabled: false, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('nova_disabled');
  });

  it('Nova disabled, explicit request, vertexUnavailable=true: forced onto Nova, never Vertex', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: true,
      nova: { enabled: false, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.novaReady).toBe(false);
  });

  it('Nova disabled, default (no-request) path, vertexUnavailable=true: forced onto Nova, never falls through to a vertex default', () => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: true,
      nova: { enabled: false, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
  });

  it('Nova disabled, language a cascade already covers, vertexUnavailable=true: routes to the cascade, not a blind forced Nova', () => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: true,
      nova: { enabled: false, identityAllowed: true, languageSupported: false, runtime: 'aws-ecs' },
      cascade: { enabled: true, languageSupported: true },
    });
    expect(d.provider).toBe('cascaded');
    expect(d.reason).toBe('cascaded_language_rescue');
  });

  it('Nova disabled, no nova context at all, vertexUnavailable=true: forced onto Nova blind rather than Vertex', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: true,
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
  });

  it('identity not allowlisted, explicit request, unset (default): still vertex — unchanged behavior', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      nova: { enabled: true, identityAllowed: false, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('nova_not_allowlisted');
  });

  it('identity not allowlisted, explicit request, vertexUnavailable=true: forced onto Nova — a dead Vertex outranks canary policy', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: true,
      nova: { enabled: true, identityAllowed: false, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.novaReady).toBe(false);
  });

  it('identity not allowlisted, default (no-request) path, vertexUnavailable=true: forced onto Nova, never falls through to a vertex default', () => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: true,
      nova: { enabled: true, identityAllowed: false, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
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

  it('env_explicit_vertex is untouched — the emergency-rollback escape hatch is a deliberate operator action, not automatic session routing', () => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'vertex',
      vertexUnavailable: true,
      nova: { enabled: true, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('env_explicit_vertex');
  });
});
