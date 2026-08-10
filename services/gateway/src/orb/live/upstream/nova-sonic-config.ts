/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): Nova 2 Sonic environment
 * configuration, readiness, canary allowlists, and language support.
 *
 * Hard constraints (see the Nova voice-provider plan):
 *   - Model is FIXED to `amazon.nova-2-sonic-v1:0` and region to
 *     `eu-north-1` — the only Bedrock region in Vitana's footprint that
 *     serves Nova 2 Sonic in-region (no geo/global inference profile
 *     exists for it). Env overrides for either are validation-checked and
 *     anything else makes readiness false with a typed reason, never a
 *     silent redirect of paid traffic.
 *   - Disabled unless NOVA_SONIC_ENABLED === 'true'.
 *   - Credentials come from the AWS SDK default chain (ECS task role) —
 *     this module never reads or stores key material.
 *   - Invalid allowlist entries FAIL readiness (typed reason) instead of
 *     silently broadening or narrowing access.
 */

export const NOVA_SONIC_MODEL_ID = 'amazon.nova-2-sonic-v1:0' as const;
export const NOVA_SONIC_REGION = 'eu-north-1' as const;

/** Languages eligible for the first Nova canary. Everything else → Vertex. */
export const NOVA_SONIC_SUPPORTED_LANGUAGES = ['en', 'de', 'fr', 'es'] as const;
export type NovaSonicLanguage = (typeof NOVA_SONIC_SUPPORTED_LANGUAGES)[number];

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
// VTID-03557: NodeHttp2Handler's `requestTimeout` is NOT a "wait for headers"
// bound — `node-http2-handler.js` arms it via `clientHttp2Stream.setTimeout()`,
// which fires on inactivity ANYWHERE across the stream's full lifetime
// (idle-since-any-frame, either direction), not just at connect. Wiring it to
// `connectTimeoutMs` (15s — sized for "how long to wait to open a stream") was
// a category error: it applied a connect-scoped bound to a bidirectional voice
// stream meant to live for minutes. AWS's own official Node.js sample for this
// exact API (InvokeModelWithBidirectionalStreamCommand) configures
// `requestTimeout: 300000` — 300s, not 15s. This does NOT explain the
// "Premature close" failures found in production (those carry Node's own
// distinct `TimeoutError` name/message, and classifyNovaError routes that to
// `nova_stream_timeout`, never observed in the `nova_stream_error` telemetry
// this VTID investigated) — but it is a real, independent deviation from AWS's
// documented practice that could cause an unrelated false-positive disconnect
// (e.g. a slow tool round-trip or context-build pause with no Bedrock frame
// activity) once traffic patterns hit it. Kept as its own field rather than
// reusing connectTimeoutMs so the two concerns (time-to-open vs.
// stream-lifetime-idle-bound) can never silently collide again.
const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 300_000;
/** 7m15s — rotate 45s before Bedrock's 8-minute bidirectional stream cap. */
const DEFAULT_ROTATION_AFTER_MS = 435_000;
// BOOTSTRAP-NOVA-IDLE-ROTATION: Bedrock enforces TWO independent deadlines,
// and `rotationAfterMs` above only covers the first:
//
//   1. Stream cap  — ~8 min of WALL CLOCK since connect, regardless of
//                    traffic. `rotationAfterMs` (435s) covers this.
//   2. Idle timeout — ~295s since the last ACCEPTED INPUT. Bedrock's own
//                    words: "Timed out waiting for audio bytes or
//                    interactive content … less than 295 seconds".
//
// These run on different clocks, so a 435s wall-clock timer CANNOT protect
// the 295s idle deadline — a session that stops feeding frames dies at ~295s
// with the rotation timer still 140s away. That is exactly the production
// P0: a healthy 10-turn session terminated ~292s after its last input.
//
// The silence keepalive normally makes idle unreachable (it feeds a frame
// every 250ms), so in a healthy session this watchdog never fires. It exists
// because the keepalive stopping is precisely the failure that killed
// production once already — VTID-LOOPGUARD used to clear it deliberately.
// This is the backstop for "the frames stopped for a reason nobody predicted".
//
// 240s leaves ~55s of headroom to open, validate, and swap to a replacement
// stream before Bedrock would kill the old one.
const DEFAULT_IDLE_ROTATION_AFTER_MS = 240_000;
/**
 * How often the idle watchdog samples the elapsed-since-last-input clock.
 * Sampling, not a one-shot timer, because the deadline is relative to a
 * moving timestamp. 5s bounds the overshoot well inside the 55s headroom.
 */
