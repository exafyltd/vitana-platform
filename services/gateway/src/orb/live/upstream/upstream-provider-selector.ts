/**
 * L1 (VTID-02976) / L2.1 (VTID-02980 / orb-live-refactor): pure
 * provider-selection policy for the ORB upstream live client.
 *
 * Inputs:
 *   - `ORB_LIVE_PROVIDER` env (highest priority override): `'vertex' | 'livekit' | ''`
 *   - `voice.active_provider` system_config row: `'vertex' | 'livekit'`
 *   - LiveKit credentials in env: `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
 *     `LIVEKIT_API_SECRET`
 *   - L2.1 canary inputs:
 *       - `canary.enabled` (env `ORB_LIVEKIT_CANARY_ENABLED` and/or system_config
 *         row `voice.livekit_canary_enabled`)
 *       - `canary.allowedTenants` / `canary.allowedUsers` (from system_config
 *         row `voice.livekit_canary_allowlist`)
 *       - `identity.tenantId` / `identity.userId` (from the session)
 *
 * Output (`UpstreamSelectionDecision`):
 *   - `provider` — the upstream client the consumer should USE. L1 pinned
 *     this to `'vertex'` unconditionally; L2.1 lifts the pin only inside the
 *     canary gate.
 *   - `requested` — what the caller asked for (or `null`).
 *   - `reason` — why `provider` was chosen.
 *   - `livekitReady` — whether all hard gates (creds + canary + allowlist)
 *     pass. Useful for operator-side rollout monitoring even when L2.1's
 *     consumer-side pin still routes traffic to Vertex.
 *   - `canary` — whether the canary path was active.
 *   - `error` — typed message when the LiveKit request was downgraded.
 *
 * Selection rules:
 *   1. If `ORB_LIVE_PROVIDER` is explicitly `'vertex'` → Vertex (reason
 *      `env_explicit_vertex`).
 *   2. If `ORB_LIVE_PROVIDER` is explicitly `'livekit'`:
 *        a. require `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
 *           If any missing → Vertex (reason `livekit_config_invalid`).
 *        b. L2.1 canary gate:
 *             i. if `canary.enabled === true` AND identity is in the
 *                allowlist → `provider: 'livekit'`, reason
 *                `canary_selected_livekit`.
 *            ii. if `canary.enabled === true` AND identity is NOT in the
 *                allowlist → Vertex, reason `canary_not_allowlisted`.
 *           iii. if `canary.enabled !== true` → Vertex, reason
 *                `pinned_to_vertex_l1` (the L1 cap).
 *   3. Else if `ORB_LIVE_PROVIDER` is unset, fall back to
 *      `voice.active_provider` system_config with the same gating logic
 *      (reason prefix `system_config` instead of `env_explicit`).
 *   4. No request signal anywhere → Vertex (reason `default`).
 *
 * The selector is PURE — it never reads env, never queries DB, never emits
 * OASIS. The caller supplies all inputs via the `UpstreamSelectorContext`
 * and emits OASIS events based on the returned decision. This keeps unit
 * tests trivial (no mocks of process.env / Supabase / OASIS).
 *
 * Hard rules:
 *   - LiveKit can ONLY reach `provider: 'livekit'` via the L2.1 canary gate
 *     (env+sysconfig request + creds + canary.enabled + identity allowlisted).
 *     Every other path still routes through `pinned_to_vertex_l1`.
 *   - Selection NEVER throws. Invalid inputs degrade to Vertex with a
 *     typed `error` field on the decision.
 */

export type UpstreamProviderName = 'vertex' | 'livekit';

