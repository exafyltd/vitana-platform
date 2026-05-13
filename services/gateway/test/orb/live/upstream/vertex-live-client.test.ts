/**
 * A7 (VTID-02956): Characterization tests for `VertexLiveClient`.
 *
 * Covers the seven boundary behaviors specified for the upstream extraction:
 *   1. Session connect (URL, headers, setup envelope, resolves on setup_complete)
 *   2. First audio path (server_content.model_turn.parts[].inline_data → onAudioOutput)
 *   3. Audio input forwarding (realtime_input.media_chunks wire shape)
 *   4. Model output events (transcript in/out, turn-complete, interrupted)
 *   5. Tool-call event forwarding (tool_call.function_calls[] → onToolCall)
 *   6. Disconnect/error propagation (transport errors, parse errors, premature close)
 *   7. Close/finalize behavior (idempotent close(), single onClose, no events after close)
 *
 * Uses a hand-rolled WebSocket mock — no real network access.
 */

import {
  VertexLiveClient,
  buildBidiGenerateContentUrl,
  buildSetupMessage,
  type VertexWebSocketLike,
} from '../../../../src/orb/live/upstream/vertex-live-client';
import type { UpstreamConnectOptions } from '../../../../src/orb/live/upstream/types';

// Mirror the value of `WebSocket.OPEN` (1) from the `ws` package so the
// mock can satisfy the readyState gate.
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

  // Test-only triggers.
  fireOpen(): void {
    this.openListeners.forEach((l) => l());
  }

  fireMessage(payload: unknown): void {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.messageListeners.forEach((l) => l(Buffer.from(str)));
  }

  fireError(err: Error): void {
    this.errorListeners.forEach((l) => l(err));
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
    getAccessToken: async () => 'test-token',
    connectTimeoutMs: 1000,
    ...overrides,
  };
}

async function connectClient(
  client: VertexLiveClient,
  socket: MockSocket,
  options: UpstreamConnectOptions = baseOptions(),
): Promise<void> {
  const connectPromise = client.connect(options);
  // Allow the async getAccessToken + factory call to settle.
  await new Promise((resolve) => setImmediate(resolve));
  socket.fireOpen();
  await new Promise((resolve) => setImmediate(resolve));
  socket.fireMessage({ setup_complete: {} });
  await connectPromise;
}

