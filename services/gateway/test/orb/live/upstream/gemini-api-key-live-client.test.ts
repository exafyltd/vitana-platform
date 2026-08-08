/**
 * BOOTSTRAP-AWS-STAGING-VALIDATION: Characterization tests for
 * `GeminiApiKeyLiveClient` — the AI Studio (API-key auth) sibling of
 * `VertexLiveClient`, added so ORB voice can run on AWS without a GCP
 * service-account credential (see file header in
 * gemini-api-key-live-client.ts for the full rationale).
 *
 * Focuses on what's actually NEW relative to VertexLiveClient (URL/auth,
 * model-id rewrite) plus a basic connect/dispatch/close smoke pass to
 * confirm the duplicated lifecycle logic behaves identically. Uses the
 * same hand-rolled WebSocket mock pattern as vertex-live-client.test.ts —
 * no real network access.
 */

import {
  GeminiApiKeyLiveClient,
  buildAiStudioBidiGenerateContentUrl,
  toAiStudioModelId,
} from '../../../../src/orb/live/upstream/gemini-api-key-live-client';
import type { VertexWebSocketLike } from '../../../../src/orb/live/upstream/vertex-live-client';
import type { UpstreamConnectOptions } from '../../../../src/orb/live/upstream/types';

const WS_OPEN = 1;
const WS_CLOSED = 3;

class MockSocket implements VertexWebSocketLike {
  readyState = WS_OPEN;
  sent: string[] = [];

  private openListeners: Array<() => void> = [];
  private messageListeners: Array<(data: any) => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];
  private closeListeners: Array<(code: number, reason: Buffer) => void> = [];

  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: any) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: string, listener: (...args: any[]) => void): void {
    if (event === 'open') this.openListeners.push(listener as () => void);
    else if (event === 'message') this.messageListeners.push(listener as (d: any) => void);
    else if (event === 'error') this.errorListeners.push(listener as (e: Error) => void);
    else if (event === 'close')
      this.closeListeners.push(listener as (c: number, r: Buffer) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WS_CLOSED;
  }

  fireOpen(): void {
    this.openListeners.forEach((l) => l());
  }

  fireMessage(payload: unknown): void {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.messageListeners.forEach((l) => l(Buffer.from(str)));
  }

  fireClose(code: number = 1000, reason: string = 'normal'): void {
    this.readyState = WS_CLOSED;
    this.closeListeners.forEach((l) => l(code, Buffer.from(reason)));
  }
}

function baseOptions(overrides: Partial<UpstreamConnectOptions> = {}): UpstreamConnectOptions {
  return {
    model: 'gemini-live-2.5-flash-native-audio',
    projectId: 'lovable-vitana-vers1',
    location: 'us-central1',
    voiceName: 'Aoede',
    responseModalities: ['audio'],
    vadSilenceMs: 2000,
    systemInstruction: 'You are Vitana.',
    getAccessToken: async () => 'test-api-key',
    connectTimeoutMs: 1000,
    ...overrides,
  };
}

async function connectClient(
  client: GeminiApiKeyLiveClient,
  socket: MockSocket,
  options: UpstreamConnectOptions = baseOptions(),
): Promise<void> {
  const connectPromise = client.connect(options);
  await new Promise((resolve) => setImmediate(resolve));
  socket.fireOpen();
  await new Promise((resolve) => setImmediate(resolve));
  socket.fireMessage({ setup_complete: {} });
  await connectPromise;
}

