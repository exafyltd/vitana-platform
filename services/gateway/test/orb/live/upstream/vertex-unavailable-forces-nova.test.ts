/**
 * VTID-emergency-gcp-shutdown / VTID-03703 / VTID-03723 — Vertex is not a
 * destination any more, period.
 *
 * History: `vertexUnavailable` (reads `VERTEX_LIVE_UNAVAILABLE=true`) used to
 * be the SWITCH that decided whether a degraded Nova gate fell back to Vertex
 * (a real fallback, once) or forced through to Nova instead. VTID-03723 made
 * that switch permanently on: staging's `voice.active_provider='vertex'` row
 * proved that relying on an env var/flag to opt OUT of Vertex is exactly how
 * a whole class of session (every pre-login session, for weeks) can silently
 * miss the flag and land on a guaranteed-dead Vertex connect anyway — this is
 * the same failure shape as the reported pl/pt-speaking-English incident,
 * just via a different unset flag. So the flag no longer gates anything: the
 * selector now forces through to Nova/the cascade UNCONDITIONALLY, whether
 * `vertexUnavailable` is `true`, `false`, or omitted. The field is kept on
 * `UpstreamSelectorContext` (harmless, still read nowhere in the current
 * code path) so callers that still set it don't need a coordinated edit.
 *
 * Every test below is paired at `vertexUnavailable: true|false|undefined` to
 * prove the flag is now provably irrelevant to the returned `provider`.
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

describe('vertexUnavailable is now irrelevant — unsupported language always forces Nova, never Vertex', () => {
  it.each([undefined, false, true])('vertexUnavailable=%p: unsupported language forces Nova with a distinct reason', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: v,
      nova: { enabled: true, identityAllowed: true, languageSupported: false, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.novaReady).toBe(false);
  });
});

describe('vertexUnavailable is now irrelevant — unsupported runtime always forces Nova, never Vertex', () => {
  it.each([undefined, false, true])('vertexUnavailable=%p: gcp-cloud-run runtime forces Nova with a distinct reason', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: v,
      nova: { enabled: true, identityAllowed: true, languageSupported: true, runtime: 'gcp-cloud-run' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.novaReady).toBe(false);
  });
});

describe('vertexUnavailable is now irrelevant — the default (no-request) path also always forces Nova', () => {
  it.each([undefined, false, true])('vertexUnavailable=%p: default path with unsupported language forces Nova, reports canary=false', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: v,
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

describe('VTID-03703/03723: EVERY gate forces through to Nova, none excepted, regardless of vertexUnavailable', () => {
  it.each([undefined, false, true])('vertexUnavailable=%p: Nova disabled, explicit request → forced onto Nova, never Vertex', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: v,
      nova: { enabled: false, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.novaReady).toBe(false);
  });

  it.each([undefined, false, true])('vertexUnavailable=%p: Nova disabled, default (no-request) path → forced onto Nova, never falls through to Vertex', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: v,
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

  it.each([undefined, false, true])('vertexUnavailable=%p: Nova disabled, no nova context at all → forced onto Nova blind, never Vertex', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: v,
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
  });

  it.each([undefined, false, true])('vertexUnavailable=%p: identity not allowlisted, explicit request → forced onto Nova — a dead Vertex outranks canary policy', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'nova_sonic',
      vertexUnavailable: v,
      nova: { enabled: true, identityAllowed: false, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.novaReady).toBe(false);
  });

  it.each([undefined, false, true])('vertexUnavailable=%p: identity not allowlisted, default (no-request) path → forced onto Nova, never falls through to Vertex', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: v,
      nova: { enabled: true, identityAllowed: false, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
  });

  it.each([undefined, false, true])('vertexUnavailable=%p: all gates pass normally → happy-path reason is unaffected', (v) => {
    const d = selectUpstreamProvider({
      ...base,
      vertexUnavailable: v,
      nova: { enabled: true, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_canary_allowlisted');
    expect(d.novaReady).toBe(true);
  });

  it.each([undefined, false, true])('vertexUnavailable=%p: ORB_LIVE_PROVIDER=vertex — the former emergency-rollback escape hatch — is ALSO forced off Vertex now', (v) => {
    // VTID-03723: this used to be the one deliberate operator action that
    // stayed pinned to Vertex regardless of vertexUnavailable. Vertex is not
    // a destination any more, so even the explicit "rollback to vertex"
    // request now resolves to Nova (or the cascade).
    const d = selectUpstreamProvider({
      ...base,
      envProviderOverride: 'vertex',
      vertexUnavailable: v,
      nova: { enabled: true, identityAllowed: true, languageSupported: true, runtime: 'aws-ecs' },
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('vertex_removed_forced_nova');
  });
});
