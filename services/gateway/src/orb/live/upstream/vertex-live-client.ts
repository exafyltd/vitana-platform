/**
 * A7 (orb-live-refactor / VTID-02956): Vertex AI Live API implementation of
 * `UpstreamLiveClient`.
 *
 * This is the provider-specific seam. Vendor JSON shapes (snake_case
 * `realtime_input.media_chunks`, `server_content.model_turn.parts[].inline_data`,
 * etc.) live inside this file and never leak past the interface.
 *
 * Behavior parity with the legacy `connectToLiveAPI` in `routes/orb-live.ts`:
 *   - Connects via `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`.
 *   - Sends `setup` envelope with model, generation config, VAD config,
 *     input/output transcription, system instruction, and (optionally) tools.
 *   - Audio out: `server_content.model_turn.parts[].inline_data` (24kHz PCM b64).
 *   - Transcripts: `server_content.input_transcription` / `output_transcription`.
 *   - Tool calls: `tool_call.function_calls[]`.
 *   - Turn complete: `server_content.turn_complete: true`.
 *   - Interrupted: `server_content.interrupted: true` (or `grounding_metadata.interrupted`).
 *   - Audio in: `realtime_input.media_chunks[]` with `mime_type` + base64 `data`.
 *   - End-of-turn: `client_content.turn_complete: true`.
 *
 * What this file does NOT do:
 *   - Persona/voice swap (session-level concern, stays in orb-live.ts).
 *   - Watchdog timers (session-level concern).
 *   - Transcript buffering / OASIS event emission (session-level concern).
 *   - Identity / memory context build (session-level concern).
 *
 * Those orchestration layers consume this client through the
 * `UpstreamLiveClient` interface in A8/A9.
 */

import WebSocket from 'ws';
import type {
  AudioOutputEvent,
  InterruptedEvent,
  ToolCallEvent,
  TranscriptEvent,
  TurnCompleteEvent,
  UpstreamCloseEvent,
  UpstreamConnectOptions,
  UpstreamConnectionState,
  UpstreamErrorEvent,
  UpstreamLiveClient,
} from './types';
import { AUDIO_OUT_RATE_HZ } from '../protocol';

/**
 * Minimal subset of the `ws` API this client touches. Tests inject a mock
 * to exercise the message-parsing logic without opening a real socket.
 */
export interface VertexWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: WebSocket.Data) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
}

export interface VertexLiveClientDeps {
  /**
   * Factory for the underlying socket. Defaults to opening a real `ws`
   * connection to the supplied URL with the given Authorization header.
   * Tests pass a factory returning a mock that mirrors the `VertexWebSocketLike`
   * surface.
   */
  createSocket?: (url: string, headers: Record<string, string>) => VertexWebSocketLike;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_INPUT_MIME = 'audio/pcm;rate=16000';
const DEFAULT_OUTPUT_MIME = `audio/pcm;rate=${AUDIO_OUT_RATE_HZ}`;

/**
 * Vertex AI Live API client.
 *
 * Construct → register event handlers → `connect()` → audio/text → `close()`.
 */
export class VertexLiveClient implements UpstreamLiveClient {
  private state: UpstreamConnectionState = 'idle';
  private ws: VertexWebSocketLike | null = null;
  private readonly createSocket: NonNullable<VertexLiveClientDeps['createSocket']>;

  private audioOutputHandler: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptHandler: ((e: TranscriptEvent) => void) | null = null;
  private toolCallHandler: ((e: ToolCallEvent) => void) | null = null;
  private turnCompleteHandler: ((e: TurnCompleteEvent) => void) | null = null;
  private interruptedHandler: ((e: InterruptedEvent) => void) | null = null;
  private errorHandler: ((e: UpstreamErrorEvent) => void) | null = null;
  private closeHandler: ((e: UpstreamCloseEvent) => void) | null = null;

  private closeEmitted = false;
  private connectTimeout: NodeJS.Timeout | null = null;
  private localCloseRequested = false;

  constructor(deps: VertexLiveClientDeps = {}) {
    this.createSocket =
      deps.createSocket ??
      ((url, headers) =>
        new WebSocket(url, { headers }) as unknown as VertexWebSocketLike);
  }

  getState(): UpstreamConnectionState {
    return this.state;
  }