export type SelectionReason =
  | 'default'                  // no override anywhere → vertex
  | 'env_explicit_vertex'      // ORB_LIVE_PROVIDER=vertex
  | 'env_explicit_livekit'     // ORB_LIVE_PROVIDER=livekit; would be livekit (but L1 pins, see below)
  | 'system_config_vertex'     // voice.active_provider=vertex (env unset)
  | 'system_config_livekit'    // voice.active_provider=livekit (env unset); would be livekit (but L1 pins)
  | 'livekit_config_invalid'   // livekit requested, creds missing → vertex
  | 'pinned_to_vertex_l1'      // livekit requested AND creds present AND canary disabled → vertex
  // L2.1 (VTID-02980): canary path. When all canary gates pass (env / creds /
  // canary.enabled / identity allowlisted), the selector returns
  // `provider='livekit'` with this reason — the L1 pin is lifted INSIDE
  // the canary scope only. Outside the canary scope the L1 pin still holds.
  | 'canary_selected_livekit'
  // L2.1: canary gate is on, LiveKit was requested, creds are valid, but
  // the calling identity is NOT in the canary allowlist. Pinned to vertex.
  | 'canary_not_allowlisted';

export interface CanarySelectorConfig {
  /** Master canary switch. False = full L1 pin regardless of allowlist. */
  enabled: boolean;
  /** Tenant IDs allowed onto the canary. Matched against `identity.tenantId`. */
  allowedTenants?: ReadonlyArray<string>;
  /** User IDs allowed onto the canary. Matched against `identity.userId`. */
  allowedUsers?: ReadonlyArray<string>;
}

export interface UpstreamSelectorContext {
  /** `process.env.ORB_LIVE_PROVIDER` — `'vertex' | 'livekit' | ''` (or unset). */
  envProviderOverride?: string;
  /** From `voice.active_provider` system_config row. `undefined` if unread. */
  systemConfigActiveProvider?: UpstreamProviderName;
  /** LiveKit creds — passed in explicitly so the selector stays pure. */
  livekitCredentials?: {
    url?: string;
    apiKey?: string;
    apiSecret?: string;
  };
  /**
   * L2.1: canary configuration. When `enabled: true` AND the calling
   * identity matches one of `allowedTenants` / `allowedUsers`, AND
   * LiveKit was requested AND creds are valid, the selector returns
   * `provider='livekit'` with `reason='canary_selected_livekit'`.
   *
   * Always optional. When unset or `enabled: false`, the L1 pin holds
   * for every LiveKit-requested session (existing reason
   * `pinned_to_vertex_l1`).
   */
  canary?: CanarySelectorConfig;
  /**
   * L2.1: identity of the session for canary matching. Either / both fields
   * may be unset (e.g. anonymous landing sessions); a session with no
   * identity can NEVER match the allowlist and is treated as
   * `canary_not_allowlisted`.
   */
  identity?: {
    tenantId?: string | null;
    userId?: string | null;
  };
}

export interface UpstreamSelectionDecision {
  /**
   * What the consumer should actually instantiate. Always `'vertex'`
   * unless the L2.1 canary path is active.
   */
  provider: UpstreamProviderName;
  /** What was requested. `null` if no override was provided. */
  requested: UpstreamProviderName | null;
  /** Why `provider` was chosen. Drives OASIS event payload. */
  reason: SelectionReason;
  /**
   * Whether all hard LiveKit gates (creds + canary + allowlist) pass.
   * True on `canary_selected_livekit`. False otherwise.
   *
   * Operators use this to see what the selector *would* return if the
   * L1 / consumer-side pins were removed.
   */
  livekitReady: boolean;
  /**
   * L2.1: whether the canary path was relevant to this decision (regardless
   * of whether identity matched). `true` for the three canary reasons:
   * `canary_selected_livekit`, `canary_not_allowlisted`, and the variant
   * of `pinned_to_vertex_l1` that arose because canary is configured but
   * disabled. False on all non-canary paths.
   */
  canary: boolean;
  /**
   * Typed error when the LiveKit path was requested but a gate failed.
   * Empty/undefined on the happy Vertex path and on `canary_selected_livekit`.
   */
  error?: string;
}

const LIVEKIT_CRED_FIELDS = ['url', 'apiKey', 'apiSecret'] as const;

function normalizeOverride(raw: string | undefined): UpstreamProviderName | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'vertex') return 'vertex';
  if (trimmed === 'livekit') return 'livekit';
  return null;
}

function livekitCredsMissing(
  creds: UpstreamSelectorContext['livekitCredentials'],
): string[] {
  const missing: string[] = [];
  const c = creds ?? {};
  for (const key of LIVEKIT_CRED_FIELDS) {
    const v = (c as Record<string, string | undefined>)[key];
    if (typeof v !== 'string' || v.length === 0) missing.push(key);
  }
  return missing;
}

