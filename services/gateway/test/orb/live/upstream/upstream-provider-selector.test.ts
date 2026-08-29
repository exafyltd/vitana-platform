/**
 * L1 (VTID-02976) / L2.1 (VTID-02980) / VTID-03723 — pure-selector tests for
 * `selectUpstreamProvider`.
 *
 * The selector is a pure function — these tests never touch process.env,
 * Supabase, or OASIS. Every input is passed explicitly via the context bag.
 *
 * VTID-03723 — VERTEX IS REMOVED AS A DESTINATION, PERMANENTLY. This file
 * used to pin every degraded/default/invalid path to `provider: 'vertex'`.
 * That is exactly the defect that shipped: staging's `voice.active_provider`
 * row said `vertex`, so EVERY pre-login session short-circuited to the
 * (dead) Gemini live client before Nova or the cascade were ever consulted —
 * Polish and Portuguese got a correct-sounding per-language voice speaking
 * English for weeks. Every assertion below is rewritten to the new
 * contract: `provider` is NEVER `'vertex'`, no matter what is requested —
 * it resolves to `'nova_sonic'` (forced, when necessary) or `'cascaded'`
 * (when Nova cannot speak the session's language and the cascade covers it).
 *
 * Updated acceptance matrix:
 *   1. No signal anywhere → Nova (forced), reason `nova_forced_vertex_unavailable`.
 *   2. `ORB_LIVE_PROVIDER=vertex` → Nova (forced) or cascaded, reason
 *      `vertex_removed_forced_nova` / `vertex_removed_cascaded` — never vertex.
 *   3. `ORB_LIVE_PROVIDER=livekit` + creds present, no canary → Nova (forced),
 *      `livekitReady=true` preserved, error still names the would-have-been reason.
 *   4. `ORB_LIVE_PROVIDER=livekit` + creds missing → Nova (forced), error
 *      names the missing fields.
 *   5. `voice.active_provider=vertex` (env unset) → Nova canary evaluation
 *      ALWAYS resolves now (never falls through) — this is the literal fix
 *      for the reported bug.
 *   6. `voice.active_provider=livekit` (env unset) + creds → same as (3).
 *   7. `voice.active_provider=livekit` (env unset) + creds missing → same as (4).
 *   8. Env override still beats system_config.
 *   9. Unknown/garbage env value → `provider_invalid` reason kept, but
 *      provider is Nova/cascaded, never vertex.
 *  10. Whitespace + uppercase env values still normalize correctly.
 */

import {
  selectUpstreamProvider,
  type UpstreamSelectorContext,
} from '../../../../src/orb/live/upstream/upstream-provider-selector';

const FULL_LIVEKIT_CREDS = {
  url: 'wss://livekit.example',
  apiKey: 'ak_test',
  apiSecret: 'as_test',
};

function ctx(over: Partial<UpstreamSelectorContext> = {}): UpstreamSelectorContext {
  return {
    envProviderOverride: undefined,
    systemConfigActiveProvider: undefined,
    livekitCredentials: undefined,
    ...over,
  };
}

