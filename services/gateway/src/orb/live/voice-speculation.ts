/**
 * Voice establishment speculation — Phase 1 W2
 * (BOOTSTRAP-VOICE-LATENCY-SPECULATION, follows VTID-03181 VOICE-LAT).
 *
 * GOAL: cut the turn-0 (click → first greeting audio) latency on the ORB voice
 * path by running a deterministic, side-effect-free establishment step
 * SPECULATIVELY in parallel with the upstream WS handshake instead of serially
 * after it.
 *
 * The step we speculate is the persona-voice resolution. Today it runs inside
 * `buildOrbVertexSetupEnvelope` — i.e. AFTER `upstream_connected` AND AFTER
 * `await contextReadyPromise` (the `context_awaited` mark). On a cold persona
 * registry cache it is a DB/registry round-trip sitting squarely on the
 * critical path between `context_awaited` and `setup_sent`, blocking the setup
 * envelope (and therefore the greeting / first audio).
 *
 * The resolved voice does NOT depend on the WS handshake or on the context
 * build — only on (persona, tenant) which are known the instant we decide to
 * connect. So we can resolve it speculatively at connect-START, overlapping it
 * with the handshake + context build. By the time the envelope builder runs,
 * the answer is already in hand and the lookup is removed from the hot path.
 *
 * SAFETY / NO-OP CONTRACT:
 *   - Gated behind FEATURE_VOICE_SPECULATION_ENV (default 'off').
 *   - When OFF, `beginVoiceSpeculation` returns null and the caller takes the
 *     EXACT pre-existing inline path — byte-for-byte identical wire payload.
 *   - The speculated resolver and the inline fallback call the SAME registry
 *     functions with the SAME arguments, so the resolved value is identical;
 *     speculation only changes WHEN the lookup runs, never WHAT it returns.
 *   - The resolver is read-only (registry lookup) and its rejection is
 *     swallowed → the caller falls back to the inline lookup. Speculation can
 *     only ever SAVE latency or be a no-op; it can never change output or fail
 *     the connect.
 *
 * MEASUREMENT:
 *   - `consumeSpeculatedVoice` records the speculative resolve time and emits
 *     `voice.latency.measured` (surface 'voice', phase-style payload) carrying
 *     speculative_ms vs an inline baseline estimate, so the win is provable in
 *     shadow BEFORE the flag is flipped to live behaviour.
 */

import { emitOasisEvent } from '../../services/oasis-event-service';
import { isFeatureLive } from '../../services/feature-flags';

export const VOICE_SPECULATION_FEATURE = 'VOICE_SPECULATION';
export const VOICE_SPECULATION_VTID = 'BOOTSTRAP-VOICE-LATENCY-SPECULATION';

/** Resolves a persona's voice id. Same shape as the inline registry calls. */
export type VoiceResolver = () => Promise<string | undefined>;

export interface VoiceSpeculationInput {
  session_id: string;
  actor_id?: string;
  /** Active persona key (receptionist by default). */
  persona: string;
  /** Tenant scope, if the session carries one (drives tenant-aware lookup). */
  tenant_id?: string | null;
  /** Provider/model hint for the telemetry payload. */
  provider?: string;
}

/** Opaque handle returned by `beginVoiceSpeculation`; passed to `consumeSpeculatedVoice`. */
export interface VoiceSpeculationHandle {
  readonly session_id: string;
  readonly persona: string;
  readonly tenant_id?: string | null;
  readonly actor_id?: string;
  readonly provider?: string;
  /** Epoch ms the speculative resolve was kicked off. */
  readonly started_ms: number;
  /** In-flight (or settled) speculative resolution. Never rejects. */
  readonly promise: Promise<string | undefined>;
}

/**
 * Decide whether to speculate. Pure guard so it is unit-testable without
 * touching the registry or the clock.
 *
 * We only speculate when:
 *   - the feature is live on this environment, AND
 *   - we actually have a persona key to resolve.
 * The (persona, tenant) inputs are the sole determinants of the resolved
 * voice, so this guard guarantees the speculated value can equal the inline
 * value.
 */
export function shouldSpeculateVoice(
  input: Pick<VoiceSpeculationInput, 'persona'>,
  featureLive: boolean,
): boolean {
  if (!featureLive) return false;
  if (!input.persona || input.persona.trim() === '') return false;
  return true;
}