function isIdentityAllowlisted(
  canary: CanarySelectorConfig | undefined,
  identity: UpstreamSelectorContext['identity'],
): boolean {
  if (!canary) return false;
  const tenants = canary.allowedTenants ?? [];
  const users = canary.allowedUsers ?? [];
  const tenantId = identity?.tenantId ?? null;
  const userId = identity?.userId ?? null;
  if (tenantId && tenants.includes(tenantId)) return true;
  if (userId && users.includes(userId)) return true;
  return false;
}

/**
 * Pure selector. Never throws. Never reads env. Never queries DB.
 * The caller is responsible for emitting an OASIS event based on the
 * returned decision (see `connectToLiveAPI`).
 */
export function selectUpstreamProvider(
  ctx: UpstreamSelectorContext,
): UpstreamSelectionDecision {
  const envChoice = normalizeOverride(ctx.envProviderOverride);
  const sysChoice =
    ctx.systemConfigActiveProvider === 'vertex' ||
    ctx.systemConfigActiveProvider === 'livekit'
      ? ctx.systemConfigActiveProvider
      : null;

  // Highest-priority signal: env override.
  if (envChoice === 'vertex') {
    return {
      provider: 'vertex',
      requested: 'vertex',
      reason: 'env_explicit_vertex',
      livekitReady: false,
      canary: false,
    };
  }
  if (envChoice === 'livekit') {
    return evaluateLiveKitRequest(ctx, 'livekit', 'env_explicit_livekit');
  }

  // Fallback: voice.active_provider system_config.
  if (sysChoice === 'vertex') {
    return {
      provider: 'vertex',
      requested: 'vertex',
      reason: 'system_config_vertex',
      livekitReady: false,
      canary: false,
    };
  }
  if (sysChoice === 'livekit') {
    return evaluateLiveKitRequest(ctx, 'livekit', 'system_config_livekit');
  }

  // Nothing requested → default.
  return {
    provider: 'vertex',
    requested: null,
    reason: 'default',
    livekitReady: false,
    canary: false,
  };
}

function evaluateLiveKitRequest(
  ctx: UpstreamSelectorContext,
  requested: UpstreamProviderName,
  happyReason: SelectionReason,
): UpstreamSelectionDecision {
  const missing = livekitCredsMissing(ctx.livekitCredentials);
  if (missing.length > 0) {
    return {
      provider: 'vertex',
      requested,
      reason: 'livekit_config_invalid',
      livekitReady: false,
      canary: false,
      error: `LiveKit credentials missing: ${missing.join(', ')}`,
    };
  }

  // Creds are valid. Check the L2.1 canary gate.
  const canary = ctx.canary;
  if (canary?.enabled === true) {
    if (isIdentityAllowlisted(canary, ctx.identity)) {
      // ALL hard gates pass — the canary lifts the L1 pin for this session.
      return {
        provider: 'livekit',
        requested,
        reason: 'canary_selected_livekit',
        livekitReady: true,
        canary: true,
      };
    }
    // Canary enabled but identity not allowlisted → pinned to vertex with
    // a distinct reason so the cockpit can distinguish "I'm running canary
    // but this user isn't in" from "canary is off entirely."
    return {
      provider: 'vertex',
      requested,
      reason: 'canary_not_allowlisted',
      livekitReady: false,
      canary: true,
      error:
        'LiveKit requested with valid creds and canary enabled, but the ' +
        'session identity is not in the canary allowlist. Pinning to Vertex. ' +
        `Would-have-selected reason: ${happyReason}.`,
    };
  }

  // Canary not enabled (or unconfigured) → L1 pin holds.
  return {
    provider: 'vertex',
    requested,
    reason: 'pinned_to_vertex_l1',
    livekitReady: true,
    canary: false,
    error:
      'LiveKit upstream client not enabled outside the canary gate; ' +
      'pinning to Vertex. ' +
      `Would-have-selected reason: ${happyReason}.`,
  };
}