describe('L1 selectUpstreamProvider — pure selection policy (VTID-03723: no Vertex)', () => {
  it('1. default (no signal anywhere) → nova_sonic (forced), never vertex', () => {
    const d = selectUpstreamProvider(ctx());
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.requested).toBeNull();
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.livekitReady).toBe(false);
  });

  it('2. ORB_LIVE_PROVIDER=vertex → forced to nova_sonic, not vertex', () => {
    const d = selectUpstreamProvider(ctx({ envProviderOverride: 'vertex' }));
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBe('vertex');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.livekitReady).toBe(false);
  });

  it('3. ORB_LIVE_PROVIDER=livekit + creds present, canary off → forced to nova_sonic, livekitReady=true preserved', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.livekitReady).toBe(true);
    expect(d.error).toMatch(/canary gate/);
    expect(d.error).toMatch(/env_explicit_livekit/);
  });

  it('4. ORB_LIVE_PROVIDER=livekit + creds missing → forced to nova_sonic, error names missing fields', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: { url: 'wss://livekit.example' /* apiKey + apiSecret missing */ },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.livekitReady).toBe(false);
    expect(d.error).toMatch(/apiKey/);
    expect(d.error).toMatch(/apiSecret/);
  });

  it('5. voice.active_provider=vertex (env unset) → forced through Nova canary evaluation, never vertex (the literal reported bug)', () => {
    // This is the exact staging configuration that produced the incident:
    // `voice.active_provider='vertex'` used to short-circuit straight to a
    // dead Vertex connect before Nova/the cascade were ever consulted.
    const d = selectUpstreamProvider(ctx({ systemConfigActiveProvider: 'vertex' }));
    expect(d.provider).not.toBe('vertex');
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBeNull();
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
  });

  it('6. voice.active_provider=livekit (env unset) + creds → forced to nova_sonic, livekitReady=true', () => {
    const d = selectUpstreamProvider(
      ctx({
        systemConfigActiveProvider: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.livekitReady).toBe(true);
    expect(d.error).toMatch(/system_config_livekit/);
  });

  it('7. voice.active_provider=livekit (env unset) + creds missing → forced to nova_sonic', () => {
    const d = selectUpstreamProvider(
      ctx({
        systemConfigActiveProvider: 'livekit',
        livekitCredentials: {},
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.error).toMatch(/url/);
    expect(d.error).toMatch(/apiKey/);
    expect(d.error).toMatch(/apiSecret/);
  });

  it('8. env override still beats system_config (env=vertex vs sys=livekit) — both now resolve off Vertex', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'vertex',
        systemConfigActiveProvider: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBe('vertex');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.livekitReady).toBe(false);
  });

  it('9. unknown/garbage env value keeps provider_invalid reason, but forces off Vertex (BOOTSTRAP-NOVA-SONIC-VOICE / VTID-03723)', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'gemini-direct',
        systemConfigActiveProvider: 'vertex',
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('provider_invalid');
  });

  it('9b. unknown env value forces off Vertex regardless of system_config', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'mistral',
        // @ts-expect-error — testing runtime tolerance to bad input
        systemConfigActiveProvider: 'openai',
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBeNull();
    expect(d.reason).toBe('provider_invalid');
  });

  it('10. whitespace + uppercase env values normalize, and still never resolve to vertex', () => {
    const d1 = selectUpstreamProvider(ctx({ envProviderOverride: '  VERTEX  ' }));
    expect(d1.provider).toBe('nova_sonic');
    expect(d1.reason).toBe('vertex_removed_forced_nova');
    const d2 = selectUpstreamProvider(
      ctx({
        envProviderOverride: ' LiveKit\n',
        livekitCredentials: FULL_LIVEKIT_CREDS,
      }),
    );
    expect(d2.requested).toBe('livekit');
    expect(d2.provider).toBe('nova_sonic');
    expect(d2.reason).toBe('vertex_removed_forced_nova');
  });

  it('selector NEVER throws on malformed input', () => {
    expect(() =>
      selectUpstreamProvider(
        ctx({
          // @ts-expect-error — testing runtime tolerance
          envProviderOverride: null,
          // @ts-expect-error — testing runtime tolerance
          systemConfigActiveProvider: 42,
          // @ts-expect-error — testing runtime tolerance
          livekitCredentials: 'not-an-object',
        }),
      ),
    ).not.toThrow();
  });

  it('selector NEVER selects provider=livekit in L1 (the L1 pin, canary OFF) — and never vertex either', () => {
    // Every viable LiveKit request path without canary configuration must
    // still avoid `provider: 'livekit'`. Post-VTID-03723 the L1 pin no
    // longer lands on Vertex — it lands on Nova (or the cascade) instead.
    const decisions = [
      selectUpstreamProvider(
        ctx({ envProviderOverride: 'livekit', livekitCredentials: FULL_LIVEKIT_CREDS }),
      ),
      selectUpstreamProvider(
        ctx({
          systemConfigActiveProvider: 'livekit',
          livekitCredentials: FULL_LIVEKIT_CREDS,
        }),
      ),
      selectUpstreamProvider(ctx({ envProviderOverride: 'livekit' })),
      selectUpstreamProvider(ctx({ systemConfigActiveProvider: 'livekit' })),
    ];
    for (const d of decisions) {
      expect(d.provider).not.toBe('livekit');
      expect(d.provider).not.toBe('vertex');
      expect(d.provider).toBe('nova_sonic');
      expect(d.canary).toBe(false);
    }
  });
});

// ============================================================================
// L2.1 (VTID-02980) — canary gate selection, updated for VTID-03723
// ============================================================================