  onAudioOutput(handler: (event: AudioOutputEvent) => void): void {
    this.audioOutputHandler = handler;
  }

  onTranscript(handler: (event: TranscriptEvent) => void): void {
    this.transcriptHandler = handler;
  }

  onToolCall(handler: (event: ToolCallEvent) => void): void {
    this.toolCallHandler = handler;
  }

  onTurnComplete(handler: (event: TurnCompleteEvent) => void): void {
    this.turnCompleteHandler = handler;
  }

  onInterrupted(handler: (event: InterruptedEvent) => void): void {
    this.interruptedHandler = handler;
  }

  onError(handler: (event: UpstreamErrorEvent) => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: (event: UpstreamCloseEvent) => void): void {
    this.closeHandler = handler;
  }

  async connect(options: UpstreamConnectOptions): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`invalid_state: cannot connect from state '${this.state}'`);
    }

    this.state = 'connecting';

    const accessToken = await options.getAccessToken();
    const url = buildBidiGenerateContentUrl(options.location);
    const ws = this.createSocket(url, {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    });
    this.ws = ws;

    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      this.connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.transitionToError({
          code: 'timeout',
          message: `Live API connection timeout after ${timeoutMs}ms`,
        });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('Live API connection timeout'));
      }, timeoutMs);

      ws.on('open', () => {
        try {
          ws.send(JSON.stringify(buildSetupMessage(options)));
        } catch (err) {
          if (settled) return;
          settled = true;
          this.clearConnectTimeout();
          this.transitionToError({
            code: 'setup_send_failed',
            message: (err as Error).message,
            cause: err,
          });
          reject(err);
        }
      });

      ws.on('message', (data: WebSocket.Data) => {
        let parsed: any;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          // Vertex always sends JSON. Non-JSON is a protocol error we
          // surface but do not retry on.
          this.emitError({ code: 'parse_error', message: 'Non-JSON message from upstream' });
          return;
        }

        if (parsed.setup_complete || parsed.setupComplete) {
          if (!settled) {
            settled = true;
            this.clearConnectTimeout();
            this.state = 'open';
            resolve();
          }
          return;
        }

        // After handshake: dispatch the message to typed handlers.
        if (this.state === 'open') {
          this.dispatchServerMessage(parsed);
        }
      });

      ws.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          this.clearConnectTimeout();
          this.transitionToError({
            code: 'transport_error',
            message: err.message,
            cause: err,
          });
          reject(err);
          return;
        }
        this.emitError({
          code: 'transport_error',
          message: err.message,
          cause: err,
        });
      });

      ws.on('close', (code: number, reason: Buffer) => {
        this.handleSocketClose(code, reason);
        if (!settled) {
          settled = true;
          this.clearConnectTimeout();
          reject(new Error(`Live API closed during handshake (code=${code})`));
        }
      });
    });
  }

  sendAudioChunk(audioB64: string, mimeType: string = DEFAULT_INPUT_MIME): boolean {
    if (this.state !== 'open' || !this.ws) return false;
    if (this.ws.readyState !== WebSocket.OPEN) return false;

    const message = {
      realtime_input: {
        media_chunks: [{ mime_type: mimeType, data: audioB64 }],
      },
    };

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  sendTextTurn(text: string, turnComplete: boolean = true): boolean {
    if (this.state !== 'open' || !this.ws) return false;
    if (this.ws.readyState !== WebSocket.OPEN) return false;

    const message = {
      client_content: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turn_complete: turnComplete,
      },
    };

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  sendEndOfTurn(): boolean {
    if (this.state !== 'open' || !this.ws) return false;
    if (this.ws.readyState !== WebSocket.OPEN) return false;

    const message = { client_content: { turn_complete: true } };

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.localCloseRequested = true;
    this.state = 'closing';
    this.clearConnectTimeout();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    // The underlying socket's 'close' event triggers final state + onClose.
    // For mocks that never emit, the caller's test expects the explicit
    // transition path — handle here as well.
    if (!this.closeEmitted) {
      this.finalizeClose({ initiatedLocally: true });
    }
  }

  /**
   * Dispatch a parsed server message to the typed event handlers.
   *
   * Vertex emits messages in snake_case AND occasionally camelCase
   * (depending on SDK path). We accept both spellings for every field.
   */
  private dispatchServerMessage(message: any): void {
    const serverContent = message.server_content || message.serverContent;
    if (serverContent) {
      const interrupted =
        serverContent.interrupted ||
        serverContent.grounding_metadata?.interrupted ||
        serverContent.groundingMetadata?.interrupted;
      if (interrupted) {
        this.interruptedHandler?.({});
      }

      // Audio chunks live under model_turn.parts[].inline_data
      const modelTurn = serverContent.model_turn || serverContent.modelTurn;
      const parts: any[] = modelTurn?.parts || [];
      for (const part of parts) {
        const inlineData = part.inline_data || part.inlineData;
        if (inlineData?.data) {
          this.audioOutputHandler?.({
            dataB64: inlineData.data,
            mimeType: inlineData.mime_type || inlineData.mimeType || DEFAULT_OUTPUT_MIME,
          });
        }
      }

      const inputTransObj = serverContent.input_transcription || serverContent.inputTranscription;
      const outputTransObj = serverContent.output_transcription || serverContent.outputTranscription;

      const inputText = typeof inputTransObj === 'string' ? inputTransObj : inputTransObj?.text;
      const outputText = typeof outputTransObj === 'string' ? outputTransObj : outputTransObj?.text;

      if (inputText) {
        this.transcriptHandler?.({ direction: 'input', text: inputText });
      }
      if (outputText) {
        this.transcriptHandler?.({ direction: 'output', text: outputText });
      }

      if (serverContent.turn_complete || serverContent.turnComplete) {
        this.turnCompleteHandler?.({});
      }
    }

    const toolCall = message.tool_call || message.toolCall;
    if (toolCall) {
      const fnCalls = toolCall.function_calls || toolCall.functionCalls || [];
      const calls = fnCalls.map((fc: any) => ({
        name: fc.name,
        args: fc.args || {},
        id: fc.id,
      }));
      if (calls.length > 0) {
        this.toolCallHandler?.({ calls });
      }
    }
  }

  private handleSocketClose(code: number, reason: Buffer): void {
    if (this.closeEmitted) return;
    this.finalizeClose({
      code,
      reason: reason?.toString?.() || undefined,
      initiatedLocally: this.localCloseRequested,
    });
  }

  private finalizeClose(event: UpstreamCloseEvent): void {
    this.closeEmitted = true;
    this.state = 'closed';
    this.clearConnectTimeout();
    try {
      this.closeHandler?.(event);
    } catch {
      /* swallow handler exceptions */
    }
  }

  private transitionToError(err: UpstreamErrorEvent): void {
    this.state = 'error';
    this.emitError(err);
  }

  private emitError(err: UpstreamErrorEvent): void {
    try {
      this.errorHandler?.(err);
    } catch {
      /* swallow handler exceptions */
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }
}

/**
 * Build the Vertex AI Live API WebSocket URL.
 *
 * Exposed for tests + direct construction by adapters.
 */
export function buildBidiGenerateContentUrl(location: string): string {
  return `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
}

/**
 * Build the Vertex `setup` message envelope from connection options.
 *
 * Exposed for tests so the snake_case wire format is verifiable without
 * opening a socket.
 */
export function buildSetupMessage(options: UpstreamConnectOptions): Record<string, unknown> {
  const modalities = options.responseModalities.includes('audio') ? ['AUDIO'] : ['TEXT'];

  const setup: Record<string, unknown> = {
    model: `projects/${options.projectId}/locations/${options.location}/publishers/google/models/${options.model}`,
    generation_config: {
      response_modalities: modalities,
      speech_config: {
        voice_config: {
          prebuilt_voice_config: {
            voice_name: options.voiceName,
          },
        },
      },
    },
    realtime_input_config: {
      automatic_activity_detection: {
        silence_duration_ms: options.vadSilenceMs,
      },
    },
    system_instruction: {
      parts: [{ text: options.systemInstruction }],
    },
  };

  if (options.enableInputTranscription !== false) {
    setup.input_audio_transcription = {};
  }
  if (options.enableOutputTranscription !== false) {
    setup.output_audio_transcription = {};
  }

  if (options.tools && options.tools.length > 0) {
    setup.tools = options.tools;
  }

  return { setup };
}
