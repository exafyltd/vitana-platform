/**
 * VTID-03683: the CASCADED voice client — Transcribe → Bedrock → Polly.
 *
 * Implements the same `UpstreamLiveClient` interface as `NovaSonicLiveClient`
 * and `VertexLiveClient`, so the session layer, telemetry and teardown paths
 * are untouched. What differs is that "the model" is not one speech-to-speech
 * stream but three services composed per turn.
 *
 * WHY: Nova Sonic supports `en de fr es pt` and nothing else. `ru`/`pl`/`ar`/
 * `zh` sessions are forced onto it anyway once Vertex died
 * (`upstream-provider-selector.ts` skips its own language gate when
 * `vertexUnavailable`), and produce ~30 audio chunks per turn against
 * de/en's ~165. See `cascaded-config.ts` for the full measurement.
 *
 * TURN SHAPE — and why it is not speech-to-speech
 * -----------------------------------------------
 *   user audio ──▶ Transcribe (streaming, opens on first chunk)
 *                    │ final fragments accumulate
 *   sendEndOfTurn ──▶ Bedrock (one completion, via the existing llm-router)
 *                    │
 *                  Polly ──▶ audio chunks ──▶ onAudioOutput ──▶ client
 *
 * This is strictly worse than Nova on latency and prosody: three sequential
 * network hops instead of one duplex stream, and no barge-in mid-generation.
 * It is scoped to languages that currently get nothing usable, and
 * `evaluateCascadeEligibility()` REFUSES any language Nova speaks natively so
 * a working session can never be downgraded into this path.
 *
 * KNOWN LIMITATION — TOOLS ARE NOT WIRED (stated, not hidden)
 * -----------------------------------------------------------
 * `onToolCall` is never fired, so the ~546-tool ORB catalog is unavailable on
 * this path: a Russian user gets conversation, not actions. `sendToolResult()`
 * therefore returns `false` and is unreachable in practice — the session layer
 * only calls it in response to a tool call this client never emits, so it
 * cannot hang waiting for one (the failure mode Nova has: an unanswered
 * `toolUse` stalls forever).
 *
 * That gap is deliberate scope, not an oversight: `callViaRouter` already
 * supports tools (VTID-03579 added `toolCalls`), so wiring the loop is a
 * follow-up increment rather than a redesign. Shipping conversation-only for
 * languages that today produce garbled fragments is a strict improvement;
 * claiming tool parity it does not have would not be.
 *
 * VTID-04413 — the orchestrator's specialist tools (`ask_support_specialist`,
 * `ask_commerce_specialist` and their `get_delegation_result` /
 * `cancel_delegation` companions) join the allowlist, so a member speaking a
 * cascade language reaches the same specialists a Nova session does. They
 * are declared only when the catalog passed to `connect()` carries them.
 *
 * VTID-04336 — THE ONE EXCEPTION: THE HAND-OFF TOOLS, AND PERSONA SWAP
 * ------------------------------------------------------------------
 * The owner decided the Vitana → Devon hand-off must work in every language.
 * So exactly the tools in `CASCADE_TOOL_ALLOWLIST` (`report_to_specialist`,
 * `switch_persona`) are declared to the model — filtered out of whatever
 * catalog `connect()` receives, so the rest of the catalog stays off this
 * path as before. One bounded round per turn: the model may call them,
 * `onToolCall` fires, the session layer answers through `sendToolResult()`,
 * and one tool-less continuation call produces the spoken bridge. A result
 * that never arrives is answered with a synthetic error after
 * `CASCADE_TOOL_RESULT_TIMEOUT_MS` — this client never hangs on an
 * unanswered call.
 *
 * The hand-off then happens IN PROCESS (`applyPersona()`): there is no
 * upstream stream to close and reopen, so the session layer swaps the system
 * instruction and the TTS voice role on this same client instead of closing
 * it with reason `persona_swap` the way Nova/Vertex do.
 *
 * A bounded rolling history (`CASCADE_HISTORY_MAX_MESSAGES`) is kept too:
 * without it every turn saw only the latest utterance, so the hand-off's own
 * rule — propose, then call only after the member says yes — could never be
 * satisfied (the "yes" turn had no memory of the proposal).
 */

import type {
  UpstreamLiveClient,
  UpstreamConnectOptions,
  UpstreamConnectionState,
  AudioOutputEvent,
  TranscriptEvent,
  ToolCallEvent,
  TurnCompleteEvent,
  InterruptedEvent,
  UpstreamErrorEvent,
  UpstreamCloseEvent,
  UpstreamToolResult,
} from './types';
import { TranscribeStreamSession } from './cascaded/transcribe-stream';
import { synthesizeCascadeReply } from './cascaded/tts-backend';
import {
  isCascadeStreamingEnabled,
  speakableSegments,
  speakSegmentsInOrder,
} from './cascaded/sentence-pipeline';
import { evaluateCascadeEligibility } from './cascaded-config';
import {
  callViaRouter,
  type LLMRouterMessage,
  type LLMRouterTool,
  type LLMRouterToolCall,
} from '../../../services/llm-router';
import type { PollyVoiceRole } from '../../../services/tts/polly';

