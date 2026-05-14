/**
 * L2.2a (VTID-02982): pure-resolver tests for `resolveActiveProviderForCaller`.
 *
 * The resolver is pure — these tests never touch process.env, Supabase, or
 * OASIS. Every input is passed explicitly via the context bag.
 *
 * Acceptance matrix (the gate stack walked top-down):
 *   1. global=vertex → vertex/`default_vertex` (no canary fields consulted).
 *   2. global=livekit + creds invalid → vertex/`livekit_config_invalid`.
 *   3. global=livekit + creds + canary disabled → vertex/`canary_disabled`.
 *   4. global=livekit + creds + canary enabled + identity not in allowlist
 *      → vertex/`canary_not_allowlisted`.
 *   5. global=livekit + creds + canary on + identity matched + agent OFF
 *      → vertex/`pinned_until_agent_ready` (the L2.2a safety pin).
 *   6. global=livekit + all gates pass + agent ON → LIVEKIT/`livekit_all_gates_pass`.
 *
 * The resolver NEVER throws.
 */

import {
  resolveActiveProviderForCaller,
  type ResolverContext,
} from '../../../../src/orb/live/upstream/active-provider-resolver';

const TENANT_A = '11111111-aaaa-aaaa-aaaa-111111111111';
const TENANT_B = '22222222-bbbb-bbbb-bbbb-222222222222';
const USER_A = '33333333-cccc-cccc-cccc-333333333333';
const USER_B = '44444444-dddd-dddd-dddd-444444444444';

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    globalActiveProvider: 'vertex',
    canary: { enabled: false },
    livekitCredsValid: false,
    agentReady: false,
    identity: null,
    ...over,
  };
}