export const NOVA_IDLE_WATCHDOG_TICK_MS = 5_000;
// Under NodeHttp2Handler's 480s idle sessionTimeout so the pooled HTTP/2
// session never expires between pings.
const DEFAULT_KEEPWARM_MS = 240_000;
// BOOTSTRAP-NOVA-SONIC-VOICE (latency): the transport-only keep-warm ping
// above rides a marker model ID Bedrock rejects before any inference — it
// keeps DNS/TCP/TLS/HTTP2 hot but never touches the model-execution path.
// Real production data (2026-07-29) showed audio_out_first_chunk ranging
// 2.5s-9.9s for Nova vs. Vertex's tighter 3.3-5.6s band — the same
// "cold vs. warm" split observed earlier in isolated latency testing, this
// time on live customer traffic. A real (tiny) inference round-trip on a
// shorter cadence keeps the model executor itself warm, not just the pipe.
const DEFAULT_MODEL_WARM_MS = 90_000;
// Per-turn output budget. The Nova sample's 1024 starves real ORB turns —
// the greeting turn alone (16KB wake prompt + tool rounds) exhausted it and
// ended with no speech (staging session live-dedf85d5).
const DEFAULT_MAX_TOKENS = 4096;
// Nova rejects a single oversized SYSTEM textInput with nova_validation but
// streams many bounded events fine (nova-sonic-live-client.ts's chunking
// comment). Production never set this, so a Nova rotation — whose rebuilt
// instruction is LARGER than a fresh connect's (it appends up to ~4000 chars
// of conversation-history fallback, since Nova has no native session
// resumption) — could silently trip the same nova_validation rejection the
// staging bisect harness (nova-sonic-test-runner.ts) was built to find,
// abandon the rotation (no retry), and ride the old stream to its 8-minute
// hard cap before disconnecting the user into a brand-new session. 4000
// bytes keeps each chunk far under the ~32KB range the bisect harness
// specifically probes as a failure zone.
const DEFAULT_INSTRUCTION_CHUNK_BYTES = 4_000;
// PER-TURN LATENCY (Nova voice-provider follow-up): Nova's server-side VAD
// decides "the user is done speaking" — that decision gates EVERY turn's
// time-to-first-response, not just the first. Unlike Vertex's numeric
// `silence_duration_ms` (orb-live.ts `session.vadSilenceMs`, DB-tunable via
// VOICE_VAD_SILENCE_DURATION_MS), Nova only exposes a coarse HIGH/MEDIUM/LOW
// `turnDetectionConfiguration.endpointingSensitivity` enum — no numeric ms.
// This was previously hardcoded in nova-sonic-protocol.ts's `buildSessionStart`
// default with no way to change it short of a code deploy; `connect()` never
// even read `options.vadSilenceMs` to inform it. AWS's documented waits:
// HIGH ≈1.5s, MEDIUM ≈1.75s, LOW ≈2s.
//
// DEFAULT IS NOW **HIGH** (BOOTSTRAP-ORB-LATENCY-P0). Two reasons this is a
// correction, not a preference:
//   1. The session already asks for a 600ms silence window
//      (`vadSilenceMs`, VOICE_VAD_SILENCE_DURATION_MS). Nova ignores that
//      value entirely, so the operator-configured intent was "end the turn
//      quickly" while Nova actually waited 1.75s on every single turn. HIGH
//      is the closest Nova can get to what was already configured — MEDIUM
//      was never a deliberate choice, it was the protocol default leaking
//      through because nothing wired the setting.
//   2. A ≥1.75s pre-inference wait cannot fit inside a 2-3s end-to-end
//      target once model generation and playback are added.
// LOW/MEDIUM remain available via NOVA_SONIC_ENDPOINTING_SENSITIVITY for
// thoughtful/clinical/hesitant-speech flows or an accessibility preference,
// and rollback is an env flip with no redeploy.
const DEFAULT_ENDPOINTING_SENSITIVITY = 'HIGH' as const;
const VALID_ENDPOINTING_SENSITIVITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);

