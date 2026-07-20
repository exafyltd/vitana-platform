/**
 * BOOTSTRAP-AWS-STAGING-VALIDATION: Google AI Studio (Gemini API key) Live
 * API implementation of `UpstreamLiveClient`.
 *
 * Sibling to `VertexLiveClient` (vertex-live-client.ts), not a subclass of
 * it — kept fully self-contained so the existing, production-proven Vertex
 * path is untouched by this addition.
 *
 * Why this exists: `VertexLiveClient` authenticates via OAuth Application
 * Default Credentials, which resolve for free on Cloud Run (GCP metadata
 * server) but have nothing to resolve from on non-GCP compute (AWS ECS —
 * see gcp-adc-bootstrap.ts). The Gemini Live API is also reachable through
 * Google AI Studio's public endpoint using a plain API key — no ADC, no GCP
 * service-account credential, no metadata server required. This client
 * targets that endpoint so AWS can run ORB voice without a GCP credential
 * at all.
 *
 * Wire-protocol parity with VertexLiveClient: same `setup` /
 * `realtime_input` / `client_content` snake_case envelope shapes and the
 * same `server_content` / `tool_call` response dispatch — Vertex AI Live
 * and the AI Studio Live API share the same underlying BidiGenerateContent
 * proto definitions. The two concrete differences are:
 *   1. Auth: API key (`?key=`) instead of an OAuth `Authorization: Bearer`.
 *   2. Model id format: bare `models/{model}` instead of Vertex's
 *      `projects/{p}/locations/{l}/publishers/google/models/{model}` — the
 *      setup envelope built by callers (orb-live.ts's `customSetupMessage`)
 *      is Vertex-shaped, so this client rewrites just the `model` field
 *      after building it, rather than forking the (large) envelope-builder.
 *
 * UNVERIFIED IN PRODUCTION: this path has not yet been exercised against a
 * live ORB session. Confirm in AWS CloudWatch logs (`/vitana/gateway`) that
 * a real session reaches `setup_complete` (this client's `connect()`
 * resolving) rather than an auth/handshake error before treating AWS ORB
 * voice as fixed.
 */

import WebSocket from 'ws';
import type {
  AudioOutputEvent,
  GoAwayEvent,
  InterruptedEvent,
  SessionResumptionEvent,
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
import { buildSetupMessage, parseDurationMs } from './vertex-live-client';
import type { VertexWebSocketLike } from './vertex-live-client';

export interface GeminiApiKeyLiveClientDeps {
  /** Factory for the underlying socket. Defaults to a real `ws` connection. */
  createSocket?: (url: string, headers: Record<string, string>) => VertexWebSocketLike;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_INPUT_MIME = 'audio/pcm;rate=16000';
const DEFAULT_OUTPUT_MIME = `audio/pcm;rate=${AUDIO_OUT_RATE_HZ}`;
const AI_STUDIO_LIVE_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

/** Build the AI Studio Live API WebSocket URL. Exposed for tests. */
export function buildAiStudioBidiGenerateContentUrl(apiKey: string): string {
  return `${AI_STUDIO_LIVE_WS_BASE}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Rewrite a Vertex-shaped `setup.model` (`projects/.../models/{name}`) to
 * the bare AI Studio form (`models/{name}`). Already-bare values pass
 * through unchanged.
 */
export function toAiStudioModelId(vertexModelId: string): string {
  const name = vertexModelId.split('/').pop() || vertexModelId;
  return `models/${name}`;
}

/**
 * AI Studio (API-key auth) Live API client. See file header for why this
 * exists and what it shares with `VertexLiveClient`.
 */
export class GeminiApiKeyLiveClient implements UpstreamLiveClient {
  private state: UpstreamConnectionState = 'idle';
  private ws: VertexWebSocketLike | null = null;
  private readonly createSocket: NonNullable<GeminiApiKeyLiveClientDeps['createSocket']>;

  private audioOutputHandler: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptHandler: ((e: TranscriptEvent) => void) | null = null;
  private toolCallHandler: ((e: ToolCallEvent) => void) | null = null;
  private turnCompleteHandler: ((e: TurnCompleteEvent) => void) | null = null;
  private interruptedHandler: ((e: InterruptedEvent) => void) | null = null;
  private sessionResumptionHandler: ((e: SessionResumptionEvent) => void) | null = null;
  private goAwayHandler: ((e: GoAwayEvent) => void) | null = null;
  private errorHandler: ((e: UpstreamErrorEvent) => void) | null = null;
  private closeHandler: ((e: UpstreamCloseEvent) => void) | null = null;

  private closeEmitted = false;
  private connectTimeout: NodeJS.Timeout | null = null;
  private localCloseRequested = false;

  constructor(deps: GeminiApiKeyLiveClientDeps = {}) {
    this.createSocket =
      deps.createSocket ??
      ((url, headers) =>
        new WebSocket(url, { headers }) as unknown as VertexWebSocketLike);
  }

  getState(): UpstreamConnectionState {
    return this.state;
  }

  getSocket(): WebSocket | null {
    return this.ws as unknown as WebSocket | null;
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

  onSessionResumption(handler: (event: SessionResumptionEvent) => void): void {
    this.sessionResumptionHandler = handler;
  }

  onGoAway(handler: (event: GoAwayEvent) => void): void {
    this.goAwayHandler = handler;
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

    // Reuses the provider-neutral credential hook per its own contract
    // ("Other providers may use it for API keys / JWTs" — types.ts) — the
    // caller passes a function returning the raw Gemini API key here
    // instead of an OAuth token fetcher.
    const apiKey = await options.getAccessToken();
    const url = buildAiStudioBidiGenerateContentUrl(apiKey);
    const ws = this.createSocket(url, { 'Content-Type': 'application/json' });
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

      ws.on('open', async () => {
        try {
          const envelope = options.customSetupMessage
            ? await Promise.resolve(options.customSetupMessage())
            : buildSetupMessage(options);
          const setup = (envelope as { setup?: Record<string, unknown> }).setup;
          if (setup && typeof setup.model === 'string') {
            setup.model = toAiStudioModelId(setup.model);
          }
          ws.send(JSON.stringify(envelope));
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
    if (!this.closeEmitted) {
      this.finalizeClose({ initiatedLocally: true });
    }
  }

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

    const resumption =
      message.session_resumption_update || message.sessionResumptionUpdate;
    if (resumption) {
      this.sessionResumptionHandler?.({
        handle: resumption.new_handle || resumption.newHandle || null,
        resumable: resumption.resumable === true,
      });
    }

    const goAway = message.go_away || message.goAway;
    if (goAway) {
      this.goAwayHandler?.({ timeLeftMs: parseDurationMs(goAway.time_left ?? goAway.timeLeft) });
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
