/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: canonical voice-to-voice provider name type
 * and parser.
 *
 * One source of truth for the set of top-level upstream voice providers the
 * gateway can select between. Everything that names a provider — the
 * selector, the client factory, the active-provider control plane, health
 * output, telemetry — must go through `VoiceProviderName` /
 * `parseVoiceProviderName` rather than re-declaring string unions.
 *
 * Rules:
 *   - Parsing is strict: exact match after trim + lowercase. There are no
 *     aliases (`'novasonic'`, `'nova-sonic'`, `'google'` etc. are invalid) —
 *     an unknown string returns `null` and the caller degrades to the
 *     default provider with a typed validation reason. Silent coercion of a
 *     misspelled provider is how traffic ends up on the wrong upstream.
 *   - `'livekit'` is a transport-level provider (WebRTC/agent path) and is
 *     part of this union even though it does not implement
 *     `UpstreamLiveClient` — the selector must be able to express it.
 */

export const VOICE_PROVIDER_NAMES = ['vertex', 'livekit', 'nova_sonic'] as const;

export type VoiceProviderName = (typeof VOICE_PROVIDER_NAMES)[number];

/** Type guard for `VoiceProviderName`. */
export function isVoiceProviderName(value: unknown): value is VoiceProviderName {
  return (
    typeof value === 'string' &&
    (VOICE_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Parse an untrusted provider string (env var, DB row, request body) into a
 * `VoiceProviderName`, or `null` when it names no known provider.
 *
 * Trims surrounding whitespace and lowercases before matching; performs NO
 * other normalization (no alias mapping, no separator fixing).
 */
export function parseVoiceProviderName(value: unknown): VoiceProviderName | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isVoiceProviderName(normalized) ? normalized : null;
}