export type NovaSonicConfigIssue =
  | 'nova_region_invalid'
  | 'nova_model_invalid'
  | 'nova_canary_user_ids_invalid'
  | 'nova_canary_tenant_ids_invalid'
  | 'nova_connect_timeout_invalid'
  | 'nova_stream_inactivity_timeout_invalid'
  | 'nova_rotation_after_invalid'
  | 'nova_idle_rotation_after_invalid'
  | 'nova_keepwarm_invalid'
  | 'nova_model_warm_invalid'
  | 'nova_max_tokens_invalid'
  | 'nova_instruction_chunk_invalid'
  | 'nova_endpointing_sensitivity_invalid';

export interface NovaSonicConfig {
  enabled: boolean;
  /**
   * VTID-03501 (GCP cutover build 4): promote Nova out of canary — every
   * identity, not just the allowlists. Default FALSE; `NOVA_SONIC_GLOBAL_ENABLED`
   * must be the literal string 'true'.
   *
   * Deliberately a SECOND gate on top of `enabled`, not a widening of the
   * allowlist semantics: `isNovaSonicIdentityAllowed()` keeps its
   * "empty allowlist allows NOBODY" contract intact, so turning global off
   * again restores exactly the previous canary population with no allowlist
   * edits and no ambiguity about what "empty" meant.
   */
  globalEnabled: boolean;
  region: typeof NOVA_SONIC_REGION;
  modelId: typeof NOVA_SONIC_MODEL_ID;
  canaryUserIds: ReadonlySet<string>;
  canaryTenantIds: ReadonlySet<string>;
  connectTimeoutMs: number;
  /**
   * `NodeHttp2Handler`'s `requestTimeout` — a whole-stream idle-since-any-
   * activity bound, NOT a connect/header-wait bound. See the
   * DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS comment. Deliberately separate from
   * `connectTimeoutMs`.
   */
  streamInactivityTimeoutMs: number;
  rotationAfterMs: number;
  /**
   * Fail-safe: rotate the stream once this long has passed since the last
   * ACCEPTED input, to stay ahead of Bedrock's ~295s idle deadline. Distinct
   * clock from `rotationAfterMs` (wall-clock since connect) — see the
   * DEFAULT_IDLE_ROTATION_AFTER_MS comment for why one cannot cover the
   * other. 0 disables the watchdog.
   */
  idleRotationAfterMs: number;
  /**
   * Interval for the Bedrock connection keep-warm ping (latency: keeps the
   * pooled HTTP/2 session + resolved credentials hot between real sessions;
   * NodeHttp2Handler drops idle sessions after 8 min). 0 disables.
   */
  keepWarmMs: number;
  /**
   * Interval for the real (tiny) model-execution warm-up: a genuine minimal
   * inference round-trip (not the zero-cost 4xx marker ping) that keeps
   * Bedrock's model executor itself hot, not just the transport. 0 disables.
   */
  modelWarmMs: number;
  /** sessionStart inferenceConfiguration.maxTokens (per-turn output budget). */
  maxTokens: number;
  /**
   * Split an oversized SYSTEM textInput into chunks of this many bytes
   * (passed as `systemInstructionChunkBytes` to `NovaSonicLiveClient.connect`)
   * instead of sending it as one event, which Nova can reject with
   * `nova_validation`. 0 disables chunking (sends the whole instruction in a
   * single event, the pre-fix behavior).
   */
  instructionChunkBytes: number;
  /**
   * Server-side turn-detection sensitivity (`sessionStart.
   * turnDetectionConfiguration.endpointingSensitivity`). Gates how long Nova
   * waits after the user stops speaking before it decides the turn is over
   * and starts generating — a PER-TURN latency cost paid on every turn, not
   * just session establishment. 'MEDIUM' (AWS's recommended default) unless
   * overridden. See the DEFAULT_ENDPOINTING_SENSITIVITY doc comment above.
   */
  endpointingSensitivity: 'HIGH' | 'MEDIUM' | 'LOW';
  /**
   * Typed configuration problems. Non-empty issues force `ready` false —
   * misconfiguration is never silently corrected into live traffic.
   */
  issues: ReadonlyArray<NovaSonicConfigIssue>;
  /** True only when enabled AND the configuration parsed cleanly. */
  ready: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse a comma-separated UUID allowlist: trim entries, lowercase, drop
 * empties. Returns null when any non-empty entry is not a UUID — the caller
 * records a typed issue instead of guessing what was meant.
 */
export function parseUuidAllowlist(raw: string | undefined): Set<string> | null {
  if (!raw || raw.trim().length === 0) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (!UUID_RE.test(entry)) return null;
    out.add(entry);
  }
  return out;
}

