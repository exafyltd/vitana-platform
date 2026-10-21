/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 5): upstream client factory tests.
 */

import { createUpstreamClient } from '../../../../src/orb/live/upstream/upstream-client-factory';
import { VertexLiveClient } from '../../../../src/orb/live/upstream/vertex-live-client';
import { GeminiApiKeyLiveClient } from '../../../../src/orb/live/upstream/gemini-api-key-live-client';
import { NovaSonicLiveClient } from '../../../../src/orb/live/upstream/nova-sonic-live-client';
import { getNovaSonicConfig } from '../../../../src/orb/live/upstream/nova-sonic-config';

describe('createUpstreamClient', () => {
  it('builds VertexLiveClient for vertex', () => {
    expect(createUpstreamClient('vertex', {})).toBeInstanceOf(VertexLiveClient);
  });

  it('builds GeminiApiKeyLiveClient for vertex when the API-key path is selected', () => {
    const client = createUpstreamClient('vertex', {
      geminiApiKey: { useApiKeyClient: true, getApiKey: async () => 'k' },
    });
    expect(client).toBeInstanceOf(GeminiApiKeyLiveClient);
  });

  it('builds NovaSonicLiveClient for nova_sonic with deps', () => {
    const client = createUpstreamClient('nova_sonic', {
      nova: {
        config: getNovaSonicConfig({ NOVA_SONIC_ENABLED: 'true' } as NodeJS.ProcessEnv),
        voiceId: 'tina',
        createBedrockClient: () => ({ send: async () => ({ body: undefined }) }),
        createCommand: (i) => i,
      },
    });
    expect(client).toBeInstanceOf(NovaSonicLiveClient);
  });

  it('nova_sonic without deps is a typed error', () => {
    expect(() => createUpstreamClient('nova_sonic', {})).toThrow(/nova_not_configured/);
  });

  it('livekit is rejected — it has its own WebRTC/agent transport', () => {
    expect(() => createUpstreamClient('livekit' as never, {})).toThrow(
      /upstream_factory_invalid_provider/,
    );
  });
});