/**
 * Compute the latency delta attributable to speculation. Pure arithmetic,
 * clamped to non-negative so a noisy clock never reports a "negative win".
 *
 *   saved = inlineBaseline - speculative-residual-on-hot-path
 *
 * When the speculative resolve has already settled by the time the envelope
 * builder consumes it (the common, happy case), the residual on the hot path
 * is ~0, so the saved time equals the inline baseline. When it has NOT settled
 * yet, the caller awaits it; the residual is whatever was left, and the saved
 * time is the difference.
 */
export function computeSpeculationSavingsMs(
  inlineBaselineMs: number,
  speculativeResidualMs: number,
): number {
  const saved = inlineBaselineMs - speculativeResidualMs;
  return saved > 0 ? Math.round(saved) : 0;
}

/**
 * Begin resolving the persona voice speculatively. Call this at connect-START
 * (alongside / before the WS handshake). Returns null when speculation is OFF
 * or ineligible — in that case the caller MUST take its existing inline path,
 * unchanged.
 *
 * The returned promise NEVER rejects: a resolver failure resolves to undefined
 * so the consumer falls back to the inline lookup transparently.
 */
export function beginVoiceSpeculation(
  input: VoiceSpeculationInput,
  resolver: VoiceResolver,
  now: () => number = Date.now,
): VoiceSpeculationHandle | null {
  if (!shouldSpeculateVoice(input, isFeatureLive(VOICE_SPECULATION_FEATURE))) {
    return null;
  }

  const started_ms = now();
  // Kick the resolver off immediately; isolate its rejection so it can never
  // surface on the connect path.
  const promise = Promise.resolve()
    .then(resolver)
    .catch(() => undefined);

  return {
    session_id: input.session_id,
    persona: input.persona,
    tenant_id: input.tenant_id,
    actor_id: input.actor_id,
    provider: input.provider,
    started_ms,
    promise,
  };
}

/**
 * Consume a speculative resolution at the point the envelope builder needs the
 * voice. Awaits the (already in-flight) speculative resolve, measures how much
 * of it was hidden behind the handshake/context build, and emits a
 * `voice.latency.measured` comparison so the win is shadow-measurable.
 *
 * Returns the resolved voice id (or undefined → caller falls back to the
 * language-default voice exactly as the inline path does). The byte value
 * returned here is identical to what the inline lookup would have produced.
 *
 * @param handle           handle from `beginVoiceSpeculation` (null → no-op, returns undefined)
 * @param inlineBaselineMs caller's measured/typical inline lookup cost, used as
 *                         the baseline for the savings comparison.
 */
export async function consumeSpeculatedVoice(
  handle: VoiceSpeculationHandle | null,
  inlineBaselineMs: number,
  now: () => number = Date.now,
): Promise<string | undefined> {
  if (!handle) return undefined;

  const awaitStart = now();
  const voice = await handle.promise;
  const residualMs = now() - awaitStart; // hot-path time NOT hidden by overlap
  const totalSpeculativeMs = now() - handle.started_ms;
  const savedMs = computeSpeculationSavingsMs(inlineBaselineMs, residualMs);

  // Fire-and-forget; telemetry must never affect the connect path.
  void emitOasisEvent({
    vtid: VOICE_SPECULATION_VTID,
    type: 'voice.latency.measured',
    source: 'gateway/voice-speculation',
    status: 'success',
    message: `voice-speculation saved ~${savedMs}ms (residual ${residualMs}ms vs baseline ${inlineBaselineMs}ms)`,
    actor_id: handle.actor_id,
    payload: {
      session_id: handle.session_id,
      surface: 'voice',
      turn: 0,
      provider: handle.provider,
      speculation: true,
      step: 'persona_voice_resolve',
      persona: handle.persona,
      tenant_scoped: !!handle.tenant_id,
      resolved: voice !== undefined,
      // Comparison the win is judged on:
      inline_baseline_ms: inlineBaselineMs,
      speculative_total_ms: totalSpeculativeMs,
      speculative_residual_ms: residualMs,
      saved_ms: savedMs,
    },
  }).catch(() => { /* never break the connect on telemetry */ });

  return voice;
}