describe('A7 characterization: VertexLiveClient', () => {
  describe('1. Session connect', () => {
    it('builds the BidiGenerateContent URL for the given location', () => {
      expect(buildBidiGenerateContentUrl('us-central1')).toBe(
        'wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent',
      );
    });

    it('builds a Vertex setup envelope with snake_case fields + AUDIO modality', () => {
      const setup = buildSetupMessage(baseOptions()) as any;
      expect(setup.setup.model).toBe(
        'projects/lovable-vitana-vers1/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio',
      );
      expect(setup.setup.generation_config.response_modalities).toEqual(['AUDIO']);
      expect(setup.setup.generation_config.speech_config.voice_config.prebuilt_voice_config.voice_name).toBe(
        'Aoede',
      );
      expect(setup.setup.realtime_input_config.automatic_activity_detection.silence_duration_ms).toBe(
        2000,
      );
      expect(setup.setup.system_instruction.parts[0].text).toBe('You are Vitana.');
      expect(setup.setup.input_audio_transcription).toEqual({});
      expect(setup.setup.output_audio_transcription).toEqual({});
    });

    it('omits transcription envelopes when explicitly disabled', () => {
      const setup = buildSetupMessage(
        baseOptions({ enableInputTranscription: false, enableOutputTranscription: false }),
      ) as any;
      expect(setup.setup.input_audio_transcription).toBeUndefined();
      expect(setup.setup.output_audio_transcription).toBeUndefined();
    });

    it('switches modality to TEXT when responseModalities does not include audio', () => {
      const setup = buildSetupMessage(baseOptions({ responseModalities: ['text'] })) as any;
      expect(setup.setup.generation_config.response_modalities).toEqual(['TEXT']);
    });

    it('passes tools through as-is when supplied', () => {
      const tools = [{ function_declarations: [{ name: 'navigate_to_screen' }] }];
      const setup = buildSetupMessage(baseOptions({ tools })) as any;
      expect(setup.setup.tools).toEqual(tools);
    });

    it('opens the socket with the Authorization Bearer header from getAccessToken', async () => {
      const sockets: MockSocket[] = [];
      const headersCaptured: Array<Record<string, string>> = [];
      const client = new VertexLiveClient({
        createSocket: (_url, headers) => {
          const s = new MockSocket();
          sockets.push(s);
          headersCaptured.push(headers);
          return s;
        },
      });

      const connectPromise = client.connect(baseOptions());
      await new Promise((resolve) => setImmediate(resolve));
      sockets[0].fireOpen();
      await new Promise((resolve) => setImmediate(resolve));
      sockets[0].fireMessage({ setup_complete: {} });
      await connectPromise;

      expect(headersCaptured[0].Authorization).toBe('Bearer test-token');
      expect(headersCaptured[0]['Content-Type']).toBe('application/json');
    });

    it('sends the setup envelope as the first WS frame after `open`', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      await connectClient(client, socket);

      expect(socket.sent.length).toBeGreaterThanOrEqual(1);
      const setup = JSON.parse(socket.sent[0]);
      expect(setup.setup).toBeDefined();
      expect(setup.setup.model).toContain('gemini-live-2.5-flash-native-audio');
    });

    it('transitions idle → connecting → open across the handshake', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });

      expect(client.getState()).toBe('idle');
      const p = client.connect(baseOptions());
      // After the async factory dispatch:
      await new Promise((resolve) => setImmediate(resolve));
      expect(client.getState()).toBe('connecting');

      socket.fireOpen();
      await new Promise((resolve) => setImmediate(resolve));
      socket.fireMessage({ setup_complete: {} });
      await p;
      expect(client.getState()).toBe('open');
    });

    it('rejects a second connect() call', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      await connectClient(client, socket);

      await expect(client.connect(baseOptions())).rejects.toThrow(/invalid_state/);
    });
  });

  describe('2. First audio path', () => {
    it('emits onAudioOutput for inline_data audio in server_content.model_turn.parts[]', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const audioEvents: Array<{ dataB64: string; mimeType: string }> = [];
      client.onAudioOutput((e) => audioEvents.push(e));

      await connectClient(client, socket);

      socket.fireMessage({
        server_content: {
          model_turn: {
            parts: [{ inline_data: { mime_type: 'audio/pcm;rate=24000', data: 'AAAA' } }],
          },
        },
      });

      expect(audioEvents).toHaveLength(1);
      expect(audioEvents[0]).toEqual({ dataB64: 'AAAA', mimeType: 'audio/pcm;rate=24000' });
    });

    it('also accepts camelCase variants (serverContent.modelTurn.parts[].inlineData)', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const audioEvents: Array<{ dataB64: string; mimeType: string }> = [];
      client.onAudioOutput((e) => audioEvents.push(e));

      await connectClient(client, socket);

      socket.fireMessage({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BBBB' } }],
          },
        },
      });

      expect(audioEvents).toHaveLength(1);
      expect(audioEvents[0].dataB64).toBe('BBBB');
    });
  });

  describe('3. Audio input forwarding', () => {
    it('sendAudioChunk encodes realtime_input.media_chunks with mime + b64 data', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      await connectClient(client, socket);
      socket.sent.length = 0; // clear setup

      const result = client.sendAudioChunk('AUDIOB64', 'audio/pcm;rate=16000');
      expect(result).toBe(true);
      expect(socket.sent).toHaveLength(1);
      const parsed = JSON.parse(socket.sent[0]);
      expect(parsed.realtime_input.media_chunks).toEqual([
        { mime_type: 'audio/pcm;rate=16000', data: 'AUDIOB64' },
      ]);
    });

    it('sendAudioChunk returns false when socket is not open', () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      // Never connected.
      expect(client.sendAudioChunk('AAA')).toBe(false);
      expect(socket.sent).toHaveLength(0);
    });

    it('sendEndOfTurn sends client_content.turn_complete: true', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      await connectClient(client, socket);
      socket.sent.length = 0;

      expect(client.sendEndOfTurn()).toBe(true);
      const parsed = JSON.parse(socket.sent[0]);
      expect(parsed.client_content.turn_complete).toBe(true);
    });

    it('sendTextTurn wraps text into client_content.turns[].parts[].text with turn_complete=true by default', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      await connectClient(client, socket);
      socket.sent.length = 0;

      expect(client.sendTextTurn('hello there')).toBe(true);
      const parsed = JSON.parse(socket.sent[0]);
      expect(parsed.client_content.turns).toEqual([
        { role: 'user', parts: [{ text: 'hello there' }] },
      ]);
      expect(parsed.client_content.turn_complete).toBe(true);
    });
  });

  describe('4. Model output events (transcript, turn_complete, interrupted)', () => {
    it('emits onTranscript with direction="input" for input_transcription', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const events: Array<{ direction: string; text: string }> = [];
      client.onTranscript((e) => events.push(e));
      await connectClient(client, socket);

      socket.fireMessage({
        server_content: { input_transcription: { text: 'hello vitana' } },
      });
      expect(events).toEqual([{ direction: 'input', text: 'hello vitana' }]);
    });

    it('emits onTranscript with direction="output" for output_transcription', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const events: Array<{ direction: string; text: string }> = [];
      client.onTranscript((e) => events.push(e));
      await connectClient(client, socket);

      socket.fireMessage({
        server_content: { output_transcription: { text: 'hi dragan' } },
      });
      expect(events).toEqual([{ direction: 'output', text: 'hi dragan' }]);
    });

    it('accepts transcription as a bare string (legacy shape)', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const events: Array<{ direction: string; text: string }> = [];
      client.onTranscript((e) => events.push(e));
      await connectClient(client, socket);

      socket.fireMessage({
        server_content: { input_transcription: 'just words' },
      });
      expect(events).toEqual([{ direction: 'input', text: 'just words' }]);
    });

    it('emits onTurnComplete for server_content.turn_complete=true', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      let fired = false;
      client.onTurnComplete(() => {
        fired = true;
      });
      await connectClient(client, socket);

      socket.fireMessage({ server_content: { turn_complete: true } });
      expect(fired).toBe(true);
    });

    it('emits onInterrupted for server_content.interrupted=true', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      let fired = false;
      client.onInterrupted(() => {
        fired = true;
      });
      await connectClient(client, socket);

      socket.fireMessage({ server_content: { interrupted: true } });
      expect(fired).toBe(true);
    });
  });

  describe('5. Tool-call event forwarding', () => {
    it('emits onToolCall with parsed calls[] for tool_call.function_calls', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const events: Array<{ calls: any[] }> = [];
      client.onToolCall((e) => events.push(e));
      await connectClient(client, socket);

      socket.fireMessage({
        tool_call: {
          function_calls: [
            { id: 'call-1', name: 'navigate_to_screen', args: { route: '/diary' } },
          ],
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0].calls).toEqual([
        { name: 'navigate_to_screen', args: { route: '/diary' }, id: 'call-1' },
      ]);
    });

    it('also accepts camelCase toolCall.functionCalls', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const events: Array<{ calls: any[] }> = [];
      client.onToolCall((e) => events.push(e));
      await connectClient(client, socket);

      socket.fireMessage({
        toolCall: {
          functionCalls: [{ name: 'save_diary_entry', args: { content: 'hi' } }],
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0].calls[0].name).toBe('save_diary_entry');
    });

    it('does not emit onToolCall for empty function_calls array', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      let fired = false;
      client.onToolCall(() => {
        fired = true;
      });
      await connectClient(client, socket);

      socket.fireMessage({ tool_call: { function_calls: [] } });
      expect(fired).toBe(false);
    });
  });

  describe('6. Disconnect/error propagation', () => {
    it('connect() rejects on socket error during handshake', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const errors: any[] = [];
      client.onError((e) => errors.push(e));

      const p = client.connect(baseOptions());
      await new Promise((resolve) => setImmediate(resolve));
      socket.fireError(new Error('boom'));

      await expect(p).rejects.toThrow('boom');
      expect(client.getState()).toBe('error');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('transport_error');
    });

    it('connect() rejects on socket close during handshake', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });

      const p = client.connect(baseOptions());
      await new Promise((resolve) => setImmediate(resolve));
      socket.fireClose(1006, 'abnormal');

      await expect(p).rejects.toThrow(/closed during handshake/);
    });

    it('connect() rejects on timeout if no setup_complete arrives', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });

      const p = client.connect(baseOptions({ connectTimeoutMs: 10 }));
      await new Promise((resolve) => setImmediate(resolve));
      socket.fireOpen();
      // Deliberately do not fire setup_complete.

      await expect(p).rejects.toThrow(/timeout/);
      expect(client.getState()).toBe('error');
    });

    it('emits onError for post-handshake transport errors (not via reject)', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const errors: any[] = [];
      client.onError((e) => errors.push(e));

      await connectClient(client, socket);
      socket.fireError(new Error('stream broke'));

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('transport_error');
      expect(errors[0].message).toBe('stream broke');
    });

    it('emits onError with code="parse_error" for non-JSON messages', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const errors: any[] = [];
      client.onError((e) => errors.push(e));
      await connectClient(client, socket);

      socket.fireMessage('not-json-at-all');
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('parse_error');
    });
  });

  describe('7. Close/finalize behavior', () => {
    it('close() transitions to closed and emits onClose exactly once', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const closeEvents: any[] = [];
      client.onClose((e) => closeEvents.push(e));
      await connectClient(client, socket);

      await client.close();
      expect(client.getState()).toBe('closed');
      expect(closeEvents).toHaveLength(1);
      expect(closeEvents[0].initiatedLocally).toBe(true);
    });

    it('close() is idempotent', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const closeEvents: any[] = [];
      client.onClose((e) => closeEvents.push(e));
      await connectClient(client, socket);

      await client.close();
      await client.close();
      await client.close();
      expect(closeEvents).toHaveLength(1);
    });

    it('remote close emits onClose with initiatedLocally=false', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const closeEvents: any[] = [];
      client.onClose((e) => closeEvents.push(e));
      await connectClient(client, socket);

      socket.fireClose(1006, 'remote-bye');
      expect(closeEvents).toHaveLength(1);
      expect(closeEvents[0].initiatedLocally).toBe(false);
      expect(closeEvents[0].code).toBe(1006);
      expect(closeEvents[0].reason).toBe('remote-bye');
    });

    it('sendAudioChunk returns false after close', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      await connectClient(client, socket);
      await client.close();

      expect(client.sendAudioChunk('AAA')).toBe(false);
    });

    it('does not emit data events after close', async () => {
      const socket = new MockSocket();
      const client = new VertexLiveClient({ createSocket: () => socket });
      const audioEvents: any[] = [];
      client.onAudioOutput((e) => audioEvents.push(e));
      await connectClient(client, socket);
      await client.close();

      // The mock fires after close — implementation must filter.
      socket.fireMessage({
        server_content: {
          model_turn: { parts: [{ inline_data: { data: 'XXX' } }] },
        },
      });
      expect(audioEvents).toHaveLength(0);
    });
  });
});

