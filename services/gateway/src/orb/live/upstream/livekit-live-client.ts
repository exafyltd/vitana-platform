/**
 * Session B (orb-live-refactor): LiveKit skeleton implementation of
 * `UpstreamLiveClient`.
 *
 * STATUS: skeleton only. `connect()` deliberately rejects with
 * `code: 'not_implemented'`. No production call site uses this client yet —
 * the selection layer (`provider-selection.ts`) defaults to Vertex and only
 * picks LiveKit when both `ORB_LIVE_PROVIDER=livekit` AND the LiveKit
 * credential triple is present.
 *
 * Why a skeleton (not a stub returning success):
 *   - The `UpstreamLiveClient` contract was designed against the Vertex Live
 *     API wire shape (single bidi WebSocket, server-driven VAD, model returns
 *     audio inline as base64 PCM). LiveKit's model is different (room +
 *     subscribed tracks, agent dispatched as a participant, audio published
 *     as media tracks). The mapping is non-trivial and is documented in
 *     `docs/plans/livekit-migration.md`.
 *   - Shipping the skeleton lets us land the provider-selection seam,
 *     interface-conformance tests, and the migration doc WITHOUT a partial
 *     implementation that could be accidentally enabled in production.
 *
 * What this file DOES:
 *   - Implements every method on the `UpstreamLiveClient` interface.
 *   - Honors the lifecycle state machine (idle → error after a refused
 *     connect, idle → closing → closed after close()).
 *   - Stores event handlers as the interface requires.
 *   - close() is idempotent; onClose fires exactly once with
 *     `initiatedLocally: true`.
 *   - Send methods return `false` (per contract) when not in `open` state.
 *
 * What this file DOES NOT do (yet):
 *   - Mint a participant token (LIVEKIT_API_KEY / LIVEKIT_API_SECRET → JWT).
 *   - Connect to a room via the LiveKit server SDK.
 *   - Publish/subscribe audio tracks.
 *   - Dispatch the LiveKit agent (turn handling, VAD, tool dispatch).
 *   - Bridge LiveKit data-channel events to onTranscript / onToolCall /
 *     onTurnComplete / onInterrupted.
 *
 * Interface gaps (documented in `docs/plans/livekit-migration.md`):
 *   - `UpstreamConnectOptions.projectId`/`location` mean nothing for LiveKit;
 *     LiveKit needs a room name + participant identity instead.
 *   - `getAccessToken()` returns a Google OAuth token; LiveKit needs a
 *     short-lived participant JWT signed with `LIVEKIT_API_SECRET`.
 *   - `sendAudioChunk(audioB64)` assumes a single push channel; LiveKit
 *     wants a published audio track that the agent subscribes to.
 *   - There is no `ToolCallResult` send path on the interface — Vertex
 *     accepts tool results inline in the next `client_content`; LiveKit
 *     uses data channel messages.
 */

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

/**
 * Configuration the LiveKit implementation needs that the
 * provider-neutral interface does NOT model. Caller-supplied so this
 * file does not reach into `process.env` directly.
 *
 * The skeleton does not consume these yet, but the shape is fixed so the
 * provider-selection layer and future implementation can both rely on it.
 */
export interface LiveKitClientConfig {
  /** wss://… room URL (e.g. LiveKit Cloud or self-hosted SFU). */
  url: string;
  /** API key used to mint participant tokens. */
  apiKey: string;
  /** API secret used to sign participant tokens. Server-only. */
  apiSecret: string;
  /** Room name to join. Defaults to per-session generation when absent. */
  roomName?: string;
  /** Participant identity for the gateway side of the session. */
  participantIdentity?: string;
}

/**
 * Hooks for tests to inject behavior without depending on a real LiveKit
 * server. Mirrors `VertexLiveClientDeps` shape so the skeleton can be
 * fleshed out without changing the construction surface.
 */
export interface LiveKitLiveClientDeps {
  /** Tests can substitute the config-validation pre-check. */
  validateConfig?: (config: LiveKitClientConfig) => UpstreamErrorEvent | null;
}

/**
 * LiveKit upstream client — skeleton.
 *
 * @see docs/plans/livekit-migration.md for the gap list and intended
 *      mapping of LiveKit room/track lifecycle onto the
 *      `UpstreamLiveClient` interface.
 */
