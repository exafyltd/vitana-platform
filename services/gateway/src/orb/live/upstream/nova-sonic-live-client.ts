/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 4): Nova 2 Sonic implementation of
 * `UpstreamLiveClient` over Bedrock's bidirectional HTTP/2 stream
 * (`InvokeModelWithBidirectionalStream`, eu-north-1).
 *
 * Responsibilities (thin lifecycle wrapper — all envelope shapes live in
 * nova-sonic-protocol.ts):
 *   - bounded async input queue feeding the request stream (audio subject
 *     to backpressure; init events and tool results never dropped);
 *   - session/prompt/content lifecycle: sessionStart → promptStart →
 *     system text block → long-lived USER audio block;
 *   - response-stream decoding via NovaOutputNormalizer → typed events;
 *   - typed failure taxonomy (nova_access_denied, nova_throttled, …) with
 *     NO raw AWS exception text leaking to callers' user-facing surfaces;
 *   - rotation callback shortly before Bedrock's 8-minute stream cap;
 *   - close(): audio contentEnd → promptEnd → sessionEnd → queue close.
 *
 * Credentials: AWS SDK default chain only (ECS task role). This file never
 * reads key material and never logs payload content, transcripts, or
 * credential/SigV4 data.
 */

import { randomUUID } from 'crypto';
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
  UpstreamToolResult,
  UpstreamUsageEvent,
} from './types';
import type { NovaSonicConfig } from './nova-sonic-config';
import {
  buildAudioContentStart,
  buildAudioInput,
  buildContentEnd,
  buildPromptEnd,
  buildPromptStart,
  buildSessionEnd,
  buildSessionStart,
  buildTextContentStart,
  buildTextInput,
  buildToolResultEvents,
  convertToolsToNovaSpecs,
  NovaOutputNormalizer,
  type NovaInputEvent,
} from './nova-sonic-protocol';

/** Typed Nova failure categories (browser only ever sees the category). */
export type NovaFailureCode =
  | 'nova_access_denied'
  | 'nova_model_not_found'
  | 'nova_throttled'
  | 'nova_validation'
  | 'nova_stream_timeout'
  | 'nova_stream_error'
  | 'nova_protocol_error'
  | 'nova_backpressure'
  | 'nova_rotation_failed'
  | 'nova_not_configured';

/** Map an AWS SDK error to a typed category without leaking its message. */
export function classifyNovaError(err: unknown): NovaFailureCode {
  const name = (err as { name?: string })?.name ?? '';
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (name === 'AccessDeniedException' || status === 403) return 'nova_access_denied';
  if (name === 'ResourceNotFoundException' || status === 404) return 'nova_model_not_found';
  if (name === 'ThrottlingException' || name === 'ServiceQuotaExceededException' || status === 429) {
    return 'nova_throttled';
  }
  if (name === 'ValidationException' || status === 400) return 'nova_validation';
  if (name === 'TimeoutError' || name === 'RequestTimeout' || /timeout/i.test(name)) {
    return 'nova_stream_timeout';
  }
  if (name === 'ModelStreamErrorException' || name === 'ModelErrorException') {
    return 'nova_stream_error';
  }
  return 'nova_stream_error';
}

/**
 * Bounded async input queue implementing the AsyncIterable the Bedrock
 * command consumes. Order-preserving. `push` (control/tool events) always
 * enqueues; `pushAudio` refuses beyond the high-water mark so a stalled
 * stream degrades with backpressure instead of unbounded memory.
 */
export class NovaInputQueue implements AsyncIterable<{ chunk: { bytes: Uint8Array } }> {
  private buffer: Array<{ chunk: { bytes: Uint8Array } }> = [];
  private waiting: Array<(item: IteratorResult<{ chunk: { bytes: Uint8Array } }>) => void> = [];
  private closed = false;
  private audioBuffered = 0;

  constructor(private readonly audioHighWaterMark: number = 64) {}

  push(event: NovaInputEvent): boolean {
    if (this.closed) return false;
    this.enqueue(event, false);
    return true;
  }

  pushAudio(event: NovaInputEvent): boolean {
    if (this.closed) return false;
    if (this.audioBuffered >= this.audioHighWaterMark) return false;
    this.enqueue(event, true);
    return true;
  }

