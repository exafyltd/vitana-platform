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

import type { VoiceProviderName } from './provider-name';

// BOOTSTRAP-NOVA-SONIC-VOICE: the selector's provider vocabulary is the
// canonical VoiceProviderName (adds `nova_sonic` to the historical
// 'vertex' | 'livekit' pair).
export type UpstreamProviderName = VoiceProviderName;

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
  | 'canary_not_allowlisted'
  // BOOTSTRAP-NOVA-SONIC-VOICE — Nova 2 Sonic selection reasons.
  | 'env_explicit_nova_sonic'     // ORB_LIVE_PROVIDER=nova_sonic, all gates pass
  | 'system_config_nova_sonic'    // voice.active_provider=nova_sonic, all gates pass
  | 'nova_canary_allowlisted'     // enabled allowlisted canary lifts a vertex/default request
  | 'nova_disabled'               // nova requested but disabled/not-ready → vertex
  | 'nova_not_allowlisted'        // nova gate on but identity not in allowlist → vertex
  | 'nova_language_unsupported'   // session language outside en/de/fr/es → vertex
  | 'nova_runtime_unsupported'    // runtime cannot carry the HTTP/2 stream (GCP) → vertex
  | 'provider_invalid';           // unknown provider string anywhere → vertex

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

  /**
   * BOOTSTRAP-NOVA-SONIC-VOICE: precomputed Nova gates (the caller resolves
   * them from `getNovaSonicConfig` + session language/identity so the
   * selector stays pure).
   *
   *   - `enabled`: config enabled AND ready (typed issues force false).
   *   - `identityAllowed`: user/tenant on a non-empty canary allowlist.
   *   - `languageSupported`: session language in the Nova canary set.
   *   - `runtime`: where the gateway is running. Nova's bidirectional
   *     stream requires end-to-end HTTP/2, which GCP Cloud Run does not
   *     carry — anything other than `'aws-ecs'` (when provided) fails the
   *     runtime gate.
   */
  nova?: {
    enabled: boolean;
    identityAllowed: boolean;
    languageSupported: boolean;
    runtime?: 'aws-ecs' | 'gcp-cloud-run' | 'unknown';
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

  /**
   * BOOTSTRAP-NOVA-SONIC-VOICE: whether every Nova hard gate passes
   * (enabled + ready + language + identity + runtime). True on the two
   * explicit Nova reasons and on `nova_canary_allowlisted`.
   */
  novaReady?: boolean;
}

const LIVEKIT_CRED_FIELDS = ['url', 'apiKey', 'apiSecret'] as const;

function normalizeOverride(raw: string | undefined): UpstreamProviderName | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'vertex') return 'vertex';
  if (trimmed === 'livekit') return 'livekit';
  if (trimmed === 'nova_sonic') return 'nova_sonic';
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
    ctx.systemConfigActiveProvider === 'livekit' ||
    ctx.systemConfigActiveProvider === 'nova_sonic'
      ? ctx.systemConfigActiveProvider
      : null;

  // Highest-priority signal: env override. `ORB_LIVE_PROVIDER=vertex` is
  // the emergency rollback — it beats every canary including Nova's.
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
  if (envChoice === 'nova_sonic') {
    return evaluateNovaRequest(ctx, 'env_explicit_nova_sonic');
  }
  // BOOTSTRAP-NOVA-SONIC-VOICE: a NON-EMPTY unknown provider string is a
  // validation failure, pinned to the default provider — never a silent
  // fall-through to whatever the DB row says.
  if (
    typeof ctx.envProviderOverride === 'string' &&
    ctx.envProviderOverride.trim().length > 0 &&
    envChoice === null
  ) {
    return {
      provider: 'vertex',
      requested: null,
      reason: 'provider_invalid',
      livekitReady: false,
      canary: false,
      error: 'Unknown ORB_LIVE_PROVIDER value; pinning to Vertex.',
    };
  }

  // Fallback: voice.active_provider system_config.
  if (sysChoice === 'nova_sonic') {
    return evaluateNovaRequest(ctx, 'system_config_nova_sonic');
  }
  if (sysChoice === 'vertex') {
    // BOOTSTRAP-NOVA-SONIC-VOICE: an enabled, allowlisted Nova canary lifts
    // a vertex DB flag for THIS identity only — the shared system_config
    // row is not environment-isolated between AWS and GCP staging, so the
    // canary must not depend on flipping it.
    const novaCanary = evaluateNovaCanary(ctx);
    if (novaCanary) return novaCanary;
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

  // Nothing requested → Nova canary, else default.
  const novaCanary = evaluateNovaCanary(ctx);
  if (novaCanary) return novaCanary;
  return {
    provider: 'vertex',
    requested: null,
    reason: 'default',
    livekitReady: false,
    canary: false,
  };
}

/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: Nova gate evaluation for an EXPLICIT request
 * (env or system_config). Every failed gate degrades to Vertex with a
 * typed reason — no silent access broadening, no raw config detail.
 */
function evaluateNovaRequest(
  ctx: UpstreamSelectorContext,
  happyReason: 'env_explicit_nova_sonic' | 'system_config_nova_sonic',
): UpstreamSelectionDecision {
  const nova = ctx.nova;
  if (!nova || nova.enabled !== true) {
    return {
      provider: 'vertex',
      requested: 'nova_sonic',
      reason: 'nova_disabled',
      livekitReady: false,
      canary: false,
      novaReady: false,
      error: 'Nova Sonic requested but disabled or not ready; pinning to Vertex.',
    };
  }
  if (nova.runtime !== undefined && nova.runtime !== 'aws-ecs') {
    return {
      provider: 'vertex',
      requested: 'nova_sonic',
      reason: 'nova_runtime_unsupported',
      livekitReady: false,
      canary: false,
      novaReady: false,
      error: 'Nova Sonic requires the AWS ECS runtime (HTTP/2 bidirectional stream); pinning to Vertex.',
    };
  }
  if (nova.languageSupported !== true) {
    return {
      provider: 'vertex',
      requested: 'nova_sonic',
      reason: 'nova_language_unsupported',
      livekitReady: false,
      canary: false,
      novaReady: false,
      error: 'Session language is outside the Nova canary set; pinning to Vertex.',
    };
  }
  if (nova.identityAllowed !== true) {
    return {
      provider: 'vertex',
      requested: 'nova_sonic',
      reason: 'nova_not_allowlisted',
      livekitReady: false,
      canary: true,
      novaReady: false,
      error: 'Session identity is not on the Nova canary allowlist; pinning to Vertex.',
    };
  }
  return {
    provider: 'nova_sonic',
    requested: 'nova_sonic',
    reason: happyReason,
    livekitReady: false,
    canary: true,
    novaReady: true,
  };
}

/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: silent canary check used when the resolved
 * request is vertex/default. Returns a decision ONLY when every Nova gate
 * passes; otherwise `null` so the ordinary Vertex reason is preserved
 * (non-canary users keep their unchanged decision trail).
 */
function evaluateNovaCanary(
  ctx: UpstreamSelectorContext,
): UpstreamSelectionDecision | null {
  const nova = ctx.nova;
  if (!nova || nova.enabled !== true) return null;
  if (nova.runtime !== undefined && nova.runtime !== 'aws-ecs') return null;
  if (nova.languageSupported !== true) return null;
  if (nova.identityAllowed !== true) return null;
  return {
    provider: 'nova_sonic',
    requested: null,
    reason: 'nova_canary_allowlisted',
    livekitReady: false,
    canary: true,
    novaReady: true,
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