describe('L2.1 selectUpstreamProvider — canary gate (VTID-03723: degraded paths no longer land on Vertex)', () => {
  const TENANT_A = '11111111-aaaa-aaaa-aaaa-111111111111';
  const TENANT_B = '22222222-bbbb-bbbb-bbbb-222222222222';
  const USER_A = '33333333-cccc-cccc-cccc-333333333333';
  const USER_B = '44444444-dddd-dddd-dddd-444444444444';

  it('C1. canary disabled + livekit env + creds → forced to nova_sonic (L1 pin no longer lands on Vertex)', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: false, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.livekitReady).toBe(true);
    expect(d.canary).toBe(false);
  });

  it('C2. canary enabled + identity matches allowlist (tenant) → provider=livekit (unchanged)', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A, userId: USER_B },
      }),
    );
    expect(d.provider).toBe('livekit');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('canary_selected_livekit');
    expect(d.livekitReady).toBe(true);
    expect(d.canary).toBe(true);
    expect(d.error).toBeUndefined();
  });

  it('C3. canary enabled + identity matches allowlist (user) → provider=livekit (unchanged)', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedUsers: [USER_A] },
        identity: { tenantId: TENANT_B, userId: USER_A },
      }),
    );
    expect(d.provider).toBe('livekit');
    expect(d.reason).toBe('canary_selected_livekit');
    expect(d.canary).toBe(true);
  });

  it('C4. canary enabled + identity NOT in allowlist → forced to nova_sonic, canary flag stays true', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [TENANT_A], allowedUsers: [USER_A] },
        identity: { tenantId: TENANT_B, userId: USER_B },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.canary).toBe(true);
    expect(d.error).toMatch(/not in the canary allowlist/);
  });

  it('C5. canary enabled + no identity at all → forced to nova_sonic, canary flag stays true', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: null, userId: null },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.canary).toBe(true);
  });

  it('C6. canary enabled + livekit creds INVALID → forced to nova_sonic, canary flag false (config invalidity beats canary)', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: { url: 'wss://x' /* apiKey + apiSecret missing */ },
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.canary).toBe(false);
    expect(d.error).toMatch(/apiKey/);
  });

  it('C7. canary enabled + no LiveKit request anywhere → forced to nova_sonic, NOT canary', () => {
    const d = selectUpstreamProvider(
      ctx({
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
    expect(d.canary).toBe(false);
  });

  it('C8. system_config=livekit + canary allowlist match → canary_selected_livekit (unchanged)', () => {
    const d = selectUpstreamProvider(
      ctx({
        systemConfigActiveProvider: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedUsers: [USER_A] },
        identity: { userId: USER_A },
      }),
    );
    expect(d.provider).toBe('livekit');
    expect(d.reason).toBe('canary_selected_livekit');
  });

  it('C9. env=vertex still never reaches the LiveKit canary — but no longer lands on Vertex either', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'vertex',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('livekit');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.canary).toBe(false);
  });

  it('C10. canary enabled but empty allowlist → forced to nova_sonic, canary flag true', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [], allowedUsers: [] },
        identity: { tenantId: TENANT_A, userId: USER_A },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.canary).toBe(true);
  });

  it('C11. canary still NEVER throws on malformed canary input', () => {
    expect(() =>
      selectUpstreamProvider(
        ctx({
          envProviderOverride: 'livekit',
          livekitCredentials: FULL_LIVEKIT_CREDS,
          // @ts-expect-error — testing runtime tolerance
          canary: { enabled: 'yes', allowedTenants: 'tenant-a' },
          // @ts-expect-error — testing runtime tolerance
          identity: 'identity-string',
        }),
      ),
    ).not.toThrow();
  });
});