describe('BOOTSTRAP-AWS-STAGING-VALIDATION: GeminiApiKeyLiveClient', () => {
  describe('URL + model-id rewrite (the actual new behavior)', () => {
    it('builds the AI Studio BidiGenerateContent URL with the key as a query param', () => {
      expect(buildAiStudioBidiGenerateContentUrl('my-key')).toBe(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=my-key',
      );
    });

    it('URL-encodes special characters in the key', () => {
      expect(buildAiStudioBidiGenerateContentUrl('a/b+c')).toBe(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=a%2Fb%2Bc',
      );
    });

    it('adds the models/ prefix to a bare model id', () => {
      expect(toAiStudioModelId('gemini-2.5-flash-native-audio-latest')).toBe(
        'models/gemini-2.5-flash-native-audio-latest',
      );
    });

    it('passes through an already-prefixed model id unchanged (idempotent)', () => {
      expect(toAiStudioModelId('models/gemini-2.5-flash-native-audio-latest')).toBe(
        'models/gemini-2.5-flash-native-audio-latest',
      );
    });
  });

  describe('connect() always overrides setup.model to the AI Studio catalog', () => {
    it('overrides the Vertex-shaped model from the default builder', async () => {
      const socket = new MockSocket();
      const client = new GeminiApiKeyLiveClient({ createSocket: () => socket });
      await connectClient(client, socket);

      expect(client.getState()).toBe('open');
      const sentSetup = JSON.parse(socket.sent[0]);
      // baseOptions() sets model to a Vertex-catalog id (gemini-live-2.5-...) —
      // confirmed unreachable via AI Studio's endpoint (code 1008). The client
      // must always substitute its own AI_STUDIO_LIVE_MODEL, not derive from it.
      expect(sentSetup.setup.model).toBe('models/gemini-2.5-flash-native-audio-latest');
      // Rest of the envelope is untouched — same builder as Vertex.
      expect(sentSetup.setup.generation_config.response_modalities).toEqual(['AUDIO']);
    });

    it('default builder works WITHOUT GCP projectId/location — AI Studio needs no GCP identity', async () => {
      const socket = new MockSocket();
      const client = new GeminiApiKeyLiveClient({ createSocket: () => socket });
      await connectClient(client, socket, baseOptions({ projectId: undefined, location: undefined }));

      expect(client.getState()).toBe('open');
      const sentSetup = JSON.parse(socket.sent[0]);
      // The Vertex-shaped path from placeholders is discarded — the AI Studio
      // catalog id must be what actually goes on the wire.
      expect(sentSetup.setup.model).toBe('models/gemini-2.5-flash-native-audio-latest');
    });

    it('overrides the model from a customSetupMessage override too', async () => {
      const socket = new MockSocket();
      const client = new GeminiApiKeyLiveClient({ createSocket: () => socket });
      const options = baseOptions({
        customSetupMessage: () => ({
          setup: {
            model:
              'projects/lovable-vitana-vers1/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio',
            system_instruction: { parts: [{ text: 'persona override' }] },
          },
        }),
      });
      await connectClient(client, socket, options);

      const sentSetup = JSON.parse(socket.sent[0]);
      expect(sentSetup.setup.model).toBe('models/gemini-2.5-flash-native-audio-latest');
      expect(sentSetup.setup.system_instruction.parts[0].text).toBe('persona override');
    });

    it('does not attach an Authorization header (auth travels via the URL key param)', async () => {
      const socket = new MockSocket();
      let capturedHeaders: Record<string, string> | undefined;
      const client = new GeminiApiKeyLiveClient({
        createSocket: (_url, headers) => {
          capturedHeaders = headers;
          return socket;
        },
      });
      await connectClient(client, socket);
      expect(capturedHeaders?.Authorization).toBeUndefined();
    });
  });

  describe('handshake-close diagnostics', () => {
    it('rejects with the close reason text when the server closes before setup_complete', async () => {
      const socket = new MockSocket();
      const client = new GeminiApiKeyLiveClient({ createSocket: () => socket });
      const connectPromise = client.connect(baseOptions());
      await new Promise((resolve) => setImmediate(resolve));
      socket.fireOpen();
      await new Promise((resolve) => setImmediate(resolve));
      socket.fireClose(1008, 'invalid_argument: setup.model unsupported');
      await expect(connectPromise).rejects.toThrow(
        'Live API closed during handshake (code=1008): invalid_argument: setup.model unsupported',
      );
    });
  });

  describe('dispatch + close parity with VertexLiveClient', () => {
    it('forwards audio output and tool calls after connect', async () => {
      const socket = new MockSocket();
      const client = new GeminiApiKeyLiveClient({ createSocket: () => socket });
      const audioEvents: unknown[] = [];
      const toolEvents: unknown[] = [];
      client.onAudioOutput((e) => audioEvents.push(e));
      client.onToolCall((e) => toolEvents.push(e));
      await connectClient(client, socket);

      socket.fireMessage({
        server_content: {
          model_turn: { parts: [{ inline_data: { data: 'QUJD', mime_type: 'audio/pcm;rate=24000' } }] },
        },
      });
      socket.fireMessage({ tool_call: { function_calls: [{ name: 'navigate', args: {}, id: '1' }] } });

      expect(audioEvents).toEqual([{ dataB64: 'QUJD', mimeType: 'audio/pcm;rate=24000' }]);
      expect(toolEvents).toEqual([{ calls: [{ name: 'navigate', args: {}, id: '1' }] }]);
    });

    it('close() is idempotent and emits onClose exactly once', async () => {
      const socket = new MockSocket();
      const client = new GeminiApiKeyLiveClient({ createSocket: () => socket });
      let closeCount = 0;
      client.onClose(() => { closeCount += 1; });
      await connectClient(client, socket);

      await client.close();
      await client.close();
      expect(closeCount).toBe(1);
      expect(client.getState()).toBe('closed');
    });
  });
});