export interface CascadedLiveClientDeps {
  /** Session language (base code, e.g. `ru`). Decides Transcribe + Polly. */
  lang: string;
  /** Bytes per emitted audio chunk. Matches the client's PCM framing. */
  audioChunkBytes?: number;
}

/** Polly PCM comes back at 16 kHz — never 24 kHz (VTID-03495). */
const POLLY_PCM_SAMPLE_RATE_HZ = 16_000;

/**
 * Emitted audio is sliced into chunks rather than delivered as one blob.
 * The widget's player is fed incrementally by every other provider, and a
 * single large buffer would change its buffering behaviour on this path only.
 */
const DEFAULT_AUDIO_CHUNK_BYTES = 32_000;

/**
 * VTID-03986 — margin added on top of the estimated TTS playback duration
 * before mic audio is forwarded to Transcribe again. Covers the gap between
 * the server emitting the last audio chunk and the client actually finishing
 * playback (network delivery, client-side buffering/decode). Deliberately
 * generous over precise: an over-wide gate only delays picking up the next
 * real utterance by a few hundred ms, while an under-wide one re-admits the
 * exact backlog this fix exists to remove.
 */
const PLAYBACK_MARGIN_MS = 400;

/**
 * VTID-03722 — default silence budget that ends a user turn, in ms.
 *
 * 900ms: long enough to survive a mid-sentence pause (Transcribe emits finals
 * at clause boundaries, so a shorter value cuts people off), short enough that
 * the reply does not feel hung. Overridable per-session via `vadSilenceMs` on
 * connect(), which is range-guarded rather than trusted.
 */
export const DEFAULT_CASCADE_VAD_SILENCE_MS = 900;

/**
 * VTID-04336 — the only tools the cascade declares: the two that move a
 * member between Vitana and a specialist. Anything else in the catalog
 * `connect()` receives is dropped here, so this path does not silently grow
 * tool parity it has never been tested for.
 */
export const CASCADE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'report_to_specialist',
  'switch_persona',
  // VTID-04413 (Orchestrator P3): agent-as-tool specialists. Declared only
  // when the session catalog already carries them — their own flags and the
  // surface gate decide that upstream, exactly as on Nova. The dispatcher
  // acks within 1.5 s, well inside CASCADE_TOOL_RESULT_TIMEOUT_MS.
  'ask_support_specialist',
  'ask_commerce_specialist',
  'get_delegation_result',
  'cancel_delegation',
]);

/**
 * VTID-04521 — voice navigation on the cascade. With the screen registry
 * (NAV_V2_ENABLED) the three navigation tools run here exactly as on Nova:
 * the same executeLiveApiTool path, the directive played out after the
 * reply. Off the flag the cascade keeps its hand-off-only catalog.
 */
export const CASCADE_NAV_TOOLS: ReadonlySet<string> = new Set(['navigate', 'navigate_to_screen', 'get_current_screen']);

export function isCascadeTool(name: string): boolean {
  return CASCADE_TOOL_ALLOWLIST.has(name) || (process.env.NAV_V2_ENABLED === 'true' && CASCADE_NAV_TOOLS.has(name));
}

/** VTID-04336 — how long one tool call may take before a synthetic error result. */
export const CASCADE_TOOL_RESULT_TIMEOUT_MS = 20_000;

/** VTID-04336 — rolling history bound (messages, oldest dropped first). */
export const CASCADE_HISTORY_MAX_MESSAGES = 12;
const CASCADE_HISTORY_MAX_CHARS_PER_MESSAGE = 2_000;

/**
 * VTID-04336 — the continuation after the hand-off tools ran. A stage
 * direction (INTENT), never a spoken sentence — NEVER-rule 41: the model
 * composes the bridge from the tool result's own guidance.
 */
export const CASCADE_TOOL_CONTINUE_PROMPT =
  '(Stage direction, not the user speaking: the tool results are above. Now say what you say to the user, following the tool result guidance, in your own words and in the language of the conversation. Do not mention tools or this direction.)';

/**
 * VTID-04336 — the specialist's first turn after an in-process swap. The Nova
 * path gets the same cue as a reconnect "greeting nudge"; here it is an
 * INTENT the specialist's own prompt turns into words (NEVER-rule 41).
 */
