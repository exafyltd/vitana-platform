/**
 * A7 (orb-live-refactor / VTID-02956): provider-neutral upstream Live client
 * boundary.
 *
 * Every realtime/voice provider (Vertex AI Live, LiveKit, future…) implements
 * `UpstreamLiveClient`. Session-level orchestration (orb-live.ts, A8 session
 * lifecycle, A9 transport handlers) talks ONLY to this interface — never to
 * provider WebSocket payloads.
 *
 * Hard rules:
 *   1. The interface is provider-neutral. Vendor JSON shapes (snake_case vs
 *      camelCase, `media_chunks` vs `audio_data`) never leak past the client.
 *   2. Events flow callback-style — no global emitter, no event bus. Each
 *      `on*` registers a single handler; replace by re-registering.
 *   3. State is observable but not directly mutable. Implementations transition
 *      through the states in order: `idle → connecting → open → closing → closed`,
 *      with `error` reachable from any state.
 *   4. `close()` and `getState()` are idempotent.
 *
 * Behavior contract (verified by characterization tests):
 *   - `connect()` resolves only after the provider's setup handshake completes
 *     (Vertex: receipt of `setup_complete`).
 *   - `sendAudioChunk()` returns false (not throws) when the client is not
 *     `open`. Callers handle backpressure.
 *   - `onError` fires once per distinct error; `onClose` fires exactly once.
 *   - After `close()`, no further events are emitted.
 */

/**
 * Lifecycle states for an upstream live connection.
 *
 * Transitions:
 *   idle      → connecting   (via `connect()`)
 *   connecting → open        (provider handshake completed)
 *   connecting → error       (handshake failed)
 *   open      → closing      (via `close()` or remote close frame)
 *   closing   → closed       (socket fully closed)
 *   *         → error        (any unrecoverable failure)
 *   error     → closed       (after cleanup)
 */
export type UpstreamConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed'
  | 'error';

/**
 * Options provided to `connect()`. Provider-neutral — implementations map
 * these onto their own setup envelopes (Vertex: `setup` message).
 */
export interface UpstreamConnectOptions {
  /** Provider-qualified model identifier (e.g. `gemini-live-2.5-flash-native-audio`). */
  model: string;
  /** GCP project (or equivalent tenant identifier for non-Vertex providers). */
  projectId: string;
  /** Provider region (Vertex: `us-central1`). */
  location: string;
  /** Voice ID to use for TTS output (provider-specific name). */
  voiceName: string;
  /** Response modalities. Vertex maps `'audio'` → `['AUDIO']`, `'text'` → `['TEXT']`. */
  responseModalities: ReadonlyArray<'audio' | 'text'>;
  /** Silence-duration VAD threshold in ms before treating user pause as turn-end. */
  vadSilenceMs: number;
  /** System instruction (already-composed prompt text). */
  systemInstruction: string;
  /** Tool function declarations (provider passes through as-is). */
  tools?: ReadonlyArray<Record<string, unknown>>;
  /** Enable input audio transcription stream. Vertex default: true. */
  enableInputTranscription?: boolean;
  /** Enable output audio transcription stream. Vertex default: true. */
  enableOutputTranscription?: boolean;
  /** Connection timeout for the initial handshake. Default 15 000 ms. */
  connectTimeoutMs?: number;
  /**
   * Async credential supplier. Vertex implementation calls this once per
   * `connect()` to obtain an OAuth access token. Other providers may use it
   * for API keys / JWTs.
   */
  getAccessToken: () => Promise<string>;
}

/**
 * Audio output chunk decoded from the provider stream.
 *
 * Vertex Live emits 24kHz mono PCM as base64 inline_data parts inside
 * `server_content.model_turn.parts[]`. Implementations normalize to this
 * single shape regardless of provider envelope.
 */
export interface AudioOutputEvent {
  /** Base64-encoded audio payload. */
  dataB64: string;
  /** MIME type (e.g. `audio/pcm;rate=24000`). */
  mimeType: string;
}

/**
 * Incremental transcript event (either direction).
 *
 * Vertex Live emits separate `input_transcription` and `output_transcription`
 * fields under `server_content`. Both arrive as text deltas — accumulate
 * on the caller side.
 */
export interface TranscriptEvent {
  /** `'input'` = user speech transcript, `'output'` = model speech transcript. */
  direction: 'input' | 'output';
  /** Text delta. May be a single word or a longer fragment. */
  text: string;
}

