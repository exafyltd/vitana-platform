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
  // VTID-03501 (GCP cutover build 4): Nova promoted globally via
  // NOVA_SONIC_GLOBAL_ENABLED — every identity, not an allowlist. Reported
  // separately from the canary reason so dashboards can tell a 4-user canary
  // from the whole user base.
  | 'nova_global_enabled'
  // VTID-03723 — VERTEX IS REMOVED AS A DESTINATION. Every branch that used to
  // pin to Vertex now resolves to Nova, or to the Polly cascade when Nova
  // cannot speak the session language. These two reasons name that
  // substitution so telemetry says WHY a session landed where it did instead
  // of silently reporting the old vertex reason against a non-vertex provider.
  | 'vertex_removed_forced_nova'
  | 'vertex_removed_cascaded'
  | 'nova_disabled'               // nova requested but disabled/not-ready → vertex
  | 'nova_not_allowlisted'        // nova gate on but identity not in allowlist → vertex
  | 'nova_language_unsupported'   // session language outside en/de/fr/es → vertex
  | 'nova_runtime_unsupported'    // runtime cannot carry the HTTP/2 stream (GCP) → vertex
  // VTID-emergency-gcp-shutdown / VTID-03703: the GCP project's billing was
  // disabled, so Vertex Live is permanently unreachable, not merely
  // deprioritized. Once `ctx.vertexUnavailable` is set, NO gate may route to
  // Vertex any more — runtime, language, disabled, AND not-allowlisted all
  // force through instead. This corrects an earlier, narrower version of
  // this comment which carved `nova_disabled`/`nova_not_allowlisted` OUT of
  // the force-through on the theory those reflect deliberate operator
  // config rather than a technical limit — live traffic proved that
  // carve-out wrong: real sessions reached a genuine (dead) Vertex connect
  // and died with upstream code 1007 (VTID-03688). A degraded/forced Nova
  // session, or the cascaded Transcribe->Bedrock->Polly pipeline when the
  // language genuinely isn't one Nova speaks, both beat a guaranteed-dead
  // connection attempt every time.
  | 'nova_forced_vertex_unavailable'
  // BOOTSTRAP-NOVA-IDLE-ROTATION: a mid-session pin applied by the CALLER,
  // never returned by selectUpstreamProvider() itself (which is stateless and
  // has no notion of a session's rotation history). Set when a planned Nova
  // rotation — wall-clock cap or idle fail-safe — exhausted its attempts, so
  // the session finishes on Vertex instead of dying on a stream Nova cannot
  // replace. Lives in this union so the override is a typed, greppable
  // decision rather than a cast.
  | 'nova_rotation_exhausted_fallback'
  // VTID-03683: the session's language is one Nova CANNOT speak (ru/pl/ar/zh),
  // and instead of forcing it onto Nova anyway — which produced ~30 audio
  // chunks per turn against de/en's ~165 — it is served by the cascaded
  // Transcribe -> Bedrock -> Polly pipeline, which does support it.
  | 'cascaded_language_rescue'
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
    /**
     * VTID-03501: true when Nova is promoted globally rather than by
     * allowlist. Only affects the reported `reason`/`canary` labels — the
     * gate itself is already expressed through `identityAllowed`.
     */
    globalEnabled?: boolean;
  };

  /**
   * VTID-emergency-gcp-shutdown: true when Vertex Live is known to be
   * permanently unreachable (GCP project billing disabled), not merely
   * disfavored. When set, the `runtime`/`languageSupported` Nova gates can no
   * longer degrade a session to Vertex — there is nothing there to degrade
   * to — so a Nova session is forced through instead, reported with the
   * distinct `nova_forced_vertex_unavailable` reason so the rate stays
   * measurable. Does NOT touch the `enabled`/`identityAllowed` gates, which
   * reflect deliberate operator config rather than a technical limit.
   * Caller-supplied (reads `VERTEX_LIVE_UNAVAILABLE=true`) so the selector
   * stays pure. Default undefined/false — zero behavior change until set.
   */
  vertexUnavailable?: boolean;

  /**
   * VTID-03683: the cascaded pipeline's readiness for THIS session.
   *
   * Precomputed by the caller for the same reason `nova.languageSupported`
   * is: this module is stateless and never sees the session's language
   * string, only booleans derived from it. `languageSupported` here means
   * `evaluateCascadeEligibility(lang).eligible` — which already refuses any
   * language Nova speaks natively, so a working Nova session can never be
   * diverted into the slower three-hop path.
   */
  cascade?: {
    enabled: boolean;
    languageSupported: boolean;
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
/**
 * VTID-03723 — resolve a decision WITHOUT Vertex, which no longer exists.
 *
 * Vertex Live died with the GCP project (billing disabled 2026-08-16). The
 * selector nevertheless kept `vertex` as the destination of ELEVEN branches,
 * including `default` and `system_config_vertex` — and staging's
 * `voice.active_provider` row still said `vertex`, so EVERY pre-login session
 * short-circuited to the Gemini live client at the very top of this function,
 * before the language gate or the cascade were ever consulted.
 *
 * Measured: `orb.upstream.cascaded.*` has NEVER fired — not one success, not
 * one failure — while `/api/v1/orb/health` reported
 * `model: gemini-2.0-flash-exp`. Polish and Portuguese therefore got a
 * correct-sounding per-language Gemini VOICE speaking ENGLISH, for weeks, and
 * every fix aimed at Nova or the cascade was landing on a path no session took.
 *
 * The standing rule is unambiguous (CLAUDE.md, IF-THEN 27): there is no
 * sanctioned Google dependency left at all. So this is not a routing
 * preference — Vertex is not a destination any more.
 *
 * Order is the whole point: cascade FIRST when Nova cannot speak the language,
 * because forcing Polish onto Nova is what produced English in the first place.
 */
function resolveWithoutVertex(
  ctx: UpstreamSelectorContext,
  requested: UpstreamProviderName | null,
  error?: string,
): UpstreamSelectionDecision {
  const languageBlocked = ctx.nova ? ctx.nova.languageSupported !== true : false;
  const rescue = tryCascadeRescue(ctx, languageBlocked);
  if (rescue) {
    return { ...rescue, requested, reason: 'vertex_removed_cascaded' };
  }
  return {
    provider: 'nova_sonic',
    requested,
    reason: 'vertex_removed_forced_nova',
    livekitReady: false,
    canary: false,
    novaReady: ctx.nova?.enabled === true,
    ...(error ? { error } : {}),
  };
}

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

  // VTID-03723: `ORB_LIVE_PROVIDER=vertex` used to be the emergency
  // rollback to Vertex — it beat every canary including Nova's. Vertex no
  // longer exists as a destination, so this "rollback" now lands on
  // Nova/the cascade like every other path in this function.
  if (envChoice === 'vertex') {
    return resolveWithoutVertex(ctx, 'vertex');
  }
  if (envChoice === 'livekit') {
    return evaluateLiveKitRequest(ctx, 'livekit', 'env_explicit_livekit');
  }
  if (envChoice === 'nova_sonic') {
    return evaluateNovaRequest(ctx, 'env_explicit_nova_sonic');
  }
  // BOOTSTRAP-NOVA-SONIC-VOICE: a NON-EMPTY unknown provider string is a
  // validation failure. VTID-03723: no longer pinned to Vertex — forced to
  // Nova/the cascade instead, same as every other branch here. `reason`
  // stays `provider_invalid` (a config error, not a routing substitution)
  // even though the destination is now resolved by resolveWithoutVertex().
  if (
    typeof ctx.envProviderOverride === 'string' &&
    ctx.envProviderOverride.trim().length > 0 &&
    envChoice === null
  ) {
    return {
      ...resolveWithoutVertex(
        ctx,
        null,
        'Unknown ORB_LIVE_PROVIDER value; pinning away from dead Vertex.',
      ),
      reason: 'provider_invalid',
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
    //
    // VTID-03723 — root cause of the pl/pt English-speaking incident:
    // staging's `voice.active_provider` row said `vertex`, and this branch
    // used to short-circuit straight to a (now-dead) Vertex connect before
    // Nova/the cascade were ever consulted. `evaluateNovaCanary` already
    // forces through when it applies; the fallback below is a second,
    // defense-in-depth guarantee that this branch can never return
    // `provider: 'vertex'` either.
    const novaCanary = evaluateNovaCanary(ctx);
    if (novaCanary) return novaCanary;
    return resolveWithoutVertex(ctx, 'vertex');
  }
  if (sysChoice === 'livekit') {
    return evaluateLiveKitRequest(ctx, 'livekit', 'system_config_livekit');
  }

  // Nothing requested → Nova canary, else Nova/cascade (VTID-03723: no
  // longer Vertex — this was the `default` reason's old destination and is
  // the exact path every pre-login session takes).
  const novaCanary = evaluateNovaCanary(ctx);
  if (novaCanary) return novaCanary;
  return resolveWithoutVertex(ctx, null);
}

/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: Nova gate evaluation for an EXPLICIT request
 * (env or system_config). Every failed gate degrades to Vertex with a
 * typed reason — no silent access broadening, no raw config detail.
 */
/**
 * VTID-03683: when Nova is about to be FORCED to carry a language it cannot
 * speak, hand the session to the cascade instead — if the cascade is switched
 * on and actually covers that language.
 *
 * Returns null when it does not apply, so both call sites fall through to the
 * pre-existing forced-Nova behaviour byte-for-byte. That is deliberate: with
 * `ORB_CASCADED_VOICE_ENABLED` unset this whole feature is inert, and `sr`
 * (which Polly cannot voice) keeps the old path rather than being routed
 * somewhere that would also fail.
 */
function tryCascadeRescue(
  ctx: UpstreamSelectorContext,
  languageBlocked: boolean,
): UpstreamSelectionDecision | null {
  if (!languageBlocked) return null;
  if (ctx.cascade?.enabled !== true) return null;
  if (ctx.cascade.languageSupported !== true) return null;
  return {
    provider: 'cascaded',
    requested: 'nova_sonic',
    reason: 'cascaded_language_rescue',
    livekitReady: false,
    canary: false,
    novaReady: false,
  };
}

function evaluateNovaRequest(
  ctx: UpstreamSelectorContext,
  happyReason: 'env_explicit_nova_sonic' | 'system_config_nova_sonic',
): UpstreamSelectionDecision {
  const nova = ctx.nova;

  if (!nova || nova.enabled !== true) {
    // VTID-03703 / VTID-03723: Nova itself isn't ready. Vertex is not a
    // destination any more — always force through, never pin to Vertex.
    // `nova.languageSupported` is computed independently of `nova.enabled`
    // by the caller (session language vs Nova's supported set), so it is
    // still meaningful here even though Nova is off; `nova` can also be
    // fully absent (no context at all), in which case cascade eligibility
    // can't be assessed and Nova is forced through blind.
    const languageBlocked = nova ? nova.languageSupported !== true : false;
    const rescue = tryCascadeRescue(ctx, languageBlocked);
    if (rescue) return rescue;
    return {
      provider: 'nova_sonic',
      requested: 'nova_sonic',
      reason: 'nova_forced_vertex_unavailable',
      livekitReady: false,
      canary: false,
      novaReady: false,
      error: 'Nova Sonic disabled/not-ready; Vertex no longer exists as a destination. Forcing Nova regardless.',
    };
  }

  const runtimeBlocked = nova.runtime !== undefined && nova.runtime !== 'aws-ecs';
  const languageBlocked = nova.languageSupported !== true;
  const identityBlocked = nova.identityAllowed !== true;

  // VTID-03723: the three `&& !vertexDead` early-returns to `provider:
  // 'vertex'` that used to live here (runtime/language/identity blocked)
  // are gone — Vertex is not a destination any more, so every one of these
  // gates now falls through to the same forced Nova/cascade resolution
  // below regardless of which gate blocked. `identityAllowed` reflects
  // deliberate canary/allowlist policy, not a Nova capability gap, but a
  // policy gate outranking "there is no other destination" no longer makes
  // sense once that other destination is permanently gone.
  const forced = runtimeBlocked || languageBlocked || identityBlocked;
  const rescue = tryCascadeRescue(ctx, languageBlocked);
  if (rescue) return rescue;
  return {
    provider: 'nova_sonic',
    requested: 'nova_sonic',
    reason: forced ? 'nova_forced_vertex_unavailable' : happyReason,
    livekitReady: false,
    canary: true,
    novaReady: !forced,
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

  if (!nova || nova.enabled !== true) {
    // VTID-03703 / VTID-03723: this used to return `null` (meaning "fall
    // through to the caller's normal Vertex path") whenever Vertex wasn't
    // yet known-dead — exactly the silent Vertex hand-off that must never
    // happen now that Vertex is not a destination at all. Cascade first,
    // then force Nova, unconditionally.
    const languageBlocked = nova ? nova.languageSupported !== true : false;
    const rescue = tryCascadeRescue(ctx, languageBlocked);
    if (rescue) return { ...rescue, requested: null };
    return {
      provider: 'nova_sonic',
      requested: null,
      reason: 'nova_forced_vertex_unavailable',
      livekitReady: false,
      canary: false,
      novaReady: false,
    };
  }

  const runtimeBlocked = nova.runtime !== undefined && nova.runtime !== 'aws-ecs';
  const languageBlocked = nova.languageSupported !== true;

  // VTID-03723: identity/allowlist gating is policy, not a Nova capability
  // gap, but a permanently-gone Vertex outranks that policy — force through
  // instead of returning `null` to fall back to a (now nonexistent) Vertex
  // default path.
  const identityBlocked = nova.identityAllowed !== true;

  // VTID-03501: a globally-promoted session is NOT a canary session. Reporting
  // `canary: true` for the whole user base would make every canary-scoped
  // dashboard and alert read as if the rollout never widened — the population
  // changed, so the label has to change with it.
  const global = nova.globalEnabled === true;
  const forced = runtimeBlocked || languageBlocked || identityBlocked;
  const rescue = tryCascadeRescue(ctx, languageBlocked);
  if (rescue) return { ...rescue, requested: null };
  return {
    provider: 'nova_sonic',
    requested: null,
    reason: forced ? 'nova_forced_vertex_unavailable' : (global ? 'nova_global_enabled' : 'nova_canary_allowlisted'),
    livekitReady: false,
    canary: forced ? false : !global,
    novaReady: !forced,
  };
}

function evaluateLiveKitRequest(
  ctx: UpstreamSelectorContext,
  requested: UpstreamProviderName,
  happyReason: SelectionReason,
): UpstreamSelectionDecision {
  // VTID-03723: every branch below used to pin to Vertex when the LiveKit
  // request couldn't be satisfied. Vertex is not a destination any more —
  // each now resolves via resolveWithoutVertex() (Nova, or the cascade when
  // Nova can't speak the session language), with the original `livekitReady`
  // / `canary` telemetry flags preserved since those describe the LiveKit
  // gate outcome, not the routing substitution.
  const missing = livekitCredsMissing(ctx.livekitCredentials);
  if (missing.length > 0) {
    return resolveWithoutVertex(
      ctx,
      requested,
      `LiveKit credentials missing: ${missing.join(', ')}`,
    );
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
    // Canary enabled but identity not allowlisted → forced to Nova/cascade,
    // `canary: true` preserved so the cockpit can distinguish "I'm running
    // canary but this user isn't in" from "canary is off entirely."
    return {
      ...resolveWithoutVertex(
        ctx,
        requested,
        'LiveKit requested with valid creds and canary enabled, but the ' +
          'session identity is not in the canary allowlist. ' +
          `Would-have-selected reason: ${happyReason}.`,
      ),
      canary: true,
    };
  }

  // Canary not enabled (or unconfigured) → the L1 pin used to hold here
  // (routing to Vertex). `livekitReady: true` preserved — creds ARE valid,
  // it's only the canary gate that's closed.
  return {
    ...resolveWithoutVertex(
      ctx,
      requested,
      'LiveKit upstream client not enabled outside the canary gate; ' +
        `Would-have-selected reason: ${happyReason}.`,
    ),
    livekitReady: true,
  };
}