export const CASCADE_PERSONA_OPENING_PROMPT =
  '(Stage direction, not the user speaking: the member has just been handed over to you on this voice call. Open now as your instructions describe, in your own words and in the language of the conversation, then stop and wait for the member.)';

/** VTID-04336 — input to `CascadedLiveClient.applyPersona()`. */
export interface CascadePersonaInput {
  /** Persona key now speaking (`vitana`, `devon`, …) — telemetry only. */
  persona: string;
  /**
   * The persona's full system instruction. Null/empty restores the
   * instruction the session connected with (Vitana's), plus `appendix`.
   */
  systemInstruction?: string | null;
  /** Extra context appended when restoring the connect-time instruction. */
  appendix?: string | null;
  /** Which TTS voice speaks from the next turn on. */
  voiceRole: PollyVoiceRole;
  /** Run the persona's opening turn right away (specialists: yes). */
  openWithGreeting: boolean;
}

export interface CascadePersonaApplied {
  persona: string;
  voiceRole: PollyVoiceRole;
  instructionChars: number;
  restoredBaseInstruction: boolean;
}

/**
 * VTID-04336 — flatten a provider-neutral tool catalog (Vertex-style
 * `{function_declarations:[…]}` entries or bare declarations) into router
 * tools, keeping only the allowlisted names.
 */
export function extractCascadeTools(
  tools: ReadonlyArray<Record<string, unknown>> | undefined,
): LLMRouterTool[] {
  if (!tools || tools.length === 0) return [];
  const flat: Array<Record<string, unknown>> = [];
  for (const entry of tools) {
    const decls =
      (entry as { function_declarations?: unknown }).function_declarations ??
      (entry as { functionDeclarations?: unknown }).functionDeclarations;
    if (Array.isArray(decls)) flat.push(...(decls as Array<Record<string, unknown>>));
    else if (typeof (entry as { name?: unknown }).name === 'string') flat.push(entry);
  }
  const out: LLMRouterTool[] = [];
  const seen = new Set<string>();
  for (const d of flat) {
    const name = d.name as string;
    if (!isCascadeTool(name) || seen.has(name)) continue;
    seen.add(name);
    const params = d.parameters;
    out.push({
      name,
      description: typeof d.description === 'string' ? d.description : '',
      inputSchema:
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : { type: 'object', properties: {} },
    });
  }
  return out;
}

export class CascadedLiveClient implements UpstreamLiveClient {
  private state: UpstreamConnectionState = 'idle';
  private readonly lang: string;
  private readonly audioChunkBytes: number;

  private transcribe: TranscribeStreamSession | null = null;
  private systemInstruction = '';
  /** VTID-04336 — the instruction the session connected with (Vitana's). */
  private baseInstruction = '';
  /** VTID-04336 — allowlisted hand-off tools declared to the model. */
  private tools: LLMRouterTool[] = [];
  /** VTID-04336 — bounded rolling conversation history, oldest first. */
  private history: LLMRouterMessage[] = [];
  /** VTID-04336 — which TTS voice speaks (receptionist until a swap). */
  private voiceRole: PollyVoiceRole = 'receptionist';
  private persona = 'vitana';
  /** VTID-04336 — an opening turn queued while another turn was generating. */
  private queuedOpener: string | null = null;
  private toolCallSeq = 0;
  private readonly pendingToolResults = new Map<
    string,
    (r: { result: string; isError: boolean }) => void
  >();
  private toolCallHandler: ((e: ToolCallEvent) => void) | null = null;

  /** Final user speech accumulated since the last turn boundary. */
  private pendingUserText = '';
  /**
   * VTID-03722 — silence budget that ENDS a user turn.
   *
   * Nova needs no such thing: it does its own VAD inside the bidirectional
   * stream, which is why `orb-widget.js` only ever sends `{type:'audio'}`
   * frames and NEVER an `end_turn` (verified: zero occurrences). The cascade
   * has no VAD, and `runTurn()` was reachable only from `sendTextTurn()` and
   * `sendEndOfTurn()` — so a real microphone turn transcribed fine, appended
   * to `pendingUserText`, and never invoked Bedrock. Greeting speaks, then
   * the user talks to a wall. Strictly worse than the English it replaced.
   *
   * `vadSilenceMs` was already being passed to `connect()` and dropped on the
   * floor; it is now the debounce that closes the turn.
   */
  private vadSilenceMs = DEFAULT_CASCADE_VAD_SILENCE_MS;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against two turns generating concurrently. */
  private turnInFlight = false;
  /**
   * VTID-03986 — epoch ms until which incoming mic audio is dropped rather
   * than forwarded to Transcribe. Set from the estimated playback duration
   * of the reply just emitted (see `emitAudio()`); `sendAudioChunk()` checks
   * it alongside `turnInFlight`. See `sendAudioChunk()` for why this exists.
   */
  private busyUntilMs = 0;
  /**
   * VTID-04550 — estimated end of client playback for the audio emitted so
   * far in the current pipelined turn (flag-on path only; reset per turn).
   */
  private pipelinePlaybackEndMs = 0;