// BOOTSTRAP-NOVA-SONIC-VOICE (Task 5) — Nova decision-table precedence,
// updated for VTID-03723 (Vertex removed as a destination).
describe('Nova 2 Sonic selection (BOOTSTRAP-NOVA-SONIC-VOICE / VTID-03723)', () => {
  const novaAllPass = {
    enabled: true,
    identityAllowed: true,
    languageSupported: true,
    runtime: 'aws-ecs' as const,
  };
  const identity = { userId: 'user-1', tenantId: 'tenant-1' };

  it('1. ORB_LIVE_PROVIDER=vertex no longer routes to Vertex — forced to Nova even with a healthy Nova canary available', () => {
    const d = selectUpstreamProvider({
      envProviderOverride: 'vertex',
      nova: novaAllPass,
      identity,
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('vertex_removed_forced_nova');
    expect(d.novaReady).toBe(true);
  });

  it('2. explicit nova_sonic selects Nova only when every gate passes (unchanged)', () => {
    const d = selectUpstreamProvider({
      envProviderOverride: 'nova_sonic',
      nova: novaAllPass,
      identity,
    });
    expect(d).toEqual(expect.objectContaining({
      provider: 'nova_sonic',
      requested: 'nova_sonic',
      reason: 'env_explicit_nova_sonic',
      novaReady: true,
      canary: true,
    }));
  });

  it('3. enabled allowlisted canary lifts a shared vertex DB flag (unchanged)', () => {
    const d = selectUpstreamProvider({
      envProviderOverride: undefined,
      systemConfigActiveProvider: 'vertex',
      nova: novaAllPass,
      identity,
    });
    expect(d).toEqual(expect.objectContaining({
      provider: 'nova_sonic',
      reason: 'nova_canary_allowlisted',
      canary: true,
      novaReady: true,
    }));
  });

  it('3b. canary also lifts the pure default (no signals at all) (unchanged)', () => {
    const d = selectUpstreamProvider({ nova: novaAllPass, identity });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_canary_allowlisted');
  });

  it('4. every previously-vertex-degrading gate now forces through to Nova instead of pinning to Vertex', () => {
    expect(selectUpstreamProvider({
      envProviderOverride: 'nova_sonic',
      nova: { ...novaAllPass, enabled: false },
      identity,
    })).toEqual(expect.objectContaining({ provider: 'nova_sonic', reason: 'nova_forced_vertex_unavailable' }));

    expect(selectUpstreamProvider({
      envProviderOverride: 'nova_sonic',
      nova: { ...novaAllPass, languageSupported: false },
      identity,
    })).toEqual(expect.objectContaining({ provider: 'nova_sonic', reason: 'nova_forced_vertex_unavailable' }));

    expect(selectUpstreamProvider({
      envProviderOverride: 'nova_sonic',
      nova: { ...novaAllPass, identityAllowed: false },
      identity,
    })).toEqual(expect.objectContaining({ provider: 'nova_sonic', reason: 'nova_forced_vertex_unavailable', canary: true }));

    expect(selectUpstreamProvider({
      envProviderOverride: 'nova_sonic',
      nova: { ...novaAllPass, runtime: 'gcp-cloud-run' },
      identity,
    })).toEqual(expect.objectContaining({ provider: 'nova_sonic', reason: 'nova_forced_vertex_unavailable' }));

    expect(selectUpstreamProvider({
      envProviderOverride: 'nova_sonic',
      identity,
    })).toEqual(expect.objectContaining({ provider: 'nova_sonic', reason: 'nova_forced_vertex_unavailable' }));
  });

  it('4b. failed canary gates now force through to Nova instead of silently falling through to a vertex reason', () => {
    // This is the OLD behavior this test used to pin: `evaluateNovaCanary`
    // returned `null` here, and the caller silently fell through to its own
    // `system_config_vertex` / `default` reason — landing on Vertex. That
    // fallthrough is exactly the shape of the reported incident, so
    // VTID-03723 removed it: `evaluateNovaCanary` now always resolves.
    expect(selectUpstreamProvider({
      systemConfigActiveProvider: 'vertex',
      nova: { ...novaAllPass, identityAllowed: false },
      identity,
    })).toEqual(expect.objectContaining({ provider: 'nova_sonic', reason: 'nova_forced_vertex_unavailable' }));

    expect(selectUpstreamProvider({
      nova: { ...novaAllPass, languageSupported: false },
      identity,
    })).toEqual(expect.objectContaining({ provider: 'nova_sonic', reason: 'nova_forced_vertex_unavailable' }));

    expect(selectUpstreamProvider({
      nova: { ...novaAllPass, runtime: 'gcp-cloud-run' },
      identity,
    })).toEqual(expect.objectContaining({ provider: 'nova_sonic', reason: 'nova_forced_vertex_unavailable' }));
  });

  it('5. LiveKit selection behavior is unchanged by the Nova context', () => {
    const d = selectUpstreamProvider({
      envProviderOverride: 'livekit',
      livekitCredentials: { url: 'wss://x', apiKey: 'k', apiSecret: 's' },
      canary: { enabled: true, allowedUsers: ['user-1'] },
      nova: novaAllPass,
      identity,
    });
    expect(d.provider).toBe('livekit');
    expect(d.reason).toBe('canary_selected_livekit');
  });

  it('6. unknown provider strings keep provider_invalid but no longer pin to Vertex', () => {
    const d = selectUpstreamProvider({
      envProviderOverride: 'novasonic',
      nova: novaAllPass,
      identity,
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('provider_invalid');
    expect(d.error).toBeTruthy();
  });

  it('system_config nova_sonic routes through the same explicit gate (unchanged)', () => {
    const d = selectUpstreamProvider({
      systemConfigActiveProvider: 'nova_sonic',
      nova: novaAllPass,
      identity,
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('system_config_nova_sonic');
  });
});

// ============================================================================
// VTID-03723 — the direct regression tests for the reported incident and the
// standing invariant it establishes: `selectUpstreamProvider` must NEVER
// return `provider: 'vertex'`, for any input.
// ============================================================================

describe('VTID-03723: Vertex is never a destination, and the cascade rescues Nova-unsupported languages', () => {
  const identity = { userId: 'user-1', tenantId: 'tenant-1' };
  const novaCantSpeakPolish = {
    enabled: true,
    identityAllowed: true,
    languageSupported: false, // pl is not in Nova's supported set
    runtime: 'aws-ecs' as const,
  };
  const cascadeCoversPolish = { enabled: true, languageSupported: true };

  it('reproduces the exact reported staging configuration: active_provider=vertex + a Polish/Portuguese session → cascade, never Nova speaking English, never Vertex', () => {
    const d = selectUpstreamProvider({
      systemConfigActiveProvider: 'vertex',
      nova: novaCantSpeakPolish,
      cascade: cascadeCoversPolish,
      identity,
    });
    expect(d.provider).toBe('cascaded');
    expect(d.provider).not.toBe('vertex');
    expect(d.provider).not.toBe('nova_sonic'); // never forces Polish onto Nova when the cascade covers it
    expect(d.reason).toBe('cascaded_language_rescue');
  });

  it('the same configuration WITHOUT the cascade enabled forces Nova rather than falling back to Vertex', () => {
    const d = selectUpstreamProvider({
      systemConfigActiveProvider: 'vertex',
      nova: novaCantSpeakPolish,
      cascade: { enabled: false, languageSupported: true },
      identity,
    });
    expect(d.provider).toBe('nova_sonic');
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
  });

  it('invariant: across a broad matrix of contexts, provider is never vertex', () => {
    const contexts: UpstreamSelectorContext[] = [
      {},
      { envProviderOverride: 'vertex' },
      { envProviderOverride: 'livekit', livekitCredentials: FULL_LIVEKIT_CREDS },
      { envProviderOverride: 'nova_sonic' },
      { envProviderOverride: 'garbage-value' },
      { systemConfigActiveProvider: 'vertex' },
      { systemConfigActiveProvider: 'livekit', livekitCredentials: FULL_LIVEKIT_CREDS },
      { systemConfigActiveProvider: 'nova_sonic' },
      { systemConfigActiveProvider: 'vertex', nova: novaCantSpeakPolish },
      { systemConfigActiveProvider: 'vertex', nova: novaCantSpeakPolish, cascade: cascadeCoversPolish },
      {
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: ['x'] },
        identity: { tenantId: 'y' },
      },
      { vertexUnavailable: false },
      { vertexUnavailable: true },
    ];
    for (const c of contexts) {
      const d = selectUpstreamProvider(c);
      expect(d.provider).not.toBe('vertex');
    }
  });

  it('mutation guard: a hand-built decision confirms the test suite would catch a reintroduced vertex return', () => {
    // Not a real call — documents that `provider` is a closed union
    // including `'vertex'` at the type level, so ANY future regression
    // reintroducing a literal `provider: 'vertex'` return would need to be
    // caught by the invariant test above at runtime, since TypeScript alone
    // cannot forbid a valid union member from being returned.
    const decisionShapeIncludesVertex: 'vertex' | 'nova_sonic' | 'cascaded' | 'livekit' = 'vertex';
    expect(['vertex', 'nova_sonic', 'cascaded', 'livekit']).toContain(decisionShapeIncludesVertex);
  });
});