/** Language gate for the Nova canary (case-insensitive, base-tag match). */
export function isNovaSonicLanguageSupported(lang: string | undefined | null): boolean {
  if (!lang) return false;
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  return (NOVA_SONIC_SUPPORTED_LANGUAGES as readonly string[]).includes(base);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Like parsePositiveInt but 0 is legal ("explicitly disabled"). */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Parse Nova configuration from an environment bag. Pure — never throws. */
export function getNovaSonicConfig(env: NodeJS.ProcessEnv): NovaSonicConfig {
  const issues: NovaSonicConfigIssue[] = [];

  const enabled = env.NOVA_SONIC_ENABLED === 'true';
  // VTID-03501: exact-string opt-in, same shape as `enabled` above. Anything
  // other than 'true' (including unset, 'TRUE', '1', 'yes') leaves the canary
  // population unchanged — a promotion this consequential should not happen
  // through a loosely-parsed value.
  const globalEnabled = env.NOVA_SONIC_GLOBAL_ENABLED === 'true';

  // Region/model are pinned — a mismatched override is a typed failure, not
  // a redirect (Never-rule: no silent provider/priority changes).
  if (env.NOVA_SONIC_REGION !== undefined && env.NOVA_SONIC_REGION !== NOVA_SONIC_REGION) {
    issues.push('nova_region_invalid');
  }
  if (env.NOVA_SONIC_MODEL_ID !== undefined && env.NOVA_SONIC_MODEL_ID !== NOVA_SONIC_MODEL_ID) {
    issues.push('nova_model_invalid');
  }

  const canaryUserIds = parseUuidAllowlist(env.NOVA_SONIC_CANARY_USER_IDS);
  if (canaryUserIds === null) issues.push('nova_canary_user_ids_invalid');
  const canaryTenantIds = parseUuidAllowlist(env.NOVA_SONIC_CANARY_TENANT_IDS);
  if (canaryTenantIds === null) issues.push('nova_canary_tenant_ids_invalid');

  const connectTimeoutMs = parsePositiveInt(
    env.NOVA_SONIC_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
  );
  if (connectTimeoutMs === null) issues.push('nova_connect_timeout_invalid');

  const streamInactivityTimeoutMs = parsePositiveInt(
    env.NOVA_SONIC_STREAM_INACTIVITY_TIMEOUT_MS,
    DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS,
  );
  if (streamInactivityTimeoutMs === null) issues.push('nova_stream_inactivity_timeout_invalid');

  const rotationAfterMs = parsePositiveInt(
    env.NOVA_SONIC_ROTATION_AFTER_MS,
    DEFAULT_ROTATION_AFTER_MS,
  );
  if (rotationAfterMs === null) issues.push('nova_rotation_after_invalid');

  // Non-negative (not positive) so 0 is a legitimate "disable the watchdog"
  // value, matching keepWarmMs/modelWarmMs.
  const idleRotationAfterMs = parseNonNegativeInt(
    env.NOVA_SONIC_IDLE_ROTATION_AFTER_MS,
    DEFAULT_IDLE_ROTATION_AFTER_MS,
  );
  if (idleRotationAfterMs === null) issues.push('nova_idle_rotation_after_invalid');

  const keepWarmMs = parseNonNegativeInt(
    env.NOVA_SONIC_KEEPWARM_MS,
    DEFAULT_KEEPWARM_MS,
  );
  if (keepWarmMs === null) issues.push('nova_keepwarm_invalid');

  const modelWarmMs = parseNonNegativeInt(
    env.NOVA_SONIC_MODEL_WARM_MS,
    DEFAULT_MODEL_WARM_MS,
  );
  if (modelWarmMs === null) issues.push('nova_model_warm_invalid');

  const maxTokens = parsePositiveInt(env.NOVA_SONIC_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  if (maxTokens === null) issues.push('nova_max_tokens_invalid');

  const instructionChunkBytes = parseNonNegativeInt(
    env.NOVA_SONIC_INSTRUCTION_CHUNK_BYTES,
    DEFAULT_INSTRUCTION_CHUNK_BYTES,
  );
  if (instructionChunkBytes === null) issues.push('nova_instruction_chunk_invalid');

  let endpointingSensitivity: 'HIGH' | 'MEDIUM' | 'LOW' = DEFAULT_ENDPOINTING_SENSITIVITY;
  const rawSensitivity = env.NOVA_SONIC_ENDPOINTING_SENSITIVITY;
  if (rawSensitivity !== undefined && rawSensitivity.trim() !== '') {
    const normalized = rawSensitivity.trim().toUpperCase();
    if (VALID_ENDPOINTING_SENSITIVITIES.has(normalized)) {
      endpointingSensitivity = normalized as 'HIGH' | 'MEDIUM' | 'LOW';
    } else {
      issues.push('nova_endpointing_sensitivity_invalid');
    }
  }

  return {
    enabled,
    globalEnabled,
    region: NOVA_SONIC_REGION,
    modelId: NOVA_SONIC_MODEL_ID,
    canaryUserIds: canaryUserIds ?? new Set(),
    canaryTenantIds: canaryTenantIds ?? new Set(),
    connectTimeoutMs: connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    streamInactivityTimeoutMs: streamInactivityTimeoutMs ?? DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS,
    rotationAfterMs: rotationAfterMs ?? DEFAULT_ROTATION_AFTER_MS,
    idleRotationAfterMs: idleRotationAfterMs ?? DEFAULT_IDLE_ROTATION_AFTER_MS,
    keepWarmMs: keepWarmMs ?? DEFAULT_KEEPWARM_MS,
    modelWarmMs: modelWarmMs ?? DEFAULT_MODEL_WARM_MS,
    maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    instructionChunkBytes: instructionChunkBytes ?? DEFAULT_INSTRUCTION_CHUNK_BYTES,
    endpointingSensitivity,
    issues,
    ready: enabled && issues.length === 0,
  };
}

/**
 * Identity gate: a session is canary-allowlisted when its user OR tenant is
 * on a non-empty allowlist. Empty allowlists allow NOBODY (explicit-opt-in
 * canary — never "empty means everyone").
 */
export function isNovaSonicIdentityAllowed(
  config: Pick<NovaSonicConfig, 'canaryUserIds' | 'canaryTenantIds'> &
    Partial<Pick<NovaSonicConfig, 'globalEnabled'>>,
  identity: { userId?: string | null; tenantId?: string | null },
): boolean {
  // VTID-03501: global promotion short-circuits the allowlists entirely.
  // `globalEnabled` is optional on the parameter type so existing callers
  // that pass a narrowed object keep compiling with canary-only behaviour.
  if (config.globalEnabled === true) return true;
  const user = identity.userId?.trim().toLowerCase();
  const tenant = identity.tenantId?.trim().toLowerCase();
  if (user && config.canaryUserIds.has(user)) return true;
  if (tenant && config.canaryTenantIds.has(tenant)) return true;
  return false;
}

/**
 * Health payload for `GET /api/v1/orb/nova-sonic/health`. Pure and
 * secret-free by construction — Nova credentials live in the ECS task role;
 * no key material exists in the gateway's environment to leak.
 */
export function buildNovaSonicHealthPayload(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const cfg = getNovaSonicConfig(env);
  return {
    ok: true,
    configured: cfg.issues.length === 0,
    enabled: cfg.enabled,
    ready: cfg.ready,
    provider: 'nova_sonic',
    model: cfg.modelId,
    region: cfg.region,
    credential_source: 'ecs_task_role',
    supported_languages: [...NOVA_SONIC_SUPPORTED_LANGUAGES],
    canary_user_count: cfg.canaryUserIds.size,
    canary_tenant_count: cfg.canaryTenantIds.size,
    // VTID-03501: without this, the health endpoint reports a 4-user canary
    // while Nova is actually serving everyone — the counts above become
    // actively misleading the moment global promotion is on.
    global_enabled: cfg.globalEnabled,
    issues: [...cfg.issues],
  };
}
