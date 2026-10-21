/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 5): one factory for every upstream live
 * client the gateway can construct.
 *
 * `livekit` is deliberately excluded — LiveKit rides its own WebRTC/agent
 * transport (orb-livekit.ts) and never implements `UpstreamLiveClient`;
 * asking this factory for it is a programming error, not a fallback.
 */

import type { VoiceProviderName } from './provider-name';
import type { UpstreamLiveClient } from './types';
import { VertexLiveClient, type VertexLiveClientDeps } from './vertex-live-client';
import {
  GeminiApiKeyLiveClient,
  type GeminiApiKeyLiveClientDeps,
} from './gemini-api-key-live-client';
import {
  NovaSonicLiveClient,
  type NovaSonicLiveClientDeps,
} from './nova-sonic-live-client';
import {
  CascadedLiveClient,
  type CascadedLiveClientDeps,
} from './cascaded-live-client';

export type FactoryProviderName = Exclude<VoiceProviderName, 'livekit'>;

export interface UpstreamClientFactoryDeps {
  vertex?: VertexLiveClientDeps;
  /** When set (AWS runtime without GCP ADC), Vertex requests build the
   *  API-key Gemini client instead of the OAuth Vertex client. */
  geminiApiKey?: GeminiApiKeyLiveClientDeps & { useApiKeyClient?: boolean };
  nova?: NovaSonicLiveClientDeps;
  /** VTID-03683: Transcribe -> Bedrock -> Polly, for Nova-unsupported languages. */
  cascaded?: CascadedLiveClientDeps;
}

export function createUpstreamClient(
  provider: FactoryProviderName,
  deps: UpstreamClientFactoryDeps,
): UpstreamLiveClient {
  switch (provider) {
    case 'vertex':
      if (deps.geminiApiKey?.useApiKeyClient) {
        return new GeminiApiKeyLiveClient(deps.geminiApiKey);
      }
      return new VertexLiveClient(deps.vertex ?? {});
    case 'nova_sonic': {
      if (!deps.nova) {
        throw new Error('nova_not_configured: NovaSonicLiveClientDeps required to construct the Nova client');
      }
      return new NovaSonicLiveClient(deps.nova);
    }
    case 'cascaded': {
      if (!deps.cascaded) {
        throw new Error(
          'cascaded_not_configured: CascadedLiveClientDeps required to construct the cascaded client',
        );
      }
      return new CascadedLiveClient(deps.cascaded);
    }
    default: {
      // Exhaustiveness: 'livekit' (and anything else) must never get here.
      const invalid: never = provider;
      throw new Error(`upstream_factory_invalid_provider: ${String(invalid)}`);
    }
  }
}
