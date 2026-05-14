/**
 * L2.2a (VTID-02982 / orb-live-refactor): pure per-caller active-provider
 * resolution policy.
 *
 * Purpose
 * -------
 * The frontend ORB stack pivots between Vertex (gateway-proxied WS/SSE) and
 * LiveKit (frontend-driven WebRTC) by reading `GET /api/v1/orb/active-provider`.
 * Today that endpoint returns ONE tenant-wide flag — flipping it to `livekit`
 * sends every user onto LiveKit. That's incompatible with a narrow canary.
 *
 * This resolver makes the endpoint per-identity AND adds a hard safety pin:
 * even if a canary user is fully allowlisted AND LiveKit credentials are
 * valid, the effective provider stays `vertex` until the backend LiveKit
 * Agent is explicitly enabled (`voice.livekit_agent_enabled`). The agent
 * doesn't exist yet, so by construction NO caller can reach LiveKit through
 * this endpoint until the agent ships in L2.2b.
 *
 * Hard rule (from the L2.2a brief)
 * --------------------------------
 *   Do NOT make the frontend join an empty LiveKit room.
 *   Do NOT return effectiveProvider=livekit until the backend LiveKit Agent
 *   exists and is enabled.
 *
 * Selection rules
 * ---------------
 *   1. `globalActiveProvider === 'vertex'` → vertex (`default_vertex`).
 *   2. `globalActiveProvider === 'livekit'`:
 *        a. `!livekitCredsValid`        → vertex (`livekit_config_invalid`)
 *        b. `!canary.enabled`           → vertex (`canary_disabled`)
 *        c. identity not in allowlist   → vertex (`canary_not_allowlisted`)
 *        d. `!agentReady`               → vertex (`pinned_until_agent_ready`)
 *                                          [the L2.2a safety pin]
 *        e. ALL above pass              → LIVEKIT (`livekit_all_gates_pass`)
 *
 * The resolver is PURE — it never reads env, never queries DB, never emits
 * OASIS. The caller (the `/orb/active-provider` route) gathers inputs and
 * calls this function, then emits OASIS based on the returned reason.
 * NEVER throws.
 */

export type ActiveProviderName = 'vertex' | 'livekit';

export type ResolutionReason =
  | 'default_vertex'              // globalActiveProvider=vertex
  | 'canary_disabled'             // global=livekit but canary not enabled
  | 'canary_not_allowlisted'      // global=livekit + canary on + identity not in list
  | 'livekit_config_invalid'      // creds missing (URL / api key / api secret)
  | 'pinned_until_agent_ready'    // all canary gates pass BUT agent not enabled (L2.2a pin)
  | 'livekit_all_gates_pass';     // effective=livekit

export interface ResolverCanaryInput {
  enabled: boolean;
  allowedTenants?: ReadonlyArray<string>;
  allowedUsers?: ReadonlyArray<string>;
}

export interface ResolverContext {
  /** From `voice.active_provider` system_config. The tenant-wide intent. */
  globalActiveProvider: ActiveProviderName;
  /** From `livekit-canary-config.ts`. */
  canary: ResolverCanaryInput;
  /** Whether LIVEKIT_URL + LIVEKIT_API_KEY + LIVEKIT_API_SECRET are all non-empty. */
  livekitCredsValid: boolean;
  /** Backend LiveKit Agent is enabled (env `ORB_LIVEKIT_AGENT_ENABLED` or
   *  system_config `voice.livekit_agent_enabled`). Default `false` in L2.2a. */
  agentReady: boolean;
  /** Caller identity from `optionalAuth`. `null` for unauthenticated callers. */
  identity: { tenantId?: string | null; userId?: string | null } | null;
}

export interface ActiveProviderResolution {
  /** What the global `voice.active_provider` flag asked for. */
  requestedProvider: ActiveProviderName;
  /** What the caller should actually route to (legacy `active_provider` field). */
  effectiveProvider: ActiveProviderName;
  /** Creds present. */
  livekitReady: boolean;
  /** Canary enabled AND caller identity matches allowlist. */
  canaryEligible: boolean;
  /** Backend agent flipped on. */
  agentReady: boolean;
  /** Why `effectiveProvider` was chosen. */
  reason: ResolutionReason;
}

function isIdentityAllowlisted(
  canary: ResolverCanaryInput,
  identity: ResolverContext['identity'],
): boolean {
  if (!canary.enabled || !identity) return false;
  const tenants = canary.allowedTenants ?? [];
  const users = canary.allowedUsers ?? [];
  if (identity.tenantId && tenants.includes(identity.tenantId)) return true;
  if (identity.userId && users.includes(identity.userId)) return true;
  return false;
}

/**
 * Pure resolver. Never throws. Never reads env. Never queries DB.
 * The caller is responsible for emitting OASIS events based on the
 * returned reason.
 */
export function resolveActiveProviderForCaller(
  ctx: ResolverContext,
): ActiveProviderResolution {
  const requestedProvider: ActiveProviderName =
    ctx.globalActiveProvider === 'livekit' ? 'livekit' : 'vertex';
  const livekitReady = ctx.livekitCredsValid === true;
  const canaryEligible =
    ctx.canary?.enabled === true && isIdentityAllowlisted(ctx.canary, ctx.identity);
  const agentReady = ctx.agentReady === true;

  // Rule 1: global flag says vertex → vertex.
  if (requestedProvider === 'vertex') {
    return {
      requestedProvider,
      effectiveProvider: 'vertex',
      livekitReady,
      canaryEligible,
      agentReady,
      reason: 'default_vertex',
    };
  }

  // Rule 2: global flag says livekit — walk the gates in order. Earlier gates
  // beat later ones so the `reason` always names the FIRST gate that failed.

  // 2a. creds invalid
  if (!livekitReady) {
    return {
      requestedProvider,
      effectiveProvider: 'vertex',
      livekitReady,
      canaryEligible: false, // creds-invalid means the canary path was never
                             // reached; report eligibility false to avoid
                             // surfacing "you're allowlisted!" when the path
                             // is structurally broken.
      agentReady,
      reason: 'livekit_config_invalid',
    };
  }

  // 2b. canary not enabled
  if (ctx.canary?.enabled !== true) {
    return {
      requestedProvider,
      effectiveProvider: 'vertex',
      livekitReady,
      canaryEligible: false,
      agentReady,
      reason: 'canary_disabled',
    };
  }

  // 2c. canary enabled but identity not in allowlist
  if (!canaryEligible) {
    return {
      requestedProvider,
      effectiveProvider: 'vertex',
      livekitReady,
      canaryEligible: false,
      agentReady,
      reason: 'canary_not_allowlisted',
    };
  }

  // 2d. L2.2a safety pin: all canary gates pass BUT agent not yet enabled.
  // This is the no-empty-room invariant.
  if (!agentReady) {
    return {
      requestedProvider,
      effectiveProvider: 'vertex',
      livekitReady,
      canaryEligible: true,
      agentReady: false,
      reason: 'pinned_until_agent_ready',
    };
  }

  // 2e. All gates pass.
  return {
    requestedProvider,
    effectiveProvider: 'livekit',
    livekitReady: true,
    canaryEligible: true,
    agentReady: true,
    reason: 'livekit_all_gates_pass',
  };
}
