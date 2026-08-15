/**
 * VTID-03641 — `selectUpstreamProvider`'s polly-only-language bypass.
 *
 * A session whose language has no native voice on Nova OR Vertex (pt/pl
 * today — see `needsPollyOnlyVoice`) must never resolve to `provider:
 * 'vertex'` when Nova is otherwise ready — that is exactly the silent
 * wrong-language-English bug this VTID exists to close. These tests pin the
 * new `nova.pollyOnlyLanguage` bypass and its `pollyOnly`/`nova_polly_only_voice`
 * reporting, without touching the existing acceptance matrix in
 * `upstream-provider-selector.test.ts`.
 */

import {
  selectUpstreamProvider,
  type UpstreamSelectorContext,
} from '../../../../src/orb/live/upstream/upstream-provider-selector';

function ctx(over: Partial<UpstreamSelectorContext> = {}): UpstreamSelectorContext {
  return {
    envProviderOverride: undefined,
    systemConfigActiveProvider: undefined,
    livekitCredentials: undefined,
    ...over,
  };
}

const READY_POLLY_ONLY_NOVA = {
  enabled: true,
  identityAllowed: true,
  languageSupported: false, // pt/pl are never in Nova's native canary set
  runtime: 'aws-ecs' as const,
  pollyOnlyLanguage: true,
};

describe('VTID-03641 selectUpstreamProvider — polly-only-language bypass', () => {
  it('selects Nova (not Vertex) for a polly-only-language session via the silent canary path', () => {
    const d = selectUpstreamProvider(ctx({ nova: READY_POLLY_ONLY_NOVA }));
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_polly_only_voice');
    expect(d.pollyOnly).toBe(true);
    expect(d.canary).toBe(true);
    expect(d.novaReady).toBe(true);
  });

  it('selects Nova via an explicit env override too', () => {
    const d = selectUpstreamProvider(
      ctx({ envProviderOverride: 'nova_sonic', nova: READY_POLLY_ONLY_NOVA }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_polly_only_voice');
    expect(d.pollyOnly).toBe(true);
  });

  it('selects Nova via an explicit system_config override too', () => {
    const d = selectUpstreamProvider(
      ctx({ systemConfigActiveProvider: 'nova_sonic', nova: READY_POLLY_ONLY_NOVA }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_polly_only_voice');
    expect(d.pollyOnly).toBe(true);
  });

  it('an ordinary in-canary-set session is UNAFFECTED — no pollyOnly flag, ordinary reason', () => {
    const d = selectUpstreamProvider(
      ctx({
        nova: { ...READY_POLLY_ONLY_NOVA, languageSupported: true, pollyOnlyLanguage: false },
      }),
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_canary_allowlisted');
    expect(d.pollyOnly).toBeUndefined();
  });

  it('still degrades to Vertex when Nova is disabled, even for a polly-only language', () => {
    // The selector itself stays pure and never special-cases "refuse Vertex"
    // — that hard refusal is the CALLER's job (connectToLiveAPI in
    // orb-live.ts), because only the caller can fail the session start
    // loudly instead of silently degrading. This test pins the selector's
    // half: Nova being unavailable is still reported honestly.
    const d = selectUpstreamProvider(
      ctx({ nova: { ...READY_POLLY_ONLY_NOVA, enabled: false } }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('default');
  });

  it('still degrades to Vertex when identity is not allowlisted, even for a polly-only language', () => {
    const d = selectUpstreamProvider(
      ctx({ nova: { ...READY_POLLY_ONLY_NOVA, identityAllowed: false } }),
    );
    expect(d.provider).toBe('vertex');
  });

  it('still degrades to Vertex on the wrong runtime, even for a polly-only language', () => {
    const d = selectUpstreamProvider(
      ctx({ nova: { ...READY_POLLY_ONLY_NOVA, runtime: 'gcp-cloud-run' } }),
    );
    expect(d.provider).toBe('vertex');
  });

  it('an explicit Nova request still fails loudly (nova_not_allowlisted) when identity fails, not silently bypassed', () => {
    const d = selectUpstreamProvider(
      ctx({
        envProviderOverride: 'nova_sonic',
        nova: { ...READY_POLLY_ONLY_NOVA, identityAllowed: false },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('nova_not_allowlisted');
  });

  it('globally-promoted Nova reports pollyOnly + canary:true distinctly from an ordinary global session', () => {
    const global = selectUpstreamProvider(
      ctx({ nova: { ...READY_POLLY_ONLY_NOVA, globalEnabled: true } }),
    );
    // The polly-only reason takes priority over the global/canary label —
    // it is the more specific, more actionable fact about this decision.
    expect(global.reason).toBe('nova_polly_only_voice');
    expect(global.pollyOnly).toBe(true);
  });
});
