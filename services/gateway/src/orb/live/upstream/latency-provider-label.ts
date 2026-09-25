/**
 * VTID-04531 — the provider label that a voice per-turn LatencyTracker carries
 * into `voice.latency.measured`.
 *
 * Before this file, `startVoiceTurnLatency()` (routes/orb-live.ts) labelled
 * every session whose `upstreamProvider` was not `nova_sonic` as
 * `vertex/${GEMINI_MODEL}` — a leftover from the GEMINI_API_KEY era, where
 * `GEMINI_MODEL = 'gemini-2.0-flash-exp'` was a live model selector. Today it
 * is stale legacy labelling (see the GEMINI_MODEL note in the engineering
 * memory), so two very different real pipelines were both misreported:
 *
 *   - the cascade (Transcribe -> Bedrock -> Polly/Fish), which names no single
 *     model at all, was charted as if one Gemini model served the turn;
 *   - the Vertex Serbian bridge was charted under a model id it does not use.
 *
 * This is the single place the label is chosen, so it is testable without
 * loading the 18k-line route file and cannot drift back to a hardcoded default.
 *
 * Sources of truth — deliberately NOT re-declared here:
 *   - Nova Sonic:   `NOVA_SONIC_MODEL_ID` (upstream/nova-sonic-config.ts)
 *   - Vertex Live:  `VERTEX_LIVE_MODEL` (orb/live/protocol.ts) — the configured
 *     Vertex Live model id the remaining Vertex path runs on; on AWS the
 *     api_key transport overrides the wire model from `AI_STUDIO_LIVE_MODEL`
 *     (see gemini-api-key-live-client.ts), but no branch of this codebase
 *     holds a Serbian-bridge-specific model id, so the configured Vertex Live
 *     model is the fact to report rather than one invented here.
 *   - Cascade:      a dedicated, model-less label. The three hops each have
 *     their own provider (Transcribe / Bedrock `llm_routing_policy` / Polly or
 *     Fish), so there is no single model id to put after a slash; the
 *     dashboards need one stable grouping key for the pipeline instead.
 */

import { VERTEX_LIVE_MODEL } from '../protocol';
import { NOVA_SONIC_MODEL_ID } from './nova-sonic-config';
import type { VoiceProviderName } from './provider-name';

/**
 * The cascade's provider label. `cascaded` is the provider name everywhere
 * else (provider-name.ts, upstream-client-factory.ts); the label is the
 * dashboard-facing grouping key and stays short on purpose.
 */
export const CASCADE_LATENCY_LABEL = 'cascade';

/**
 * Provider label for a voice session's latency timeline. Accepts the raw
 * `session.upstreamProvider` (trusted internal value, but typed loosely so a
 * caller does not need a cast) and never throws: anything unrecognised falls
 * back to the Vertex Live label, which is the pre-VTID-04531 behaviour minus
 * the stale model name.
 */
export function resolveLatencyProviderLabel(
  provider: VoiceProviderName | string | null | undefined,
): string {
  switch (provider) {
    case 'nova_sonic':
      return `nova_sonic/${NOVA_SONIC_MODEL_ID}`;
    case 'cascaded':
      return CASCADE_LATENCY_LABEL;
    case 'vertex':
    default:
      return `vertex/${VERTEX_LIVE_MODEL}`;
  }
}