// BOOTSTRAP-NOVA-SONIC-VOICE — Task 1 contract additions.
describe('provider-neutral contract additions (BOOTSTRAP-NOVA-SONIC-VOICE)', () => {
  it('sendToolResult sends the shared tool_response envelope', async () => {
    const socket = new MockSocket();
    const client = new GeminiApiKeyLiveClient({ createSocket: () => socket });
    await connectClient(client, socket);

    const sent = client.sendToolResult({
      callId: 'call-9',
      name: 'get_current_screen',
      success: true,
      output: '{"screen":"journey"}',
    });
    expect(sent).toBe(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      tool_response: {
        function_responses: [
          { name: 'get_current_screen', response: { output: '{"screen":"journey"}' } },
        ],
      },
    });
  });

  it('constructor getApiKey dep takes precedence over the deprecated options hook', async () => {
    const socket = new MockSocket();
    let capturedUrl = '';
    const client = new GeminiApiKeyLiveClient({
      createSocket: (url) => {
        capturedUrl = url;
        return socket;
      },
      getApiKey: async () => 'dep-key',
    });
    await connectClient(client, socket);
    expect(capturedUrl).toContain('key=dep-key');
  });

  it('connect rejects with a typed error when no key supplier exists anywhere', async () => {
    const client = new GeminiApiKeyLiveClient({ createSocket: () => new MockSocket() });
    const options = baseOptions();
    delete (options as Record<string, unknown>).getAccessToken;
    await expect(client.connect(options)).rejects.toThrow(/gemini_config_missing/);
  });

  it('close(reason) surfaces the reason and transcript deltas carry isFinal: false', async () => {
    const socket = new MockSocket();
    const client = new GeminiApiKeyLiveClient({ createSocket: () => socket });
    const transcripts: Array<{ isFinal: boolean }> = [];
    const closes: Array<{ reason?: string }> = [];
    client.onTranscript((e) => transcripts.push(e));
    client.onClose((e) => closes.push(e));
    await connectClient(client, socket);
    socket.fireMessage({ server_content: { output_transcription: { text: 'hi' } } });
    await client.close('provider_stream_rotation');
    expect(transcripts).toEqual([
      expect.objectContaining({ text: 'hi', isFinal: false }),
    ]);
    expect(closes).toEqual([expect.objectContaining({ reason: 'provider_stream_rotation' })]);
  });
});