/**
 * Tool/function-call request from the model.
 *
 * Each entry corresponds to one `function_calls[]` item in Vertex's
 * `tool_call` payload. The client passes arguments through unchanged —
 * the session-level tool dispatcher interprets them.
 */
export interface ToolCallEvent {
  calls: ReadonlyArray<{
    /** Function name as declared in the tools schema. */
    name: string;
    /** Function arguments object (provider passes through as-is). */
    args: Record<string, unknown>;
    /** Provider-issued call ID for response correlation. */
    id?: string;
  }>;
}

/**
 * Signals the model finished a complete turn.
 *
 * Vertex emits this as `server_content.turn_complete: true`. After this
 * event, the session may send a new turn or close the connection.
 */
export interface TurnCompleteEvent {
  /** Provider-reported turn duration in ms, when available. */
  durationMs?: number;
}

/**
 * The model was interrupted mid-turn (user spoke, or VAD detected
 * conflicting input).
 *
 * Vertex emits this as `server_content.interrupted: true`. The client
 * must stop playback of any buffered audio.
 */
export interface InterruptedEvent {
  /** Provider-issued interrupt timestamp, when available. */
  atMs?: number;
}

/**
 * Connection / protocol error.
 */
export interface UpstreamErrorEvent {
  /** Error code (provider-specific or `network` / `timeout` / `setup`). */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Underlying error object, when known. */
  cause?: unknown;
}

/**
 * Final close event. Emitted exactly once per `UpstreamLiveClient` instance.
 */
export interface UpstreamCloseEvent {
  /** WebSocket close code, when available. */
  code?: number;
  /** Close reason text, when available. */
  reason?: string;
  /** True if the close was initiated by the local side (via `close()`). */
  initiatedLocally: boolean;
}

/**
 * Provider-neutral live upstream client.
 *
 * Implementations:
 *   - `VertexLiveClient` (Vertex AI Live API via BidiGenerateContent WS)
 *   - future: LiveKit, OpenAI Realtime, …
 *
 * Construction is provider-specific. Once constructed, callers MUST register
 * the events they care about BEFORE calling `connect()` — events fired
 * during the handshake (rare but possible) are dropped if no handler is set.
 */
export interface UpstreamLiveClient {
  /**
   * Open the upstream connection and complete the provider handshake.
   *
   * Resolves when the provider signals the session is ready to accept
   * audio/text input. Rejects on timeout, auth failure, or transport error.
   *
   * Calling `connect()` on a client that is not `idle` rejects with
   * `code: 'invalid_state'`.
   */
  connect(options: UpstreamConnectOptions): Promise<void>;

  /**
   * Forward a base64-encoded audio chunk from the user.
   *
   * Returns `true` if the chunk was sent, `false` if the socket is not in
   * the `open` state. Does NOT throw on a closed socket — callers detect
   * via the return value.
   */
  sendAudioChunk(audioB64: string, mimeType?: string): boolean;

  /**
   * Send a user text turn (alternative to streaming audio for text-only
   * input). Marks the turn complete by default.
   *
   * Returns `true` if sent, `false` if not `open`.
   */
  sendTextTurn(text: string, turnComplete?: boolean): boolean;

  /**
   * Signal end-of-turn after streaming audio. Tells the provider to stop
   * waiting for more user input and start generating a response.
   *
   * Returns `true` if sent, `false` if not `open`.
   */
  sendEndOfTurn(): boolean;

  /** Register a handler for audio chunks streamed back from the model. */
  onAudioOutput(handler: (event: AudioOutputEvent) => void): void;

  /** Register a handler for transcript deltas (input or output). */
  onTranscript(handler: (event: TranscriptEvent) => void): void;

  /** Register a handler for tool/function-call requests from the model. */
  onToolCall(handler: (event: ToolCallEvent) => void): void;

  /** Register a handler for turn-complete events. */
  onTurnComplete(handler: (event: TurnCompleteEvent) => void): void;

  /** Register a handler for model-interrupted events. */
  onInterrupted(handler: (event: InterruptedEvent) => void): void;

  /** Register a handler for transport / protocol errors. */
  onError(handler: (event: UpstreamErrorEvent) => void): void;

  /** Register a handler for the (single) connection-close event. */
  onClose(handler: (event: UpstreamCloseEvent) => void): void;

  /**
   * Close the upstream connection. Idempotent — calling on a closed client
   * is a no-op. Emits a final `onClose` event with `initiatedLocally: true`.
   */
  close(): Promise<void>;

  /** Current lifecycle state. Always reflects the last transition. */
  getState(): UpstreamConnectionState;
}