// =============================================================================
// A8.3b.1 (VTID-02971): customSetupMessage + getSocket() extensions
// =============================================================================

describe('A8.3b.1: customSetupMessage override + getSocket() accessor', () => {
  it('uses customSetupMessage when provided (skips default buildSetupMessage envelope)', async () => {
    const socket = new MockSocket();
    const client = new VertexLiveClient({ createSocket: () => socket });
    const customEnvelope = {
      setup: {
        model: 'projects/orb-custom/locations/us-central1/publishers/google/models/foo',
        marker: 'A8.3b.1-custom',
      },
    };
    await connectClient(client, socket, baseOptions({
      customSetupMessage: () => customEnvelope,
    }));
    expect(socket.sent.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(socket.sent[0]);
    expect(sent).toEqual(customEnvelope);
    // Anti-regression: default envelope's model path must NOT appear when
    // customSetupMessage is set.
    expect(sent.setup.model).not.toContain('gemini-live-2.5-flash-native-audio');
  });

  it('awaits an async customSetupMessage before sending', async () => {
    const socket = new MockSocket();
    const client = new VertexLiveClient({ createSocket: () => socket });
    let resolveBuilder!: (envelope: Record<string, unknown>) => void;
    const builderPromise = new Promise<Record<string, unknown>>((r) => {
      resolveBuilder = r;
    });
    const connectPromise = client.connect(baseOptions({
      customSetupMessage: () => builderPromise,
    }));
    // Allow the async getAccessToken + factory call to settle.
    await new Promise((resolve) => setImmediate(resolve));
    socket.fireOpen();
    await new Promise((resolve) => setImmediate(resolve));
    // Builder has NOT resolved yet — no setup envelope should have been
    // sent.
    expect(socket.sent).toHaveLength(0);
    // Resolve the builder. The handler awaits it inside ws.on('open').
    resolveBuilder({ setup: { marker: 'A8.3b.1-async' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.sent).toHaveLength(1);
    const sent = JSON.parse(socket.sent[0]);
    expect(sent).toEqual({ setup: { marker: 'A8.3b.1-async' } });
    socket.fireMessage({ setup_complete: {} });
    await connectPromise;
  });

  it('getSocket() returns null before connect()', () => {
    const client = new VertexLiveClient({ createSocket: () => new MockSocket() });
    expect(client.getSocket()).toBeNull();
  });

  it('getSocket() returns the underlying socket after connect() opens it', async () => {
    const socket = new MockSocket();
    const client = new VertexLiveClient({ createSocket: () => socket });
    await connectClient(client, socket);
    // The factory returned the mock; getSocket() must hand the same
    // instance back so orb-live.ts's adapter can attach the legacy
    // message/error/close handlers to it.
    expect(client.getSocket()).toBe(socket);
  });

  it('default buildSetupMessage path still works when customSetupMessage is omitted', async () => {
    const socket = new MockSocket();
    const client = new VertexLiveClient({ createSocket: () => socket });
    await connectClient(client, socket);
    const sent = JSON.parse(socket.sent[0]);
    // Default builder includes the canonical Vertex model path + AUDIO modality.
    expect(sent.setup.model).toContain('gemini-live-2.5-flash-native-audio');
    expect(sent.setup.generation_config.response_modalities).toEqual(['AUDIO']);
  });
});
