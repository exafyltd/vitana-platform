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
  | 'greeting_sent';

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
}

export class LatencyTracker {
  private readonly start_ms: number;
  private readonly marks: LatencyMark[] = [];
  private readonly enabled: boolean;
  private finalized = false;

  constructor(private readonly ctx: LatencyContext) {
    this.enabled = isFeatureLive(FEATURE_NAME);
    this.start_ms = Date.now();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  mark(phase: LatencyPhase, detail?: Record<string, unknown>): void {
    if (!this.enabled || this.finalized) return;
    this.marks.push({ phase, at_ms: Date.now(), detail });
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
          session_id: this.ctx.session_id,
          surface: this.ctx.surface,
          turn: this.ctx.turn,
          provider: this.ctx.provider,
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
