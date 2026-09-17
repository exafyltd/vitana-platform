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
import { evaluateCascadeEligibility } from './cascaded-config';
import { synthesizePolly, resolvePollyVoice } from '../../../services/tts/polly';
import { synthesizeFish } from '../../../services/tts/fish';
import { callViaRouter } from '../../../services/llm-router';

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

export class CascadedLiveClient implements UpstreamLiveClient {
  private state: UpstreamConnectionState = 'idle';
  private readonly lang: string;
  private readonly audioChunkBytes: number;

  private transcribe: TranscribeStreamSession | null = null;
  private systemInstruction = '';

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
   * Tools are not wired on this path — see the header. Returns `false`
   * rather than throwing, and is unreachable in practice because
   * `onToolCall` never fires.
   */
  sendToolResult(_result: UpstreamToolResult): boolean {
    return false;
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
      const completion = await callViaRouter('operator', userText, {
        service: 'orb-cascaded-voice',
        systemPrompt: this.systemInstruction,
        maxTokens: 400,
      });

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
        const retry = await callViaRouter('operator', userText, {
          service: 'orb-cascaded-voice',
          systemPrompt: this.systemInstruction,
          maxTokens: 400,
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

      let speech: { audioB64: string } | null = await synthesizePolly({
        text: replyText,
        lang: this.lang,
        format: 'pcm',
      });

      // VTID-03970: a language with NO Polly voice at all (sr) can still
      // have reached here — eligibility (`cascaded-config.ts`) admits it
      // only when Fish is explicitly enabled and has a curated voice for
      // it. Gated the same way here rather than trusting eligibility was
      // computed with the identical env state moments earlier.
      if (!speech?.audioB64 && !resolvePollyVoice(this.lang)) {
        speech = await synthesizeFish({ text: replyText, lang: this.lang, format: 'pcm' });
      }

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

  onAudioOutput(handler: (e: AudioOutputEvent) => void): void {
    this.audioHandler = handler;
  }
  onTranscript(handler: (e: TranscriptEvent) => void): void {
    this.transcriptHandler = handler;
  }
  onToolCall(_handler: (e: ToolCallEvent) => void): void {
    // Accepted and never fired — see the header's tools note.
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
    await this.transcribe?.stop();
    this.transcribe = null;
    this.state = 'closed';
    this.closeHandler?.({ reason, initiatedLocally: true });
  }

  getState(): UpstreamConnectionState {
    return this.state;
  }
}
