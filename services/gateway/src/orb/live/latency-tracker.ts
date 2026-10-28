/**
 * Voice/chat latency tracker — Phase 1 W1 (VTID-03177 PROFILE).
 *
 * One tracker per logical "turn" (chat request OR voice user-turn). Callers
 * mark phase boundaries; on `.finalize()` the tracker emits a single
 * `voice.latency.measured` OASIS event with the full timeline.
 *
 * Phase ids are canonical so dashboards can chart them:
 *   - audio_in_first_byte    — first audio chunk received from client
 *   - transcript_ready       — STT result available
 *   - tool_dispatch          — tool execution started
 *   - tool_response          — tool execution finished
 *   - audio_out_first_chunk  — first TTS chunk sent back to client
 *
 * For text turns (`/orb/chat`), only `text_request_in` and
 * `text_response_out` are recorded — the other 5 are voice-only.
 *
 * Gated by `FEATURE_LATENCY_TELEMETRY_ENV`. When off, every method is a
 * no-op and `finalize()` does NOT emit. Cheap enough to leave wired in.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { emitOasisEvent } from '../../services/oasis-event-service';
import { isFeatureLive } from '../../services/feature-flags';

const FEATURE_NAME = 'LATENCY_TELEMETRY';

export type LatencyPhase =
  | 'text_request_in'
  | 'text_response_out'
  | 'audio_in_first_byte'
  | 'transcript_ready'
  | 'tool_dispatch'
  | 'tool_response'
  | 'audio_out_first_chunk'
  // ORB-CONVERSATION-LATENCY: session-establishment (turn 0) phases — the
  // click-to-first-greeting-audio critical path. Recorded on a dedicated
  // establish tracker (separate from the per-turn tracker) so
  // time_to_first_audio_ms and its breakdown are measurable per session.
  | 'upstream_connected'
  | 'context_awaited'
  | 'setup_sent'
  // `greeting_sent` means "greeting pipeline ENTERED" — it is marked by the
  // route just before sendGreetingPromptToLiveAPI() is called, i.e. BEFORE
  // that function's own bounded waits (greeting facts ≤700 ms + ≤1500 ms,
  // new-day gather ≤3000 ms, resume gather ≤1800 ms, ledger ≤800 ms). The
  // name is kept because dashboards chart it. VTID-04542 adds
  // `greeting_dispatched` for the moment the prompt is really handed to the
  // upstream, so greeting_sent → greeting_dispatched is our own wait and
  // greeting_dispatched → audio_out_first_chunk is the model's.
  | 'greeting_sent'
  // VTID-04542 — the greeting prompt handed to the upstream (the real
  // ws.send / sendTextTurn). detail: { wake_opener, directive_chars, path }.
  | 'greeting_dispatched'
  // VTID-04542 — the bounded waits inside sendGreetingPromptToLiveAPI.
  // detail: { ms, timed_out } (+ kind:'newday'|'resume' on the gather).
  | 'greeting_facts_awaited'
  | 'greeting_gather_awaited'
  | 'greeting_ledger_awaited'
  // VTID-03764 — bisects the multi-second gap between greeting_sent and
  // audio_out_first_chunk. Nova-only diagnostic (see
  // NovaSonicLiveClientDeps.onFirstRawChunk/onEarlyNormalizedEvent).
  // `nova_early_event` fires multiple times (once per early Nova event, see
  // EARLY_EVENT_CAP) — a real timeline, not a single snapshot. A one-shot
  // "first normalized event" was tried first and found useless: real staging
  // measurement showed it fires on a connection-handshake `usage` event that
  // arrives BEFORE the greeting prompt is even sent.
  | 'nova_first_raw_chunk'
  | 'nova_early_event';

export interface LatencyMark {
  phase: LatencyPhase;
  /** Wall-clock epoch ms when the mark was recorded. */
  at_ms: number;
  /** Optional context (tool name, transcript length, etc.). */
  detail?: Record<string, unknown>;
}

export interface LatencyContext {
  /** Caller-stable id (orb_session_id, conversation_id, or chat req id). */
  session_id: string;
  /** 'voice' | 'text' — drives which phases are expected. */
  surface: 'voice' | 'text';
  /** Optional user id. */
  actor_id?: string;
  /** Optional turn index within the session (1-based). */
  turn?: number;
  /** Optional provider/model hint (e.g. 'vertex/gemini-2.5-flash'). */
  provider?: string;
  /**
   * Client transport carrying the session ('sse' = HTTP POST up + SSE down,
   * 'websocket' = the Phase 3a WS path). Lets dashboards split WS vs SSE
   * timelines for the same phase set.
   */
  transport?: 'sse' | 'websocket';
}

/**
 * VTID-04542 — wall-clock timing of POST /live/session/start
 * (handleLiveSessionStart), which runs BEFORE the turn-0 tracker exists.
 * Both transports go through that handler (the WS `start` frame is replayed
 * into it by ws-start-adapter.ts), so the block is recorded once on the
 * session and attached to the turn-0 tracker when it is created.
 *
 * Representation on `voice.latency.measured` (turn 0 only): a separate
 * `session_start` object rather than negative phase offsets, so the
 * existing `phases` array keeps its meaning (offsets ≥ 0 from tracker
 * start):
 *
 *   session_start: {
 *     total_ms,                 // handler entry → response written
 *     tracker_start_offset_ms,  // handler entry → turn-0 tracker created
 *     steps: [{ step, offset_ms, ms }],  // offset_ms from handler entry
 *   }
 *
 * `tracker_start_offset_ms - total_ms` is the gap between the start
 * response and the stream/upstream open (client round trip, SSE GET).
 */