  private audioHandler: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptHandler: ((e: TranscriptEvent) => void) | null = null;
  private turnCompleteHandler: ((e: TurnCompleteEvent) => void) | null = null;
  private interruptedHandler: ((e: InterruptedEvent) => void) | null = null;
  private errorHandler: ((e: UpstreamErrorEvent) => void) | null = null;
  private closeHandler: ((e: UpstreamCloseEvent) => void) | null = null;

  constructor(deps: CascadedLiveClientDeps) {
    this.lang = (deps.lang || '').trim().toLowerCase().split(/[-_]/)[0];
    this.audioChunkBytes = deps.audioChunkBytes ?? DEFAULT_AUDIO_CHUNK_BYTES;
  }

  async connect(options: UpstreamConnectOptions): Promise<void> {
    if (this.state !== 'idle') {
      throw Object.assign(new Error('cascaded client is not idle'), { code: 'invalid_state' });
    }
    this.state = 'connecting';

    // Refuse loudly rather than opening a session that can only produce
    // silence. `connect()` rejecting is the contract's own failure channel,
    // and it is far better than a connected-but-mute session — the exact
    // shape VTID-03480 spent two months invisible in.
    const eligibility = evaluateCascadeEligibility(this.lang);
    if (!eligibility.eligible || !eligibility.transcribeLanguageCode) {
      this.state = 'error';
      throw Object.assign(
        new Error(
          `cascaded pipeline cannot serve lang='${this.lang}' (${eligibility.reason ?? 'unknown'})`,
        ),
        { code: 'cascade_language_unsupported' },
      );
    }

    this.systemInstruction = options.systemInstruction || '';
    this.baseInstruction = this.systemInstruction;
    this.tools = extractCascadeTools(options.tools);
    // Guard the range: a 0/absent value would end the turn on the first final
    // fragment (cutting the user off mid-sentence), and an enormous one would
    // hang the turn forever. Both are worse than the default.
    const requestedVad = Number(options.vadSilenceMs);
    this.vadSilenceMs =
      Number.isFinite(requestedVad) && requestedVad >= 200 && requestedVad <= 10_000
        ? requestedVad
        : DEFAULT_CASCADE_VAD_SILENCE_MS;

    const transcribe = new TranscribeStreamSession({
      languageCode: eligibility.transcribeLanguageCode,
    });
    transcribe.onFragment((f) => {
      // Partials are forwarded for live captions but never accumulated:
      // Transcribe REVISES a partial, so appending them would feed the model
      // the same clause several times in slightly different wordings.
      this.transcriptHandler?.({ direction: 'input', text: f.text, isFinal: !f.isPartial });
      if (!f.isPartial) {
        this.pendingUserText = this.pendingUserText ? `${this.pendingUserText} ${f.text}` : f.text;
      }
      // VTID-03722: any fragment — partial or final — means the user is still
      // speaking, so push the boundary out. The turn fires only once the
      // silence budget elapses with nothing new arriving. Arming on partials
      // too is deliberate: a long sentence produces many partials between
      // finals, and debouncing only on finals would cut in mid-clause.
      this.armSilenceTimer();
    });
    transcribe.onError((err) => {
      this.errorHandler?.({
        code: 'transcribe_stream_error',
        message: err.message,
        cause: err,
        diagnostic: err.message.slice(0, 400),
      });
    });
    this.transcribe = transcribe;

    // There is no persistent upstream to hand-shake with: Transcribe opens on
    // the first audio chunk, Bedrock and Polly are per-turn request/response.
    // The session is "open" the moment it can accept audio.
    this.state = 'open';
  }

  sendAudioChunk(audioB64: string): boolean {
    if (this.state !== 'open' || !this.transcribe) return false;
    // VTID-03986 — full-duplex (VTID-03706) forwards a continuous audio
    // frame for the entire session, real speech above the echo floor and
    // digital silence below it, so Nova's own native VAD/barge-in keeps
    // working. This client has no use for that stream while a turn is
    // generating or its reply is still playing out client-side: the cascade
    // has no barge-in (see the file header) and `TranscribeStreamSession` is
    // a single, ordered, never-restarted pipe (see its own header) — every
    // frame pushed here is queued ahead of whatever the user says next, and
    // Transcribe must work through all of it before it can transcribe that.
    // Left ungated, every reply's own duration adds to a backlog that
    // compounds turn over turn (measured live on one session:
    // 8.7s -> 16.6s -> 35s -> 43s per-turn latency). Dropping here is safe:
    // the client already silences non-speech frames below the echo floor
    // (VTID-03706), so nothing meaningful is lost, and `turnInFlight`/
    // `busyUntilMs` both clear the instant it is safe to listen again.
    // Still `open` and functioning, so this is an intentional no-op, not
    // backpressure — return true, never false.
    if (this.turnInFlight || Date.now() < this.busyUntilMs) return true;
    this.transcribe.pushAudioB64(audioB64);
    return true;
  }