  private enqueue(event: NovaInputEvent, isAudio: boolean): void {
    const item = {
      chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) },
      _isAudio: isAudio,
    } as { chunk: { bytes: Uint8Array } } & { _isAudio?: boolean };
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    if (isAudio) this.audioBuffered++;
    this.buffer.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<{ chunk: { bytes: Uint8Array } }> {
    return {
      next: (): Promise<IteratorResult<{ chunk: { bytes: Uint8Array } }>> => {
        const item = this.buffer.shift() as
          | ({ chunk: { bytes: Uint8Array } } & { _isAudio?: boolean })
          | undefined;
        if (item) {
          if (item._isAudio) this.audioBuffered--;
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

/**
 * Minimal Bedrock surface the client depends on — tests inject a fake; the
 * default factory builds a real BedrockRuntimeClient over HTTP/2.
 */
export interface NovaBedrockLike {
  send(command: unknown): Promise<{
    body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>;
  }>;
  destroy?(): void;
}

export interface NovaSonicLiveClientDeps {
  config: NovaSonicConfig;
  /** Nova voice ID resolved for this session's language/persona. */
  voiceId: string;
  /** Bedrock client factory (tests inject a fake). */
  createBedrockClient?: () => NovaBedrockLike;
  /** Command constructor (tests capture the input). */
  createCommand?: (input: { modelId: string; body: AsyncIterable<unknown> }) => unknown;
  /** Rotation callback — fired ONCE at config.rotationAfterMs. */
  onRotationDue?: () => void;
  /** Audio queue high-water mark override. */
  audioHighWaterMark?: number;
}

async function buildBedrockClient(config: NovaSonicConfig): Promise<NovaBedrockLike> {
  // Lazy imports keep Bedrock/HTTP2 out of the require graph for GCP
  // deployments that never enable Nova.
  const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
  const { NodeHttp2Handler } = await import('@smithy/node-http-handler');
  return new BedrockRuntimeClient({
    region: config.region,
    requestHandler: new NodeHttp2Handler({
      requestTimeout: config.connectTimeoutMs,
      sessionTimeout: 480_000,
    }),
  }) as unknown as NovaBedrockLike;
}

/**
 * Shared Bedrock client, reused across sessions. NodeHttp2Handler pools
 * HTTP/2 sessions per authority, so reuse lets a new ORB session skip SDK
 * import + credential-chain resolution + TCP/TLS/HTTP2 setup — the same
 * latency treatment the Vertex path gets from its boot-time ADC token
 * prewarm (see orb-live.ts, ORB-CONVERSATION-LATENCY).
 */
let sharedBedrockClient: NovaBedrockLike | null = null;

async function defaultBedrockFactory(config: NovaSonicConfig): Promise<NovaBedrockLike> {
  if (!sharedBedrockClient) {
    sharedBedrockClient = await buildBedrockClient(config);
  }
  return sharedBedrockClient;
}

/**
 * Marker model id for the zero-cost connection warm-up. Bedrock rejects it
 * with a fast 4xx BEFORE any inference (no charge, no stream), but the
 * signed request rides — and therefore establishes — the pooled DNS + TCP +
 * TLS + HTTP/2 path a real session will reuse.
 */
const NOVA_WARMUP_MARKER_MODEL_ID = 'vitana.connection-warmup';

/**
 * Fire one zero-cost signed request through the shared client to establish
 * (or refresh) the pooled HTTP/2 session and keep resolved credentials hot.
 * The expected outcome is a typed 4xx — that still means the connection is
 * warm. Returns latency ms on success-shaped outcomes, null on transport
 * failure. Never logs or returns raw AWS error text.
 */
export async function warmNovaSonicConnection(config: NovaSonicConfig): Promise<number | null> {
  try {
    const client = await defaultBedrockFactory(config);
    const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const t0 = Date.now();
    try {
      await Promise.race([
        client.send(new InvokeModelCommand({
          modelId: NOVA_WARMUP_MARKER_MODEL_ID,
          contentType: 'application/json',
          body: new Uint8Array(0),
        })),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(Object.assign(new Error('warmup timeout'), { name: 'TimeoutError' })), 10_000);
          (t as NodeJS.Timeout).unref?.();
        }),
      ]);
      return Date.now() - t0;
    } catch (err) {
      const code = classifyNovaError(err);
      // 4xx categories mean the request reached Bedrock — connection is warm.
      if (code === 'nova_validation' || code === 'nova_model_not_found' || code === 'nova_access_denied') {
        return Date.now() - t0;
      }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Boot-time prewarm: build the shared client, resolve the credential chain
 * (ECS task-role fetch), and establish the TLS/HTTP/2 path — all off the
 * session critical path. Best-effort — a failure falls back to lazy
 * construction on first connect.
 */
export async function prewarmNovaSonicBedrock(config: NovaSonicConfig): Promise<boolean> {
  try {
    const client = await defaultBedrockFactory(config);
    const credentialsProvider = (client as {
      config?: { credentials?: () => Promise<unknown> };
    }).config?.credentials;
    if (typeof credentialsProvider === 'function') {
      // Cap the warm-up so a hung metadata endpoint can't stall boot.
      await Promise.race([
        credentialsProvider(),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('prewarm timeout')), 5_000);
          (t as NodeJS.Timeout).unref?.();
        }),
      ]);
    }
    // Establish the actual network path, not just the credentials.
    await warmNovaSonicConnection(config);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: inject/clear the shared client without touching real AWS SDKs. */
export function __setSharedBedrockClientForTests(client: NovaBedrockLike | null): void {
  sharedBedrockClient = client;
}

export class NovaSonicLiveClient implements UpstreamLiveClient {
  private state: UpstreamConnectionState = 'idle';
  private readonly deps: NovaSonicLiveClientDeps;
  private readonly promptName = randomUUID();
  private readonly audioContentName = randomUUID();
  private queue: NovaInputQueue;
  private bedrock: NovaBedrockLike | null = null;
  /** True when this instance built its own client (injected factory) and
   *  may destroy it on close; the shared default client is never destroyed. */
  private ownsBedrock = false;
  private normalizer = new NovaOutputNormalizer();
  private rotationTimer: NodeJS.Timeout | null = null;
  private rotationFired = false;
  private closeEmitted = false;
  private errorEmitted = false;
  private localCloseReason: string | undefined;
  private responseLoopDone: Promise<void> | null = null;

  private audioOutputHandler: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptHandler: ((e: TranscriptEvent) => void) | null = null;
  private toolCallHandler: ((e: ToolCallEvent) => void) | null = null;
  private turnCompleteHandler: ((e: TurnCompleteEvent) => void) | null = null;
  private interruptedHandler: ((e: InterruptedEvent) => void) | null = null;
  private usageHandler: ((e: UpstreamUsageEvent) => void) | null = null;
  private errorHandler: ((e: UpstreamErrorEvent) => void) | null = null;
  private closeHandler: ((e: UpstreamCloseEvent) => void) | null = null;

  constructor(deps: NovaSonicLiveClientDeps) {
    this.deps = deps;
    this.queue = new NovaInputQueue(deps.audioHighWaterMark ?? 64);
  }

  getState(): UpstreamConnectionState {
    return this.state;
  }

  onAudioOutput(handler: (event: AudioOutputEvent) => void): void { this.audioOutputHandler = handler; }
  onTranscript(handler: (event: TranscriptEvent) => void): void { this.transcriptHandler = handler; }
  onToolCall(handler: (event: ToolCallEvent) => void): void { this.toolCallHandler = handler; }
  onTurnComplete(handler: (event: TurnCompleteEvent) => void): void { this.turnCompleteHandler = handler; }
  onInterrupted(handler: (event: InterruptedEvent) => void): void { this.interruptedHandler = handler; }
  onUsage(handler: (event: UpstreamUsageEvent) => void): void { this.usageHandler = handler; }
  onSessionResumption(_handler: (event: SessionResumptionEvent) => void): void {
    // Nova has no native resumption — rotation rebuilds the prompt instead.
  }
  onGoAway(_handler: (event: GoAwayEvent) => void): void {
    // No GoAway on Bedrock streams; the rotation timer covers the cap.
  }
  onError(handler: (event: UpstreamErrorEvent) => void): void { this.errorHandler = handler; }
  onClose(handler: (event: UpstreamCloseEvent) => void): void { this.closeHandler = handler; }

  async connect(options: UpstreamConnectOptions): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`invalid_state: cannot connect from state '${this.state}'`);
    }
    this.state = 'connecting';

    let tools;
    try {
      tools = options.tools && options.tools.length > 0
        ? convertToolsToNovaSpecs(options.tools)
        : [];
    } catch (err) {
      this.state = 'error';
      this.emitError({ code: 'nova_validation', message: 'Nova tool catalog rejected before stream open' });
      throw err;
    }

    // Queue the full initialization sequence BEFORE opening the stream so
    // the request body replays it in order the moment Bedrock connects.
    const systemContentName = randomUUID();
    this.queue.push(buildSessionStart());
    this.queue.push(buildPromptStart({ promptName: this.promptName, voiceId: this.deps.voiceId, tools }));
    this.queue.push(buildTextContentStart({ promptName: this.promptName, contentName: systemContentName, role: 'SYSTEM' }));
    this.queue.push(buildTextInput({ promptName: this.promptName, contentName: systemContentName, content: options.systemInstruction }));
    this.queue.push(buildContentEnd({ promptName: this.promptName, contentName: systemContentName }));
    // Long-lived USER audio block — stays open for the whole stream; Nova's
    // server-side turn detection segments utterances.
    this.queue.push(buildAudioContentStart({ promptName: this.promptName, contentName: this.audioContentName }));

    try {
      if (this.deps.createBedrockClient) {
        this.bedrock = this.deps.createBedrockClient();
        this.ownsBedrock = true;
      } else {
        this.bedrock = await defaultBedrockFactory(this.deps.config);
        this.ownsBedrock = false;
      }

      const commandInput = { modelId: this.deps.config.modelId, body: this.queue };
      let command: unknown = commandInput;
      if (this.deps.createCommand) {
        command = this.deps.createCommand(commandInput);
      } else {
        const { InvokeModelWithBidirectionalStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
        command = new InvokeModelWithBidirectionalStreamCommand(
          commandInput as ConstructorParameters<typeof InvokeModelWithBidirectionalStreamCommand>[0],
        );
      }

      const response = await this.bedrock.send(command);
      if (!response.body) {
        throw Object.assign(new Error('nova response stream absent'), { name: 'ModelStreamErrorException' });
      }

      this.state = 'open';
      this.armRotationTimer();
      this.responseLoopDone = this.runResponseLoop(response.body);
    } catch (err) {
      const code = classifyNovaError(err);
      this.state = 'error';
      this.emitError({ code, message: `Nova connect failed (${code})`, cause: err });
      this.finalizeClose({ initiatedLocally: false, reason: code });
      throw new Error(`nova_connect_failed: ${code}`);
    }
  }

  private armRotationTimer(): void {
    this.rotationTimer = setTimeout(() => {
      if (this.rotationFired || this.state !== 'open') return;
      this.rotationFired = true;
      try {
        this.deps.onRotationDue?.();
      } catch {
        /* rotation callback must never destabilize the stream */
      }
    }, this.deps.config.rotationAfterMs);
    // Never keep the process alive for a rotation timer.
    this.rotationTimer.unref?.();
  }

  private async runResponseLoop(
    body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>,
  ): Promise<void> {
    try {
      for await (const item of body) {
        if (this.state !== 'open' && this.state !== 'closing') break;
        const bytes = item?.chunk?.bytes;
        if (!bytes) continue;
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          this.emitError({ code: 'nova_protocol_error', message: 'Non-JSON chunk from Nova stream' });
          continue;
        }
        this.dispatchNormalized(decoded);
      }
      // Stream ended (remote close or post-sessionEnd drain).
      if (!this.closeEmitted) {
        this.state = 'closed';
        this.finalizeClose({ initiatedLocally: this.localCloseReason !== undefined, reason: this.localCloseReason });
      }
    } catch (err) {
      if (this.closeEmitted) return;
      const code = classifyNovaError(err);
      this.state = 'error';
      this.emitError({ code, message: `Nova stream failed (${code})`, cause: err });
      this.finalizeClose({ initiatedLocally: false, reason: code });
    }
  }

  private dispatchNormalized(decoded: unknown): void {
    for (const event of this.normalizer.normalize(decoded)) {
      switch (event.kind) {
        case 'transcript':
          this.transcriptHandler?.({
            direction: event.direction,
            text: event.text,
            isFinal: event.isFinal,
            generationStage: event.generationStage,
          });
          break;
        case 'audio':
          this.audioOutputHandler?.({ dataB64: event.dataB64, mimeType: event.mimeType });
          break;
        case 'toolCall':
          this.toolCallHandler?.({
            calls: [{ name: event.name, args: event.args, id: event.callId }],
          });
          break;
        case 'interrupted':
          this.interruptedHandler?.({});
          break;
        case 'turnComplete':
          this.turnCompleteHandler?.({});
          break;
        case 'usage':
          this.usageHandler?.(event.usage);
          break;
        case 'ignored':
          break;
      }
    }
  }

  sendAudioChunk(audioB64: string, _mimeType?: string): boolean {
    if (this.state !== 'open') return false;
    // Base64 passthrough — never decode/re-encode the PCM payload.
    const accepted = this.queue.pushAudio(
      buildAudioInput({ promptName: this.promptName, contentName: this.audioContentName, dataB64: audioB64 }),
    );
    if (!accepted) {
      this.emitError({ code: 'nova_backpressure', message: 'Nova input queue high-water mark reached; audio chunk dropped' });
    }
    return accepted;
  }

  sendTextTurn(text: string, _turnComplete?: boolean): boolean {
    if (this.state !== 'open') return false;
    const contentName = randomUUID();
    this.queue.push(buildTextContentStart({ promptName: this.promptName, contentName, role: 'USER' }));
    this.queue.push(buildTextInput({ promptName: this.promptName, contentName, content: text }));
    this.queue.push(buildContentEnd({ promptName: this.promptName, contentName }));
    return true;
  }

  sendEndOfTurn(): boolean {
    // Nova uses server-side turn detection; the long-lived audio block stays
    // open. Returning true keeps the session layer's contract satisfied.
    return this.state === 'open';
  }

  sendToolResult(result: UpstreamToolResult): boolean {
    if (this.state !== 'open') return false;
    if (!result.callId) {
      this.emitError({ code: 'nova_protocol_error', message: 'Tool result missing callId — cannot correlate toolUse' });
      return false;
    }
    const content = result.success
      ? result.output
      : JSON.stringify({ error: result.error ?? 'tool failed', output: result.output });
    for (const event of buildToolResultEvents({
      promptName: this.promptName,
      contentName: randomUUID(),
      toolUseId: result.callId,
      content,
    })) {
      this.queue.push(event);
    }
    return true;
  }

  async close(reason?: string): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.localCloseReason = reason ?? 'local_close';
    this.state = 'closing';
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    // Orderly teardown: close the audio block, end the prompt + session,
    // then close the input queue so the request stream completes.
    this.queue.push(buildContentEnd({ promptName: this.promptName, contentName: this.audioContentName }));
    this.queue.push(buildPromptEnd(this.promptName));
    this.queue.push(buildSessionEnd());
    this.queue.close();

    // Give the response loop a moment to drain, then finalize regardless.
    if (this.responseLoopDone) {
      await Promise.race([
        this.responseLoopDone,
        new Promise((r) => setTimeout(r, 1_000).unref?.()),
      ]);
    }
    if (!this.closeEmitted) {
      this.state = 'closed';
      this.finalizeClose({ initiatedLocally: true, reason });
    }
    try {
      // Never destroy the shared client — its pooled HTTP/2 sessions are
      // exactly what makes the next session's connect fast.
      if (this.ownsBedrock) this.bedrock?.destroy?.();
    } catch {
      /* ignore */
    }
  }

  private finalizeClose(event: UpstreamCloseEvent): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.state = 'closed';
    this.queue.close();
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    try {
      this.closeHandler?.(event);
    } catch {
      /* swallow handler exceptions */
    }
  }

  private emitError(err: UpstreamErrorEvent): void {
    // One typed error per failure; never spam identical categories.
    if (this.errorEmitted && (err.code === 'nova_stream_error' || err.code === 'nova_stream_timeout')) {
      return;
    }
    if (err.code !== 'nova_backpressure' && err.code !== 'nova_protocol_error') {
      this.errorEmitted = true;
    }
    try {
      this.errorHandler?.(err);
    } catch {
      /* swallow handler exceptions */
    }
  }
}