export interface SessionStartStep {
  step: string;
  /** ms from handler entry to the start of this step. */
  offset_ms: number;
  /** Duration of the step. */
  ms: number;
}

export interface SessionStartTiming {
  /** Wall-clock epoch ms at handler entry. */
  started_at_ms: number;
  total_ms: number;
  steps: SessionStartStep[];
}

export class LatencyTracker {
  private readonly start_ms: number;
  private readonly marks: LatencyMark[] = [];
  private readonly enabled: boolean;
  private finalized = false;
  // VTID-04542: extra top-level payload fields (entry, surface, rung, …).
  private meta: Record<string, unknown> = {};
  private sessionStart: SessionStartTiming | null = null;

  constructor(private readonly ctx: LatencyContext) {
    this.enabled = isFeatureLive(FEATURE_NAME);
    this.start_ms = Date.now();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Correct the provider hint after construction. Upstream provider
   * selection (Vertex vs Nova vs LiveKit) can resolve AFTER the tracker is
   * created — e.g. the turn-0 establishment tracker is constructed before
   * `connectToLiveAPI` picks an upstream — so the constructor's `provider`
   * is a best-guess default, not a fact. Call this once the real provider
   * is known, before `finalize()`.
   */
  setProvider(provider: string): void {
    this.ctx.provider = provider;
  }

  mark(phase: LatencyPhase, detail?: Record<string, unknown>): void {
    if (!this.enabled || this.finalized) return;
    this.marks.push({ phase, at_ms: Date.now(), detail });
  }

  /**
   * VTID-04542: merge extra fields into the emitted payload (top level).
   * Core fields (session_id, phases, total_ms, …) always win on a clash.
   * No-op when disabled or already finalized.
   */
  setMeta(meta: Record<string, unknown>): void {
    if (!this.enabled || this.finalized) return;
    this.meta = { ...this.meta, ...meta };
  }

  /** VTID-04542: attach the session-start block (see SessionStartTiming). */
  setSessionStart(timing: SessionStartTiming | null | undefined): void {
    if (!this.enabled || this.finalized || !timing) return;
    this.sessionStart = timing;
  }

  async finalize(status: 'success' | 'error' = 'success', error?: string): Promise<void> {
    if (!this.enabled || this.finalized) return;
    this.finalized = true;
    const end_ms = Date.now();
    const total_ms = end_ms - this.start_ms;

    // Deltas from start, in mark order. Cheaper to compute once here than at
    // dashboard read time.
    const phases = this.marks.map((m) => ({
      phase: m.phase,
      offset_ms: m.at_ms - this.start_ms,
      detail: m.detail,
    }));

    try {
      await emitOasisEvent({
        vtid: 'VTID-03177',
        type: 'voice.latency.measured',
        source: 'gateway/latency-tracker',
        status,
        message: status === 'success'
          ? `latency ${total_ms}ms (${this.ctx.surface}/${phases.length} phases)`
          : `latency ${total_ms}ms (${this.ctx.surface}, errored)`,
        actor_id: this.ctx.actor_id,
        payload: {
          ...this.meta,
          ...(this.sessionStart
            ? {
                session_start: {
                  total_ms: this.sessionStart.total_ms,
                  tracker_start_offset_ms: this.start_ms - this.sessionStart.started_at_ms,
                  steps: this.sessionStart.steps,
                },
              }
            : {}),
          session_id: this.ctx.session_id,
          surface: this.ctx.surface,
          turn: this.ctx.turn,
          provider: this.ctx.provider,
          transport: this.ctx.transport,
          total_ms,
          phases,
          error,
        },
      });
    } catch {
      // Never let telemetry break a request.
    }
  }
}

declare module 'express-serve-static-core' {
  interface Locals {
    latencyTracker?: LatencyTracker;
  }
}

/**
 * Express middleware factory — attaches a LatencyTracker to res.locals and
 * finalizes it when the response ends. Use on routes where the request →
 * response boundary is the right turn boundary (i.e. `/orb/chat`, not the
 * voice WebSocket which spans many turns).
 *
 * The tracker still no-ops at zero cost when FEATURE_LATENCY_TELEMETRY_ENV
 * is off.
 */
export function withLatencyTracker(surface: 'voice' | 'text'): RequestHandler {
  return function latencyTrackerMiddleware(req: Request, res: Response, next: NextFunction) {
    const tracker = new LatencyTracker({
      session_id: (req.body?.orb_session_id as string)
        || (req.body?.conversation_id as string)
        || (req.headers['x-request-id'] as string)
        || 'unknown',
      surface,
    });
    if (tracker.isEnabled()) {
      tracker.mark(surface === 'text' ? 'text_request_in' : 'audio_in_first_byte');
    }
    res.locals.latencyTracker = tracker;

    const originalEnd = res.end.bind(res);
    res.end = function patchedEnd(this: Response, ...args: unknown[]) {
      try {
        const t = res.locals.latencyTracker;
        if (t?.isEnabled()) {
          t.mark(surface === 'text' ? 'text_response_out' : 'audio_out_first_chunk');
          // fire-and-forget; never block response close on the OASIS write
          void t.finalize(res.statusCode >= 400 ? 'error' : 'success');
        }
      } catch {
        // Never let telemetry break a response.
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalEnd(...(args as [any, any?, any?]));
    };

    next();
  };
}
