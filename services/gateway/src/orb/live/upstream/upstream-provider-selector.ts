/**
 * L1 (VTID-02976 / orb-live-refactor): pure provider-selection policy for
 * the ORB upstream live client.
 *
 * Inputs:
 *   - `ORB_LIVE_PROVIDER` env (highest priority override): `'vertex' | 'livekit' | ''`
 *   - `voice.active_provider` system_config row (read via voice-config.ts before
 *     calling this selector): `'vertex' | 'livekit'`
 *   - LiveKit credentials in env: `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
 *     `LIVEKIT_API_SECRET`
 *
 * Output:
 *   - `provider` — the upstream client implementation the consumer SHOULD use.
 *     L1 caps this at `'vertex'` because the LiveKit client is not yet wired
 *     into `connectToLiveAPI`; L2 (canary) flips this to honor `'livekit'`.
 *   - `requested` — what the caller asked for (or `null` if no override).
 *   - `reason` — why `provider` was chosen (drives the OASIS event).
 *   - `error` — populated only when the request was `'livekit'` but a gate
 *     failed (config missing, not enabled, or `pinned_to_vertex_l1`).
 *
 * Selection rules:
 *   1. If `ORB_LIVE_PROVIDER` is explicitly `'vertex'` → Vertex (reason
 *      `env_explicit`).
 *   2. If `ORB_LIVE_PROVIDER` is explicitly `'livekit'`:
 *        a. require `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
 *           If any missing → Vertex (reason `livekit_config_invalid`).
 *        b. all gates pass → LiveKit *would* be selected, but L1 pins to
 *           Vertex (reason `pinned_to_vertex_l1`) because the LiveKit
 *           upstream client isn't wired yet. L2 lifts this pin.
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
 *   - LiveKit cannot reach `provider: 'livekit'` in L1. The selector may
 *     compute a `livekit_ready: true` flag, but `provider` stays
 *     `'vertex'` and `reason` becomes `pinned_to_vertex_l1`.
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
  | 'pinned_to_vertex_l1';     // livekit requested AND creds present → still pinned to vertex in L1

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
}

export interface UpstreamSelectionDecision {
  /** What the consumer should actually instantiate. L1 always pins to `'vertex'`. */
  provider: UpstreamProviderName;
  /** What was requested. `null` if no override was provided. */
  requested: UpstreamProviderName | null;
  /** Why `provider` was chosen. Drives OASIS event payload. */
  reason: SelectionReason;
  /**
   * Whether LiveKit would have been selected if L1 weren't pinning to Vertex.
   * Useful for the L2 cutover and for the Improve cockpit's "rollout readiness"
   * indicator. False when LiveKit wasn't requested or creds are incomplete.
   */
  livekitReady: boolean;
  /**
   * Typed error when the LiveKit path was requested but a gate failed.
   * Empty/undefined on the happy Vertex path.
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
      error: `LiveKit credentials missing: ${missing.join(', ')}`,
    };
  }
  // Creds are valid; L1 pins to Vertex (the LiveKit upstream client is
  // not yet wired into connectToLiveAPI). `happyReason` is preserved on
  // `livekitReady=true` for operator-side rollout monitoring, but `reason`
  // is `pinned_to_vertex_l1` to signal the deliberate L1 cap.
  return {
    provider: 'vertex',
    requested,
    reason: 'pinned_to_vertex_l1',
    livekitReady: true,
    error:
      'LiveKit upstream client not wired in L1; pinning to Vertex. ' +
      `Would-have-selected reason: ${happyReason}.`,
  };
}
