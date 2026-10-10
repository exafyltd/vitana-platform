/**
 * LiveKit Agents POC — configuration scaffold (VTID-04772)
 *
 * Proof-of-concept infrastructure for a modular LiveKit Agents voice pipeline,
 * introduced as the code-level step of the `redesign_pipeline` recommendation
 * accepted by the operator for the `voice.model_under_responds` failure class
 * (signature: model_under_responds_r100plus).
 *
 * This module is STRICTLY ADDITIVE:
 *   - It never modifies the existing Nova Sonic / cascade / Serbian-bridge paths.
 *   - It is never imported by any existing route or service.
 *   - It defaults to disabled (LIVEKIT_POC_ENABLED unset → false).
 *   - It contains no Google/Vertex/GCP dependency.
 *   - The LLM stage, when the POC is eventually wired up, must use AWS Bedrock
 *     (CLAUDE.md ALWAYS rule 10a) — never the direct Anthropic API.
 *
 * Governance: VTID-04772. Do not enable LIVEKIT_POC_ENABLED in any ECS task
 * definition or .env file without a separate operator-approved VTID.
 */

export interface LiveKitPocConfig {
  /** WebSocket URL of the LiveKit server, e.g. wss://my-livekit.example.com */
  url: string;
  /** LiveKit API key (server-side credential). */
  apiKey: string;
  /** LiveKit API secret (server-side credential). */
  apiSecret: string;
}

/**
 * Returns true when LIVEKIT_POC_ENABLED is set to the string 'true'.
 * All other values (including unset) return false.
 *
 * This is a cheap synchronous check — callers that only need a boolean guard
 * should use this rather than getLiveKitPocConfig().
 */
export function isLiveKitPocEnabled(): boolean {
  return process.env.LIVEKIT_POC_ENABLED === 'true';
}

/**
 * Returns the LiveKit POC configuration when the feature flag is on AND all
 * three required coordinate env vars are present and non-empty.
 *
 * Returns null when:
 *   - LIVEKIT_POC_ENABLED is not 'true', OR
 *   - any of LIVEKIT_POC_URL / LIVEKIT_POC_API_KEY / LIVEKIT_POC_API_SECRET
 *     is missing or empty.
 *
 * Never throws.
 */
export function getLiveKitPocConfig(): LiveKitPocConfig | null {
  if (!isLiveKitPocEnabled()) return null;

  const url = process.env.LIVEKIT_POC_URL ?? '';
  const apiKey = process.env.LIVEKIT_POC_API_KEY ?? '';
  const apiSecret = process.env.LIVEKIT_POC_API_SECRET ?? '';

  if (!url || !apiKey || !apiSecret) return null;

  return { url, apiKey, apiSecret };
}
