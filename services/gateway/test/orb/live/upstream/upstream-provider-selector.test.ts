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

  it('selector NEVER selects provider=livekit in L1 (the L1 pin)', () => {
    // Every viable LiveKit request path must still return provider='vertex'.
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
    }
  });
});