  sendTextTurn(text: string, turnComplete = true): boolean {
    if (this.state !== 'open') return false;
    if (text) {
      this.pendingUserText = this.pendingUserText ? `${this.pendingUserText} ${text}` : text;
    }
    if (turnComplete) void this.runTurn();
    return true;
  }

  sendEndOfTurn(): boolean {
    if (this.state !== 'open') return false;
    void this.runTurn();
    return true;
  }

  /**
   * VTID-04336 — answers a hand-off tool call this client emitted. Returns
   * `false` for a call id it is not waiting on (a late result after the
   * timeout, or no call at all), exactly like "not delivered" elsewhere.
   */
  sendToolResult(result: UpstreamToolResult): boolean {
    const key = result.callId ?? '';
    const resolve = this.pendingToolResults.get(key);
    if (!resolve) return false;
    this.pendingToolResults.delete(key);
    resolve({
      result: result.success ? result.output : result.error || result.output || 'tool failed',
      isError: !result.success,
    });
    return true;
  }

  /**
   * VTID-04336 — in-process persona swap. The cascade has no upstream stream
   * to reconnect, so instead of the Nova/Vertex close-with-`persona_swap` the
   * session layer calls this: the system instruction and TTS voice role are
   * replaced for every subsequent turn, the rolling history is cleared (the
   * specialist's prompt carries the hand-off transcript, the same way the
   * Nova reconnect rebuilds from it), and — for a specialist — the persona's
   * opening turn runs right after the current one finishes.
   */
  applyPersona(input: CascadePersonaInput): CascadePersonaApplied {
    const override = (input.systemInstruction ?? '').trim();
    const restoredBaseInstruction = !override;
    if (override) {
      this.systemInstruction = override;
    } else {
      const appendix = (input.appendix ?? '').trim();
      this.systemInstruction = appendix ? `${this.baseInstruction}\n\n${appendix}` : this.baseInstruction;
    }
    this.voiceRole = input.voiceRole;
    this.persona = input.persona;
    this.history = [];
    if (input.openWithGreeting) {
      this.queuedOpener = CASCADE_PERSONA_OPENING_PROMPT;
      if (!this.turnInFlight) this.runQueuedOpener();
    } else {
      this.queuedOpener = null;
    }
    return {
      persona: this.persona,
      voiceRole: this.voiceRole,
      instructionChars: this.systemInstruction.length,
      restoredBaseInstruction,
    };
  }

  /** VTID-04336 — test/telemetry seam: what the next turn will run with. */
  getPersonaState(): {
    persona: string;
    voiceRole: PollyVoiceRole;
    systemInstruction: string;
    toolNames: string[];
    historyLength: number;
  } {
    return {
      persona: this.persona,
      voiceRole: this.voiceRole,
      systemInstruction: this.systemInstruction,
      toolNames: this.tools.map((t) => t.name),
      historyLength: this.history.length,
    };
  }

  private runQueuedOpener(): void {
    const opener = this.queuedOpener;
    this.queuedOpener = null;
    if (!opener || this.state !== 'open') return;
    this.pendingUserText = this.pendingUserText ? `${opener} ${this.pendingUserText}` : opener;
    void this.runTurn();
  }

  private pushHistory(...messages: LLMRouterMessage[]): void {
    for (const m of messages) {
      if (!('toolCalls' in m) && 'content' in m && typeof m.content === 'string') {
        this.history.push({ role: m.role, content: m.content.slice(0, CASCADE_HISTORY_MAX_CHARS_PER_MESSAGE) });
      } else {
        this.history.push(m);
      }
    }
    // Trim from the front, never leaving a tool-result or an assistant
    // message first — a provider rejects a tool_result without its tool_use,
    // and a transcript must open on a user turn.
    while (this.history.length > CASCADE_HISTORY_MAX_MESSAGES) this.history.shift();
    while (
      this.history.length > 0 &&
      (this.history[0].role !== 'user' || 'toolResults' in this.history[0])
    ) {
      this.history.shift();
    }
  }