describe('L2.2a resolveActiveProviderForCaller — pure resolution policy', () => {
  it('1. global=vertex → vertex/default_vertex (other fields irrelevant)', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'vertex',
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        livekitCredsValid: true,
        agentReady: true,
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
    expect(d.requestedProvider).toBe('vertex');
    expect(d.reason).toBe('default_vertex');
  });

  it('2. global=livekit + creds invalid → vertex/livekit_config_invalid (beats canary)', () => {
    // Even a perfectly allowlisted canary user with agent ready cannot
    // route past invalid LiveKit creds.
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: false,
        canary: { enabled: true, allowedUsers: [USER_A] },
        agentReady: true,
        identity: { userId: USER_A },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
    expect(d.reason).toBe('livekit_config_invalid');
    expect(d.canaryEligible).toBe(false);
    expect(d.livekitReady).toBe(false);
  });

  it('3. global=livekit + creds + canary disabled → vertex/canary_disabled', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: true,
        canary: { enabled: false, allowedTenants: [TENANT_A] },
        agentReady: true,
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
    expect(d.reason).toBe('canary_disabled');
    expect(d.canaryEligible).toBe(false);
    expect(d.livekitReady).toBe(true);
  });

  it('4. global=livekit + creds + canary on + identity NOT in allowlist → vertex/canary_not_allowlisted', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: true,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        agentReady: true,
        identity: { tenantId: TENANT_B, userId: USER_B },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
    expect(d.reason).toBe('canary_not_allowlisted');
    expect(d.canaryEligible).toBe(false);
  });

  it('4b. global=livekit + creds + canary on + no identity → vertex/canary_not_allowlisted', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: true,
        canary: { enabled: true, allowedUsers: [USER_A] },
        agentReady: true,
        identity: null,
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
    expect(d.reason).toBe('canary_not_allowlisted');
    expect(d.canaryEligible).toBe(false);
  });

  it('5. global=livekit + creds + canary on + matched + agent OFF → vertex/pinned_until_agent_ready (L2.2a safety pin)', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: true,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        agentReady: false, // ← the pin
        identity: { tenantId: TENANT_A, userId: USER_B },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
    expect(d.reason).toBe('pinned_until_agent_ready');
    expect(d.canaryEligible).toBe(true);
    expect(d.livekitReady).toBe(true);
    expect(d.agentReady).toBe(false);
  });

  it('5b. same as 5 but match via allowedUsers → still pinned_until_agent_ready', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: true,
        canary: { enabled: true, allowedUsers: [USER_A] },
        agentReady: false,
        identity: { tenantId: TENANT_B, userId: USER_A },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
    expect(d.reason).toBe('pinned_until_agent_ready');
    expect(d.canaryEligible).toBe(true);
  });

  it('6. global=livekit + ALL gates pass + agent ON → LIVEKIT/livekit_all_gates_pass', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: true,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        agentReady: true,
        identity: { tenantId: TENANT_A },
      }),
    );
    expect(d.effectiveProvider).toBe('livekit');
    expect(d.requestedProvider).toBe('livekit');
    expect(d.reason).toBe('livekit_all_gates_pass');
    expect(d.livekitReady).toBe(true);
    expect(d.canaryEligible).toBe(true);
    expect(d.agentReady).toBe(true);
  });

  // ----- L2.2a hard invariants -----

  it('invariant: NEVER returns effectiveProvider=livekit when agentReady=false', () => {
    // Sweep every conceivable input combination with agentReady=false and
    // assert effectiveProvider stays vertex.
    const cases: ResolverContext[] = [];
    for (const global of ['vertex', 'livekit'] as const) {
      for (const creds of [true, false]) {
        for (const canEn of [true, false]) {
          for (const idMatch of [true, false]) {
            cases.push({
              globalActiveProvider: global,
              livekitCredsValid: creds,
              canary: { enabled: canEn, allowedTenants: [TENANT_A] },
              agentReady: false, // ← the safety pin
              identity: idMatch ? { tenantId: TENANT_A } : { tenantId: TENANT_B },
            });
          }
        }
      }
    }
    for (const c of cases) {
      expect(resolveActiveProviderForCaller(c).effectiveProvider).toBe('vertex');
    }
  });

  it('invariant: NEVER returns effectiveProvider=livekit when canary disabled', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: true,
        canary: { enabled: false, allowedTenants: [TENANT_A], allowedUsers: [USER_A] },
        agentReady: true,
        identity: { tenantId: TENANT_A, userId: USER_A },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
  });

  it('invariant: NEVER returns effectiveProvider=livekit when identity unmatched', () => {
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'livekit',
        livekitCredsValid: true,
        canary: { enabled: true, allowedTenants: [TENANT_A] },
        agentReady: true,
        identity: { tenantId: TENANT_B },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
  });

  it('rollback: flipping global=vertex bypasses ALL canary/agent gates → default_vertex', () => {
    // The "Vertex rollback as a config-only switch" guarantee. Even if
    // every other knob says "go LiveKit," flipping the global flag to
    // vertex restores the old path with no code change.
    const d = resolveActiveProviderForCaller(
      ctx({
        globalActiveProvider: 'vertex',
        livekitCredsValid: true,
        canary: { enabled: true, allowedTenants: [TENANT_A], allowedUsers: [USER_A] },
        agentReady: true,
        identity: { tenantId: TENANT_A, userId: USER_A },
      }),
    );
    expect(d.effectiveProvider).toBe('vertex');
    expect(d.reason).toBe('default_vertex');
  });

  it('resolver NEVER throws on malformed input', () => {
    expect(() =>
      resolveActiveProviderForCaller(
        ctx({
          // @ts-expect-error — testing runtime tolerance
          globalActiveProvider: 'openai',
          // @ts-expect-error — testing runtime tolerance
          canary: 'not-an-object',
          // @ts-expect-error — testing runtime tolerance
          livekitCredsValid: 'yes',
          // @ts-expect-error — testing runtime tolerance
          agentReady: 'sure',
          // @ts-expect-error — testing runtime tolerance
          identity: 42,
        }),
      ),
    ).not.toThrow();
  });

  it('rollback path 2: flipping agentReady false also restores everyone to vertex', () => {
    // L2.2a is the safety: if the agent service breaks, ops flips
    // `voice.livekit_agent_enabled=false` and every canary user flows
    // back through Vertex on next /orb/active-provider refresh.
    const baseCanaryCtx: ResolverContext = ctx({
      globalActiveProvider: 'livekit',
      livekitCredsValid: true,
      canary: { enabled: true, allowedTenants: [TENANT_A] },
      identity: { tenantId: TENANT_A },
    });
    const withAgent = resolveActiveProviderForCaller({ ...baseCanaryCtx, agentReady: true });
    const withoutAgent = resolveActiveProviderForCaller({ ...baseCanaryCtx, agentReady: false });
    expect(withAgent.effectiveProvider).toBe('livekit');
    expect(withoutAgent.effectiveProvider).toBe('vertex');
    expect(withoutAgent.reason).toBe('pinned_until_agent_ready');
  });
});