export class LiveKitLiveClient implements UpstreamLiveClient {
  private state: UpstreamConnectionState = 'idle';
  private readonly config: LiveKitClientConfig;
  private readonly validateConfig: NonNullable<
    LiveKitLiveClientDeps['validateConfig']
  >;

  private audioOutputHandler: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptHandler: ((e: TranscriptEvent) => void) | null = null;
  private toolCallHandler: ((e: ToolCallEvent) => void) | null = null;
  private turnCompleteHandler: ((e: TurnCompleteEvent) => void) | null = null;
  private interruptedHandler: ((e: InterruptedEvent) => void) | null = null;
  private errorHandler: ((e: UpstreamErrorEvent) => void) | null = null;
  private closeHandler: ((e: UpstreamCloseEvent) => void) | null = null;

  private closeEmitted = false;

  constructor(config: LiveKitClientConfig, deps: LiveKitLiveClientDeps = {}) {
    this.config = config;
    this.validateConfig = deps.validateConfig ?? defaultValidateConfig;
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

  /**
   * Skeleton: validates config, then refuses to connect with a typed
   * `not_implemented` error. Does not open a socket, mint a token, or
   * touch the LiveKit server.
   *
   * Production callers MUST NOT reach this path — provider-selection
   * defaults to Vertex and the selection layer treats LiveKit as
   * opt-in only.
   */
  async connect(_options: UpstreamConnectOptions): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`invalid_state: cannot connect from state '${this.state}'`);
    }

    this.state = 'connecting';

    const configError = this.validateConfig(this.config);
    if (configError) {
      this.transitionToError(configError);
      throw new Error(`${configError.code}: ${configError.message}`);
    }

    const err: UpstreamErrorEvent = {
      code: 'not_implemented',
      message:
        'LiveKitLiveClient is a skeleton. See docs/plans/livekit-migration.md ' +
        'for the room/track/agent wiring still required.',
    };
    this.transitionToError(err);
    throw new Error(`${err.code}: ${err.message}`);
  }

  // The skeleton never reaches `open`, so the contract requires these to
  // return `false` rather than throw. Once the implementation lands, these
  // bodies will publish to a LiveKit audio track / data channel.
  sendAudioChunk(_audioB64: string, _mimeType?: string): boolean {
    return this.state === 'open';
  }

  sendTextTurn(_text: string, _turnComplete: boolean = true): boolean {
    return this.state === 'open';
  }

  sendEndOfTurn(): boolean {
    return this.state === 'open';
  }

  async close(): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    if (!this.closeEmitted) {
      this.finalizeClose({ initiatedLocally: true });
    }
  }

  private finalizeClose(event: UpstreamCloseEvent): void {
    this.closeEmitted = true;
    this.state = 'closed';
    try {
      this.closeHandler?.(event);
    } catch {
      /* swallow handler exceptions */
    }
  }

  private transitionToError(err: UpstreamErrorEvent): void {
    this.state = 'error';
    try {
      this.errorHandler?.(err);
    } catch {
      /* swallow handler exceptions */
    }
  }

  // Reserved for the post-skeleton implementation. Listed here so the
  // unused-handler stores above are obvious to future readers.
  private get _futureBridges() {
    return {
      audioOutputHandler: this.audioOutputHandler,
      transcriptHandler: this.transcriptHandler,
      toolCallHandler: this.toolCallHandler,
      turnCompleteHandler: this.turnCompleteHandler,
      interruptedHandler: this.interruptedHandler,
    };
  }
}

/**
 * Default config validator. Returns a typed error event when required
 * fields are missing/blank; null when the config looks usable.
 *
 * Intentionally cheap — does NOT verify the URL is reachable or that the
 * key/secret pair is valid. That happens once the real implementation
 * mints a token.
 */
export function defaultValidateConfig(
  config: LiveKitClientConfig,
): UpstreamErrorEvent | null {
  const missing: string[] = [];
  if (!config.url || !config.url.trim()) missing.push('url');
  if (!config.apiKey || !config.apiKey.trim()) missing.push('apiKey');
  if (!config.apiSecret || !config.apiSecret.trim()) missing.push('apiSecret');

  if (missing.length > 0) {
    return {
      code: 'invalid_config',
      message: `LiveKit config missing required field(s): ${missing.join(', ')}`,
    };
  }

  if (!/^wss?:\/\//i.test(config.url)) {
    return {
      code: 'invalid_config',
      message: `LiveKit url must start with ws:// or wss:// (got "${config.url}")`,
    };
  }

  return null;
}
