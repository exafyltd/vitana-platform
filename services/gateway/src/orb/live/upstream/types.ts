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
  /**
   * @deprecated BOOTSTRAP-NOVA-SONIC-VOICE: provider credentials/identity
   * belong in provider constructor deps (`VertexLiveClientDeps.projectId`),
   * not the provider-neutral connect options. Optional during migration;
   * constructor deps take precedence when both are supplied.
   */
  projectId?: string;
  /**
   * @deprecated BOOTSTRAP-NOVA-SONIC-VOICE: see `projectId` — move to
   * provider constructor deps (`VertexLiveClientDeps.location`).
   */
  location?: string;
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
   * @deprecated BOOTSTRAP-NOVA-SONIC-VOICE: credential suppliers belong in
   * provider constructor deps (`VertexLiveClientDeps.getAccessToken` /
   * `GeminiApiKeyLiveClientDeps.getApiKey`), not the provider-neutral
   * connect options — Nova (SDK default credential chain) has no token
   * callback at all. Optional during migration; constructor deps take
   * precedence when both are supplied.
   */
  getAccessToken?: () => Promise<string>;

  /**
   * A8.3b.1 (VTID-02971) — optional custom setup-message builder. When set,
   * the implementation calls this inside `ws.on('open')` (awaiting the
   * returned promise) and sends the produced envelope INSTEAD OF the
   * default `buildSetupMessage(options)` envelope.
   *
   * Used by orb-live.ts's `connectToLiveAPI` adapter to produce the legacy
   * orb-specific setup envelope (persona swap, tools, transcription
   * config, system instruction overrides) without VertexLiveClient
   * needing to know any of that surface area.
   *
   * The builder can be sync or async. The handshake-completion gate is
   * still the upstream `setup_complete` reply, regardless of envelope
   * shape.
   */
  customSetupMessage?: () =>
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;

  /**
   * VTID-03273 Pillar B — enable native Gemini session resumption. When true,
   * the setup envelope carries `session_resumption` (empty to start a fresh
   * resumable session, or `{ handle }` to resume). The default builder reads
   * `sessionResumptionHandle` to decide which.
   */
  enableSessionResumption?: boolean;

  /**
   * VTID-03273 Pillar B — opaque resumption handle from a prior connection.
   * When present (and `enableSessionResumption`), the new connection resumes
   * the SAME server-side conversation instead of starting fresh.
   */
  sessionResumptionHandle?: string | null;

  /**
   * VTID-03273 Pillar B — enable sliding-window context compression so a long
   * conversation does not hit the context cap before the GoAway/resume cycle
   * can rotate the connection.
   */
  enableContextWindowCompression?: boolean;
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
  /**
   * BOOTSTRAP-NOVA-SONIC-VOICE: whether this event carries committed/final
   * text for its content block. Gemini/Vertex stream deltas — always
   * `false` there (callers accumulate). Nova emits final user ASR
   * (`isFinal: true`) and speculative-then-final assistant text.
   */
  isFinal: boolean;
  /**
   * Nova-only generation stage for assistant transcript. `'SPECULATIVE'`
   * text may be revised; `'FINAL'` is the committed transcript to persist.
   * Absent for providers without staged generation (Vertex/Gemini).
   */
  generationStage?: 'SPECULATIVE' | 'FINAL';
}

/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: provider-neutral tool-execution result the
 * session layer hands back to the model after dispatching a `ToolCallEvent`.
 *
 * Every provider REQUIRES a result for every tool call it issued — Nova
 * waits indefinitely on a `toolUse` that never receives a `toolResult`, so
 * failed tools must still produce a result (`success: false` + `error`).
 */
export interface UpstreamToolResult {
  /** Provider-issued call ID (`ToolCallEvent.calls[].id`) for correlation. */
  callId?: string;
  /** Function name as declared in the tools schema. */
  name: string;
  /** Whether tool execution succeeded. */
  success: boolean;
  /** Serialized tool output (typically JSON text) for the model. */
  output: string;
  /** Failure detail when `success` is false. */
  error?: string;
}

/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: normalized usage/billing totals emitted by
 * providers that report them (Nova `usageEvent`). All fields optional —
 * providers fill what they know.
 */
export interface UpstreamUsageEvent {
  inputSpeechTokens?: number;
  inputTextTokens?: number;
  outputSpeechTokens?: number;
  outputTextTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
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
 * Native session-resumption handle update (VTID-03273 Pillar B).
 *
 * Gemini Live periodically emits `sessionResumptionUpdate` with a fresh
 * opaque `newHandle`. When `resumable` is true, the handle can be passed in a
 * later `setup.session_resumption.handle` to resume the SAME server-side
 * conversation across a dropped/rebuilt connection — natively, with no
 * transcript re-injection and no re-greeting. The session layer stores the
 * latest handle on the durable Conversation, not the connection.
 */
export interface SessionResumptionEvent {
  /** Opaque resumption handle to store and replay on reconnect. */
  handle: string | null;
  /** Whether the server considers the current point resumable. */
  resumable: boolean;
}

/**
 * Server "GoAway" notice (VTID-03273 Pillar B).
 *
 * Gemini Live caps a single connection (~10 min) and warns before it drops
 * via `goAway` carrying `timeLeft`. The session layer reconnects PROACTIVELY
 * with the resumption handle before the deadline so the user perceives no
 * break and the thread is preserved.
 */
export interface GoAwayEvent {
  /** Milliseconds left before the server closes this connection, when known. */
  timeLeftMs?: number;
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

  /**
   * BOOTSTRAP-NOVA-SONIC-VOICE: return a tool-execution result to the model
   * for a previously received `ToolCallEvent`. MUST be called exactly once
   * per tool call, success or failure — Nova stalls forever on an
   * unanswered `toolUse`.
   *
   * Returns `true` if sent, `false` if not `open`.
   */
  sendToolResult(result: UpstreamToolResult): boolean;

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

  /**
   * Register a handler for native session-resumption handle updates
   * (VTID-03273 Pillar B). Optional on implementations that do not support
   * resumption — the session layer treats absence as "no native resumption".
   */
  onSessionResumption?(handler: (event: SessionResumptionEvent) => void): void;

  /**
   * Register a handler for the server's GoAway notice (VTID-03273 Pillar B),
   * used to reconnect proactively before the connection cap.
   */
  onGoAway?(handler: (event: GoAwayEvent) => void): void;

  /**
   * BOOTSTRAP-NOVA-SONIC-VOICE: register a handler for usage/billing
   * totals. Optional — providers without usage reporting (Vertex/Gemini
   * Live today) accept the registration and simply never fire it.
   */
  onUsage?(handler: (event: UpstreamUsageEvent) => void): void;

  /** Register a handler for transport / protocol errors. */
  onError(handler: (event: UpstreamErrorEvent) => void): void;

  /** Register a handler for the (single) connection-close event. */
  onClose(handler: (event: UpstreamCloseEvent) => void): void;

  /**
   * Close the upstream connection. Idempotent — calling on a closed client
   * is a no-op. Emits a final `onClose` event with `initiatedLocally: true`.
   *
   * BOOTSTRAP-NOVA-SONIC-VOICE: `reason` is a short machine-readable label
   * (`'persona_swap'`, `'provider_stream_rotation'`, …) forwarded to the
   * provider where the transport supports one (WS close reason) and echoed
   * on the final `UpstreamCloseEvent.reason`.
   */
  close(reason?: string): Promise<void>;

  /** Current lifecycle state. Always reflects the last transition. */
  getState(): UpstreamConnectionState;
}
