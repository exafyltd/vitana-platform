/**
 * L1 (VTID-02976): pure-selector tests for `selectUpstreamProvider`.
 *
 * The selector is a pure function — these tests never touch process.env,
 * Supabase, or OASIS. Every input is passed explicitly via the context bag.
 *
 * Acceptance matrix:
 *   1. Default (no signal anywhere) → Vertex, reason=`default`.
 *   2. `ORB_LIVE_PROVIDER=vertex` → Vertex, reason=`env_explicit_vertex`.
 *   3. `ORB_LIVE_PROVIDER=livekit` + creds present → Vertex (pinned),
 *      reason=`pinned_to_vertex_l1`, livekitReady=true, error populated.
 *   4. `ORB_LIVE_PROVIDER=livekit` + creds missing → Vertex, reason=
 *      `livekit_config_invalid`, error names the missing fields.
 *   5. `voice.active_provider=vertex` (env unset) → Vertex, reason=
 *      `system_config_vertex`.
 *   6. `voice.active_provider=livekit` (env unset) + creds → Vertex pinned,
 *      reason=`pinned_to_vertex_l1`, livekitReady=true.
 *   7. `voice.active_provider=livekit` (env unset) + creds missing → Vertex,
 *      reason=`livekit_config_invalid`.
 *   8. Env override beats system_config (env=vertex vs sys=livekit).
 *   9. Unknown/garbage env value → falls through to system_config logic.
 *  10. Whitespace + uppercase env values normalize correctly.
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

describe('L1 selectUpstreamProvider — pure selection policy', () => {
  it('1. default (no signal anywhere) → vertex/default', () => {
    const d = selectUpstreamProvider(ctx());
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBeNull();
    expect(d.reason).toBe('default');
    expect(d.livekitReady).toBe(false);
    expect(d.error).toBeUndefined();
  });

  it('2. ORB_LIVE_PROVIDER=vertex → vertex/env_explicit_vertex', () => {
    const d = selectUpstreamProvider(ctx({ envProviderOverride: 'vertex' }));
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('vertex');
    expect(d.reason).toBe('env_explicit_vertex');
    expect(d.livekitReady).toBe(false);
  });

  it('3. ORB_LIVE_PROVIDER=livekit + creds present → vertex (pinned), livekitReady=true', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('pinned_to_vertex_l1');
    expect(d.livekitReady).toBe(true);
    expect(d.error).toMatch(/pinning to Vertex/);
    expect(d.error).toMatch(/env_explicit_livekit/);
  });

  it('4. ORB_LIVE_PROVIDER=livekit + creds missing → vertex/livekit_config_invalid', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: { url: 'wss://livekit.example' /* apiKey + apiSecret missing */ },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('livekit_config_invalid');
    expect(d.livekitReady).toBe(false);
    expect(d.error).toMatch(/apiKey/);
    expect(d.error).toMatch(/apiSecret/);
  });

  it('5. voice.active_provider=vertex (env unset) → vertex/system_config_vertex', () => {
    const d = selectUpstreamProvider(ctx({ systemConfigActiveProvider: 'vertex' }));
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('vertex');
    expect(d.reason).toBe('system_config_vertex');
  });

  it('6. voice.active_provider=livekit (env unset) + creds → vertex (pinned), livekitReady=true', () => {
    const d = selectUpstreamProvider(
      ctx({
        systemConfigActiveProvider: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('pinned_to_vertex_l1');
    expect(d.livekitReady).toBe(true);
    expect(d.error).toMatch(/system_config_livekit/);
  });

  it('7. voice.active_provider=livekit (env unset) + creds missing → vertex/livekit_config_invalid', () => {
    const d = selectUpstreamProvider(
      ctx({
        systemConfigActiveProvider: 'livekit',
        livekitCredentials: {},
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('livekit_config_invalid');
    expect(d.error).toMatch(/url/);
    expect(d.error).toMatch(/apiKey/);
    expect(d.error).toMatch(/apiSecret/);
  });

  it('8. env override beats system_config (env=vertex vs sys=livekit)', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'vertex',
        systemConfigActiveProvider: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('vertex');
    expect(d.reason).toBe('env_explicit_vertex');
    expect(d.livekitReady).toBe(false);
  });

  it('9. unknown/garbage env value falls through to system_config', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'gemini-direct',
        systemConfigActiveProvider: 'vertex',
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('system_config_vertex');
  });

  it('9b. unknown env + unknown system_config → default', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'mistral',
        // @ts-expect-error — testing runtime tolerance to bad input
        systemConfigActiveProvider: 'openai',
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBeNull();
    expect(d.reason).toBe('default');
  });

  it('10. whitespace + uppercase env values normalize', () => {
    const d1 = selectUpstreamProvider(ctx({ envProviderOverride: '  VERTEX  ' }));
    expect(d1.reason).toBe('env_explicit_vertex');
    const d2 = selectUpstreamProvider(
      ctx({
        envProviderOverride: ' LiveKit\n',
        livekitCredentials: FULL_LIVEKIT_CREDS,
      }),
    );
    expect(d2.requested).toBe('livekit');
    expect(d2.reason).toBe('pinned_to_vertex_l1');
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

  it('selector NEVER selects provider=livekit in L1 (the L1 pin, canary OFF)', () => {
    // Every viable LiveKit request path must still return provider='vertex'
    // when no canary configuration is supplied. L2.1 keeps this invariant
    // for non-canary callers; only the canary gate can unlock LiveKit.
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
      expect(d.provider).toBe('vertex');
      expect(d.canary).toBe(false);
    }
  });
});

// ============================================================================
// L2.1 (VTID-02980) — canary gate selection
// ============================================================================

describe('L2.1 selectUpstreamProvider — canary gate', () => {
  const TENANT_A = '11111111-aaaa-aaaa-aaaa-111111111111';
  const TENANT_B = '22222222-bbbb-bbbb-bbbb-222222222222';
  const USER_A = '33333333-cccc-cccc-cccc-333333333333';
  const USER_B = '44444444-dddd-dddd-dddd-444444444444';

  it('C1. canary disabled + livekit env + creds → pinned_to_vertex_l1 (L1 pin unchanged)', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: false, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('pinned_to_vertex_l1');
    expect(d.livekitReady).toBe(true);
    expect(d.canary).toBe(false);
  });

  it('C2. canary enabled + identity matches allowlist (tenant) → provider=livekit', () => {
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

  it('C3. canary enabled + identity matches allowlist (user) → provider=livekit', () => {
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

  it('C4. canary enabled + identity NOT in allowlist → canary_not_allowlisted', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [TENANT_A], allowedUsers: [USER_A] },
        identity: { tenantId: TENANT_B, userId: USER_B },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.requested).toBe('livekit');
    expect(d.reason).toBe('canary_not_allowlisted');
    expect(d.livekitReady).toBe(false);
    expect(d.canary).toBe(true);
    expect(d.error).toMatch(/not in the canary allowlist/);
  });

  it('C5. canary enabled + no identity at all → canary_not_allowlisted', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: null, userId: null },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('canary_not_allowlisted');
    expect(d.canary).toBe(true);
  });

  it('C6. canary enabled + livekit creds INVALID → livekit_config_invalid (NOT canary)', () => {
    // Config invalidity must beat the canary path — a canary user with
    // missing creds gets the same `livekit_config_invalid` reason as
    // anyone else, and the canary flag stays false.
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: { url: 'wss://x' /* apiKey + apiSecret missing */ },
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('livekit_config_invalid');
    expect(d.canary).toBe(false);
    expect(d.error).toMatch(/apiKey/);
  });

  it('C7. canary enabled + no LiveKit request anywhere → default, NOT canary', () => {
    // If nothing requests LiveKit, the canary gate is irrelevant — the
    // selector returns the unchanged default path.
    const d = selectUpstreamProvider(
      ctx({
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('default');
    expect(d.canary).toBe(false);
  });

  it('C8. system_config=livekit + canary allowlist match → canary_selected_livekit', () => {
    // The canary gate works for the system_config path too, not just env.
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

  it('C9. env=vertex never reaches the canary gate (Vertex stays the rollback)', () => {
    // Explicit ORB_LIVE_PROVIDER=vertex is the rollback path: it must
    // NEVER reach the canary even with a perfectly allowlisted identity.
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'vertex',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('env_explicit_vertex');
    expect(d.canary).toBe(false);
  });

  it('C10. canary enabled but empty allowlist → no identity ever matches → canary_not_allowlisted', () => {
    // Clearing the allowlist while keeping `enabled=true` is a valid
    // "pause without disabling" state. Every LiveKit request degrades
    // to canary_not_allowlisted; rollback is one config change.
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'livekit',
        livekitCredentials: FULL_LIVEKIT_CREDS,
        canary: { enabled: true, allowedTenants: [], allowedUsers: [] },
        identity: { tenantId: TENANT_A, userId: USER_A },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('canary_not_allowlisted');
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
