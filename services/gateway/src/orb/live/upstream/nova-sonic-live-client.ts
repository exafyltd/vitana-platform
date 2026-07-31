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
import { NOVA_IDLE_WATCHDOG_TICK_MS } from './nova-sonic-config';
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
 * Extract a bounded upstream error detail for the `diagnostic` field on
 * UpstreamErrorEvent — operator/bench surfaces only, never end-user UI.
 * Truncated so a pathological message can't bloat logs or events.
 */
export function extractNovaDiagnostic(err: unknown): string | undefined {
  const message = (err as { message?: unknown })?.message;
  if (typeof message !== 'string' || message.trim() === '') return undefined;
  return message.length > 400 ? `${message.slice(0, 400)}…` : message;
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
  /**
   * BOOTSTRAP-NOVA-IDLE-ROTATION: fail-safe rotation callback, fired when
   * no input has been ACCEPTED for config.idleRotationAfterMs — i.e. the
   * session is drifting toward Bedrock's ~295s idle kill. Unlike
   * onRotationDue this can fire more than once per stream (a session may go
   * idle, rotate, converse, and go idle again), but never twice without
   * fresh input in between.
   */
  onIdleDeadlineApproaching?: (info: { msSinceLastInput: number }) => void;
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

/**
 * L-02: promise-memoized, not just value-memoized.
 *
 * The old `if (!sharedBedrockClient) sharedBedrockClient = await build(...)`
 * shape races: two callers arriving before the first build resolves both see
 * null and both build a client, the second overwriting the first. That was
 * harmless while the only caller was serial, but the session path now kicks
 * transport preparation CONCURRENTLY with context assembly, which makes the
 * race the normal case rather than a rarity. Memoizing the in-flight promise
 * collapses concurrent callers onto one build; a failed build clears the
 * memo so the next attempt can retry rather than caching the failure.
 */
let sharedBedrockClientPromise: Promise<NovaBedrockLike> | null = null;

async function defaultBedrockFactory(config: NovaSonicConfig): Promise<NovaBedrockLike> {
  if (sharedBedrockClient) return sharedBedrockClient;
  if (!sharedBedrockClientPromise) {
    sharedBedrockClientPromise = buildBedrockClient(config)
      .then((client) => {
        sharedBedrockClient = client;
        return client;
      })
      .catch((err) => {
        sharedBedrockClientPromise = null;
        throw err;
      });
  }
  return sharedBedrockClientPromise;
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

/** Minimal system instruction for the model-execution warm probe — no tools,
 *  no persona, no user context. Small enough to add negligible processing
 *  time of its own, while still exercising the real inference path. */
const MODEL_WARM_SYSTEM_INSTRUCTION =
  'You are a connection health probe. When you receive any input, respond ' +
  'with exactly one short word and then stop. Do not ask questions.';
const MODEL_WARM_PROMPT = 'Say one short word to confirm you are working.';
const MODEL_WARM_TIMEOUT_MS = 8_000;

/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (latency): real (tiny) model-execution warm-up.
 *
 * `warmNovaSonicConnection` above keeps the TRANSPORT hot (DNS/TCP/TLS/HTTP2
 * + credentials) via a request Bedrock rejects before inference — it never
 * touches the model executor. Live production data showed Nova's
 * audio_out_first_chunk swinging 2.5s-9.9s (vs. Vertex's tighter 3.3-5.6s
 * band) — the same cold/warm split found in earlier isolated testing, now
 * on real customer traffic: a session that lands right after another is
 * consistently fast, one after any idle gap pays a much larger tax.
 *
 * This opens a real, minimal `NovaSonicLiveClient` session (no tools, a
 * one-line system instruction, a one-line forced turn), waits for the FIRST
 * genuine model output (audio, transcript, or turn-complete — whichever
 * arrives first proves the executor actually ran), then closes immediately.
 * The tiny real inference cost is the point: it is what keeps the model
 * executor itself hot between real user sessions, the way
 * `warmNovaSonicConnection` keeps the pipe hot. Runs fully isolated from
 * `liveSessions` / OASIS session bookkeeping / quota meters — it is
 * infrastructure health, never a user-visible session — and, per the
 * keep-warm telemetry discipline (CLAUDE.md: "Never mark polling or
 * heartbeats as OASIS events"), emits nothing but a console line.
 *
 * Returns latency ms (connect start → first genuine output) on success,
 * null on any failure (transport, timeout, or model error) — same contract
 * shape as `warmNovaSonicConnection` so the keep-warm loop can treat both
 * uniformly.
 */
export async function warmNovaSonicModelExecution(config: NovaSonicConfig): Promise<number | null> {
  const t0 = Date.now();
  const client = new NovaSonicLiveClient({ config, voiceId: 'tina' });
  let settled = false;
  return new Promise<number | null>((resolve) => {
    const finish = (result: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void client.close('model_warm_probe_done').catch(() => { /* best-effort */ });
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), MODEL_WARM_TIMEOUT_MS);
    (timer as NodeJS.Timeout).unref?.();

    client.onAudioOutput(() => finish(Date.now() - t0));
    client.onTranscript((e) => { if (e.direction === 'output') finish(Date.now() - t0); });
    client.onTurnComplete(() => finish(Date.now() - t0));
    client.onError(() => finish(null));
    client.onClose(() => finish(null));

    client
      .connect({
        model: config.modelId,
        voiceName: 'tina',
        responseModalities: ['audio'],
        vadSilenceMs: 750,
        systemInstruction: MODEL_WARM_SYSTEM_INSTRUCTION,
        tools: [],
        connectTimeoutMs: config.connectTimeoutMs,
      })
      .then(() => {
        client.sendTextTurn(MODEL_WARM_PROMPT, true);
      })
      .catch(() => finish(null));
  });
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
  // Must clear the in-flight memo too — otherwise a test that injects null to
  // force a rebuild would still be served the previously memoized promise.
  sharedBedrockClientPromise = null;
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
  /** Idle-deadline fail-safe (BOOTSTRAP-NOVA-IDLE-ROTATION). */
  private idleWatchdog: NodeJS.Timeout | null = null;
  /**
   * Wall-clock of the last input Bedrock actually ACCEPTED. A refused frame
   * (backpressure) is deliberately NOT stamped — it never reached Bedrock,
   * so it never reset Bedrock's idle clock, and pretending otherwise would
   * make this watchdog blind in exactly the situation it exists for.
   */
  private lastInputAcceptedAt = 0;
  /** Set when the idle callback fires; cleared by the next accepted input. */
  private idleRotationSignalled = false;
  private closeEmitted = false;
  /** Frames actually queued — gates the audio contentEnd on teardown. */
  private audioFramesSent = 0;
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
      this.emitError({
        code: 'nova_validation',
        message: 'Nova tool catalog rejected before stream open',
        diagnostic: extractNovaDiagnostic(err),
      });
      throw err;
    }

    // Queue the full initialization sequence BEFORE opening the stream so
    // the request body replays it in order the moment Bedrock connects.
    const systemContentName = randomUUID();
    this.queue.push(buildSessionStart({
      maxTokens: this.deps.config.maxTokens,
      endpointingSensitivity: this.deps.config.endpointingSensitivity,
    }));
    this.queue.push(buildPromptStart({ promptName: this.promptName, voiceId: this.deps.voiceId, tools }));
    // interactive:false — the documented shape for SYSTEM prompts (the
    // interactive:true form is the cross-modal USER text path, which may
    // carry different validation limits).
    this.queue.push(buildTextContentStart({
      promptName: this.promptName,
      contentName: systemContentName,
      role: 'SYSTEM',
      interactive: false,
    }));
    // Chunk oversized system instructions into multiple textInput events
    // within the single SYSTEM block — Nova rejects a single large textInput
    // with nova_validation, but streams many bounded events fine (same
    // pattern as audioInput frames).
    const chunkBytes = options.systemInstructionChunkBytes;
    if (chunkBytes && chunkBytes > 0 && options.systemInstruction.length > chunkBytes) {
      for (let i = 0; i < options.systemInstruction.length; i += chunkBytes) {
        this.queue.push(buildTextInput({
          promptName: this.promptName,
          contentName: systemContentName,
          content: options.systemInstruction.slice(i, i + chunkBytes),
        }));
      }
    } else {
      this.queue.push(buildTextInput({ promptName: this.promptName, contentName: systemContentName, content: options.systemInstruction }));
    }
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
      // The init sequence above (sessionStart → promptStart → system block →
      // audioContentStart) is real accepted input, so the idle clock starts
      // here rather than at zero — otherwise a stream would look 240s idle
      // the instant it opened.
      this.markInputAccepted();
      this.armRotationTimer();
      this.armIdleWatchdog();
      this.responseLoopDone = this.runResponseLoop(response.body);
    } catch (err) {
      const code = classifyNovaError(err);
      const diagnostic = extractNovaDiagnostic(err);
      this.state = 'error';
      this.emitError({ code, message: `Nova connect failed (${code})`, cause: err, diagnostic });
      this.finalizeClose({ initiatedLocally: false, reason: code });
      // The typed message stays generic; the bounded upstream detail rides a
      // non-message property for operator surfaces (OASIS events, bench).
      throw Object.assign(new Error(`nova_connect_failed: ${code}`), { diagnostic });
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

  /**
   * BOOTSTRAP-NOVA-IDLE-ROTATION: sample the elapsed-since-last-accepted-input
   * clock and signal when it approaches Bedrock's ~295s idle deadline.
   *
   * Sampling rather than a one-shot `setTimeout` because the deadline is
   * measured from a MOVING timestamp — every accepted frame pushes it out.
   * Re-arming a one-shot on every audio frame would mean tearing down and
   * rebuilding a timer 4x/second for the entire session.
   */
  private armIdleWatchdog(): void {
    const limit = this.deps.config.idleRotationAfterMs;
    if (!limit || limit <= 0) return; // explicitly disabled
    this.idleWatchdog = setInterval(() => {
      if (this.state !== 'open') return;
      // One signal per idle episode. Without this the callback would re-fire
      // every tick for as long as the session stayed quiet, stacking
      // rotation attempts on top of each other.
      if (this.idleRotationSignalled) return;
      const msSinceLastInput = Date.now() - this.lastInputAcceptedAt;
      if (msSinceLastInput < limit) return;
      this.idleRotationSignalled = true;
      try {
        this.deps.onIdleDeadlineApproaching?.({ msSinceLastInput });
      } catch {
        /* fail-safe callback must never destabilize the stream */
      }
    }, NOVA_IDLE_WATCHDOG_TICK_MS);
    this.idleWatchdog.unref?.();
  }

  private clearIdleWatchdog(): void {
    if (this.idleWatchdog) {
      clearInterval(this.idleWatchdog);
      this.idleWatchdog = null;
    }
  }

  /**
   * Stamp the idle clock. Call ONLY where Bedrock genuinely accepted input —
   * a dropped/refused event must not reset it.
   */
  private markInputAccepted(): void {
    this.lastInputAcceptedAt = Date.now();
    this.idleRotationSignalled = false;
  }

  /**
   * Milliseconds since the last accepted input, for telemetry and tests.
   * Returns 0 before the stream opens.
   */
  getMsSinceLastAcceptedInput(): number {
    if (!this.lastInputAcceptedAt) return 0;
    return Date.now() - this.lastInputAcceptedAt;
  }

  private async runResponseLoop(
    body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>,
  ): Promise<void> {
    try {
      for await (const item of body) {
        if (this.state !== 'open' && this.state !== 'closing') break;
        const bytes = item?.chunk?.bytes;
        if (!bytes) {
          // Bedrock delivers service errors as NAMED eventstream union
          // members (validationException, modelStreamErrorException, …) —
          // never let one pass silently or the session dies with no trace.
          const exceptionMember = Object.keys(item ?? {}).find((k) =>
            /exception/i.test(k));
          if (exceptionMember) {
            const code = classifyNovaError({ name: exceptionMember.replace(/^./, (c) => c.toUpperCase()) });
            this.state = 'error';
            this.emitError({
              code,
              message: `Nova stream exception event (${code}: ${exceptionMember})`,
              diagnostic: extractNovaDiagnostic((item as Record<string, unknown>)[exceptionMember]),
            });
            this.finalizeClose({ initiatedLocally: false, reason: code });
            return;
          }
          continue;
        }
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
      this.emitError({ code, message: `Nova stream failed (${code})`, cause: err, diagnostic: extractNovaDiagnostic(err) });
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
      // Deliberately no markInputAccepted() here — a refused frame never
      // reached Bedrock, so Bedrock's idle clock did not move. Stamping it
      // would hide sustained backpressure from the idle watchdog, which is
      // one of the ways frames can silently stop flowing.
      this.emitError({ code: 'nova_backpressure', message: 'Nova input queue high-water mark reached; audio chunk dropped' });
    } else {
      this.audioFramesSent++;
      this.markInputAccepted();
    }
    return accepted;
  }

  sendTextTurn(text: string, _turnComplete?: boolean): boolean {
    if (this.state !== 'open') return false;
    const contentName = randomUUID();
    this.queue.push(buildTextContentStart({ promptName: this.promptName, contentName, role: 'USER' }));
    this.queue.push(buildTextInput({ promptName: this.promptName, contentName, content: text }));
    this.queue.push(buildContentEnd({ promptName: this.promptName, contentName }));
    this.markInputAccepted();
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
    const raw = result.success
      ? result.output
      : JSON.stringify({ error: result.error ?? 'tool failed', output: result.output });
    // Nova requires toolResult.content to parse as a JSON OBJECT — a plain
    // text (or array/scalar JSON) payload kills the whole stream with
    // "Tool Response parsing error" (measured live, 2026-07-27). Pass JSON
    // objects through untouched; wrap everything else.
    let content: string;
    try {
      const parsed: unknown = JSON.parse(raw);
      content = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? raw
        : JSON.stringify({ result: parsed });
    } catch {
      content = JSON.stringify({ result: raw });
    }
    for (const event of buildToolResultEvents({
      promptName: this.promptName,
      contentName: randomUUID(),
      toolUseId: result.callId,
      content,
    })) {
      this.queue.push(event);
    }
    // Bedrock's idle message names "audio bytes or interactive content" —
    // a tool result is interactive content, so it resets the idle clock. This
    // matters for long tool round-trips, where a slow tool is the only thing
    // keeping the session from looking idle.
    this.markInputAccepted();
    return true;
  }

  async close(reason?: string): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') return;
    // Nova item 6: every caller should name its reason. The fallback is
    // deliberately NOT the old catch-all 'local_close' — if this label shows
    // up in telemetry it means a close path was added without a reason, and
    // that should be visible rather than blending into the historical bucket.
    this.localCloseReason = reason ?? 'local_close_unspecified';
    this.state = 'closing';
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    this.clearIdleWatchdog();
    // Orderly teardown: close the audio block, end the prompt + session,
    // then close the input queue so the request stream completes. Nova
    // rejects a contentEnd for a content block that never received data
    // ("no content data was received"), so the audio block is only ended
    // when at least one audioInput frame actually went out.
    if (this.audioFramesSent > 0) {
      this.queue.push(buildContentEnd({ promptName: this.promptName, contentName: this.audioContentName }));
    }
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
      // Use the normalized reason, not the raw arg — a bare close() must
      // report the same label here as it does on the response-loop path
      // (which reads localCloseReason), otherwise the same event shows up
      // as two different reasons depending on which path won the race.
      this.finalizeClose({ initiatedLocally: true, reason: this.localCloseReason });
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
    // Nova item 6: one structured line per disconnect. 72h of prod showed 42
    // of 46 Nova sessions labelled only 'local_close', which made the cause
    // unreadable. These fields are the ones that were actually missing when
    // trying to tell a user stop from a transport loss from a rotation swap.
    console.log(
      `[BOOTSTRAP-NOVA-SONIC-VOICE] nova_close reason=${event.reason ?? 'unknown'} ` +
        `initiated_locally=${event.initiatedLocally} rotation_fired=${this.rotationFired} ` +
        `ms_since_last_input=${this.lastInputAcceptedAt ? Date.now() - this.lastInputAcceptedAt : -1} ` +
        `commit=${process.env.GIT_COMMIT_SHA?.slice(0, 12) ?? 'unknown'}`,
    );
    this.queue.close();
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    this.clearIdleWatchdog();
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