  /**
   * VTID-04336 — fire `onToolCall` for the model's hand-off calls and wait
   * for every result (or a synthetic timeout error). Never hangs.
   */
  private async runToolCalls(calls: LLMRouterToolCall[]): Promise<{
    withIds: LLMRouterToolCall[];
    results: Array<{ id?: string; name: string; result: string; isError?: boolean }>;
  }> {
    const withIds = calls.map((c) => ({
      ...c,
      arguments: c.arguments || {},
      id: c.id || `cascade-tool-${++this.toolCallSeq}`,
    }));
    const handler = this.toolCallHandler;
    const waits = withIds.map((c) => {
      if (!isCascadeTool(c.name) || !handler) {
        return Promise.resolve({ result: `tool ${c.name} is not available on this voice path`, isError: true });
      }
      const id = c.id as string;
      return new Promise<{ result: string; isError: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          if (this.pendingToolResults.delete(id)) {
            resolve({ result: `tool ${c.name} did not answer in time`, isError: true });
          }
        }, CASCADE_TOOL_RESULT_TIMEOUT_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.pendingToolResults.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
      });
    });
    const dispatchable = withIds.filter((c) => isCascadeTool(c.name));
    if (dispatchable.length > 0 && handler) {
      handler({ calls: dispatchable.map((c) => ({ name: c.name, args: c.arguments, id: c.id })) });
    }
    const outcomes = await Promise.all(waits);
    return {
      withIds,
      results: withIds.map((c, i) => ({
        id: c.id,
        name: c.name,
        result: outcomes[i].result,
        isError: outcomes[i].isError,
      })),
    };
  }

  /**
   * One turn: accumulated speech → Bedrock → Polly → audio out.
   *
   * Re-entrancy is guarded because `sendEndOfTurn()` can arrive again while a
   * turn is still generating (the client re-sends on VAD edges). Without the
   * latch the same user text would be answered twice and both answers would
   * be spoken over each other.
   */
  /** VTID-03722: (re)start the silence countdown that closes the user's turn. */
  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    if (this.state === 'closing' || this.state === 'closed') return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      // Nothing transcribed, or a turn is already running — the in-flight turn
      // re-arms nothing, so a late fragment simply starts the next countdown.
      if (!this.pendingUserText.trim() || this.turnInFlight) return;
      void this.runTurn();
    }, this.vadSilenceMs);
    // Do not hold the process open on this timer alone.
    (this.silenceTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private async runTurn(): Promise<void> {
    if (this.turnInFlight) return;
    const userText = this.pendingUserText.trim();
    if (!userText) return;

    this.turnInFlight = true;
    // VTID-03722: this turn consumed the buffered text; a countdown still
    // pending would fire against an empty buffer.
    this.clearSilenceTimer();
    this.pendingUserText = '';
    const startedAt = Date.now();

    try {
      // Stage `operator` — the conversational stage — not `memory`. Both are
      // valid `LLMStage`s and either would have compiled, but they route to
      // different models via `llm_routing_policy`; `memory` is the retrieval
      // stage five other services depend on, and borrowing it for spoken
      // dialogue would make this path's model choice change whenever theirs did.
      //
      // `systemPrompt` is the real field name. An earlier draft passed
      // `system` behind an `as never` cast, which compiled and would have
      // DROPPED the entire system instruction — every ounce of Vitana's
      // persona, memory and context — leaving a generic assistant that
      // sounded fine and knew nothing. That cast is gone; this call is fully
      // typed so the compiler owns the contract.
      const priorHistory = [...this.history];
      let completion = await callViaRouter('operator', userText, {
        service: 'orb-cascaded-voice',
        systemPrompt: this.systemInstruction,
        maxTokens: 400,
        // VTID-04336: bounded rolling history + the allowlisted hand-off
        // tools, each only when present — a first turn with no tools is the
        // exact pre-VTID-04336 request.
        ...(priorHistory.length > 0 ? { history: priorHistory } : {}),
        ...(this.tools.length > 0 ? { tools: this.tools } : {}),
      });

      // VTID-04336: one bounded tool round (hand-off tools only), then one
      // tool-less continuation that produces the spoken bridge.
      let toolRound: LLMRouterMessage[] = [];
      const requested =
        completion.ok && completion.toolCalls && completion.toolCalls.length > 0 ? completion.toolCalls : [];
      if (requested.length > 0) {
        const { withIds, results } = await this.runToolCalls(requested);
        toolRound = [
          { role: 'assistant', toolCalls: withIds, content: completion.text || undefined },
          { role: 'user', toolResults: results },
        ];
        completion = await callViaRouter('operator', CASCADE_TOOL_CONTINUE_PROMPT, {
          service: 'orb-cascaded-voice',
          systemPrompt: this.systemInstruction,
          maxTokens: 400,
          history: [...priorHistory, { role: 'user', content: userText }, ...toolRound],
        });
      }

      if (!completion.ok) {
        this.errorHandler?.({
          code: 'cascade_llm_failed',
          message: completion.error || 'LLM call failed for the cascaded turn',
          diagnostic: completion.error?.slice(0, 400),
        });
        return;
      }

      let replyText = (completion.text ?? '').trim();

      // VTID-03985: `callViaRouter` only escalates to the stage's fallback
      // model on an explicit failure (`ok:false`) — a primary call that
      // returns `ok:true` with EMPTY text (observed live the very first time
      // this cascade path ran for real, VTID-03984) sails straight through
      // as a "success" with nothing to say. Left alone, that silently drops
      // the turn and the session hangs until the 30s stall watchdog kills it
      // with a generic, unhelpful error — for a live spoken conversation,
      // dead air for 30s is a much worse failure mode than a slow reply.
      // One bounded retry against the stage's OWN currently-configured
      // fallback model (bedrock/eu.anthropic.claude-sonnet-4-6 — confirmed
      // live-invokable, CLAUDE.md §2b) before giving up for real.
      if (!replyText && !completion.fallbackUsed) {
        const retryHistory: LLMRouterMessage[] =
          toolRound.length > 0 ? [...priorHistory, { role: 'user', content: userText }, ...toolRound] : priorHistory;
        const retry = await callViaRouter('operator', toolRound.length > 0 ? CASCADE_TOOL_CONTINUE_PROMPT : userText, {
          service: 'orb-cascaded-voice',
          systemPrompt: this.systemInstruction,
          maxTokens: 400,
          ...(retryHistory.length > 0 ? { history: retryHistory } : {}),
          providerOverride: 'bedrock',
          modelOverride: 'eu.anthropic.claude-sonnet-4-6',
          allowFallback: false,
        });
        if (retry.ok) {
          replyText = (retry.text ?? '').trim();
        }
      }

      if (!replyText) {
        this.errorHandler?.({
          code: 'cascade_llm_empty',
          message: 'LLM returned no text for the cascaded turn (after retry)',
        });
        return;
      }

      this.transcriptHandler?.({ direction: 'output', text: replyText, isFinal: true });
      // VTID-04336: record the exchange (tool round included) so the next
      // turn knows what was proposed. A turn that failed above records
      // nothing — the member will repeat themselves anyway.
      if (toolRound.length > 0) {
        this.pushHistory(
          { role: 'user', content: userText },
          ...toolRound,
          { role: 'user', content: CASCADE_TOOL_CONTINUE_PROMPT },
          { role: 'assistant', content: replyText },
        );
      } else {
        this.pushHistory({ role: 'user', content: userText }, { role: 'assistant', content: replyText });
      }

      // VTID-03987: TTS backend selection (Polly first, Fish only when
      // Polly has no voice for the language at all) now lives in
      // `cascaded/tts-backend.ts` — see that file for why the boundary is
      // drawn there and what does/doesn't need a Polly-backed regression
      // test when changed. Behaviour here is unchanged from before the
      // extraction (VTID-03970's original selection).
      // VTID-04550: sentence-pipelined TTS, only when
      // ORB_CASCADE_STREAMING_ENABLED is exactly 'true'. Same text, same
      // backend selection, same failure report — the member just hears the
      // first sentence before the last one has been synthesized. Flag off
      // falls through to the unchanged single-call path below.
      if (isCascadeStreamingEnabled()) {
        const specialist = this.voiceRole === 'specialist';
        this.pipelinePlaybackEndMs = 0;
        const pipeline = await speakSegmentsInOrder(
          speakableSegments(replyText),
          (segment) =>
            specialist
              ? synthesizeCascadeReply(segment, this.lang, { voiceRole: 'specialist' })
              : synthesizeCascadeReply(segment, this.lang),
          (audioB64) => this.emitPipelinedAudio(audioB64),
          () => this.state !== 'closing' && this.state !== 'closed',
        );
        if (pipeline.stopped) return;
        if (!pipeline.ok) {
          this.errorHandler?.({
            code: 'cascade_tts_failed',
            message: `No TTS provider returned audio for lang='${this.lang}'`,
          });
          return;
        }
        this.turnCompleteHandler?.({ durationMs: Date.now() - startedAt });
        return;
      }

      // VTID-04336: the voice role only tells the backends WHO is speaking
      // (receptionist = the exact pre-swap request); selection is unchanged.
      const speech =
        this.voiceRole === 'specialist'
          ? await synthesizeCascadeReply(replyText, this.lang, { voiceRole: 'specialist' })
          : await synthesizeCascadeReply(replyText, this.lang);

      if (!speech?.audioB64) {
        // Eligibility already proved a TTS provider has a voice for this
        // language, so reaching here means a runtime synthesis failure, not
        // a coverage gap.
        this.errorHandler?.({
          code: 'cascade_tts_failed',
          message: `No TTS provider returned audio for lang='${this.lang}'`,
        });
        return;
      }

      this.emitAudio(speech.audioB64);
      this.turnCompleteHandler?.({ durationMs: Date.now() - startedAt });
    } catch (err) {
      this.errorHandler?.({
        code: 'cascade_turn_failed',
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    } finally {
      this.turnInFlight = false;
      // VTID-04336: a persona swap applied during this turn (from its own
      // turn-complete handler) queued the specialist's opening turn.
      if (this.queuedOpener) this.runQueuedOpener();
    }
  }

  /** Slice one PCM buffer into client-sized chunks and emit them in order. */
  private emitAudio(audioB64: string): void {
    const buf = Buffer.from(audioB64, 'base64');
    const mimeType = `audio/pcm;rate=${POLLY_PCM_SAMPLE_RATE_HZ}`;
    // VTID-03986 — 16-bit mono PCM: 2 bytes/sample. Extend the
    // `sendAudioChunk()` gate through this reply's estimated client-side
    // playback so full-duplex mic frames stop backing up Transcribe for as
    // long as Vitana is actually talking, not just while she is thinking.
    const estimatedPlaybackMs = Math.round((buf.length / 2 / POLLY_PCM_SAMPLE_RATE_HZ) * 1000);
    this.busyUntilMs = Date.now() + estimatedPlaybackMs + PLAYBACK_MARGIN_MS;
    for (let offset = 0; offset < buf.length; offset += this.audioChunkBytes) {
      const slice = buf.subarray(offset, Math.min(offset + this.audioChunkBytes, buf.length));
      this.audioHandler?.({ dataB64: slice.toString('base64'), mimeType });
    }
  }

  /**
   * VTID-04550 — emit one sentence of a pipelined reply. The client queues
   * the segments back to back, so the busy gate must extend to the end of
   * the WHOLE queued playback, not just this segment: each segment starts
   * where the previous one ends (or now, if that has already passed), and
   * `busyUntilMs` covers the cumulative end plus the VTID-03986 margin.
   */
  private emitPipelinedAudio(audioB64: string): void {
    const buf = Buffer.from(audioB64, 'base64');
    const mimeType = `audio/pcm;rate=${POLLY_PCM_SAMPLE_RATE_HZ}`;
    const segmentMs = Math.round((buf.length / 2 / POLLY_PCM_SAMPLE_RATE_HZ) * 1000);
    const startMs = Math.max(Date.now(), this.pipelinePlaybackEndMs);
    this.pipelinePlaybackEndMs = startMs + segmentMs;
    this.busyUntilMs = this.pipelinePlaybackEndMs + PLAYBACK_MARGIN_MS;
    for (let offset = 0; offset < buf.length; offset += this.audioChunkBytes) {
      const slice = buf.subarray(offset, Math.min(offset + this.audioChunkBytes, buf.length));
      this.audioHandler?.({ dataB64: slice.toString('base64'), mimeType });
    }
  }

  onAudioOutput(handler: (e: AudioOutputEvent) => void): void {
    this.audioHandler = handler;
  }
  onTranscript(handler: (e: TranscriptEvent) => void): void {
    this.transcriptHandler = handler;
  }
  onToolCall(handler: (e: ToolCallEvent) => void): void {
    // VTID-04336: fired only for the allowlisted hand-off tools — see header.
    this.toolCallHandler = handler;
  }
  onTurnComplete(handler: (e: TurnCompleteEvent) => void): void {
    this.turnCompleteHandler = handler;
  }
  onInterrupted(handler: (e: InterruptedEvent) => void): void {
    this.interruptedHandler = handler;
  }
  onError(handler: (e: UpstreamErrorEvent) => void): void {
    this.errorHandler = handler;
  }
  onClose(handler: (e: UpstreamCloseEvent) => void): void {
    this.closeHandler = handler;
  }

  async close(reason?: string): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    this.clearSilenceTimer();
    this.queuedOpener = null;
    // VTID-04336: never leave a turn waiting on a tool result that can no
    // longer arrive.
    for (const [id, resolve] of this.pendingToolResults) {
      this.pendingToolResults.delete(id);
      resolve({ result: 'voice session closed', isError: true });
    }
    await this.transcribe?.stop();
    this.transcribe = null;
    this.state = 'closed';
    this.closeHandler?.({ reason, initiatedLocally: true });
  }

  getState(): UpstreamConnectionState {
    return this.state;
  }
}
