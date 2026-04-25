/**
 * Voice Session Analyzer (VTID-01958)
 *
 * Extracted from routes/voice-lab.ts (the existing diagnostics endpoint at
 * /api/v1/voice-lab/live/sessions/:sessionId/diagnostics) so the same stall-
 * detection and flow-analysis logic can run server-side outside the HTTP
 * route — specifically, the Voice Session Classifier consumes it during
 * autonomous self-healing dispatch.
 *
 * Behavior is identical to the inline logic the route used previously
 * (queries `orb.live.diag` events for the given session, walks the flow
 * stages, classifies stalls). One additional output: aggregate
 * audio_in_chunks and audio_out_chunks (max across the session's diag
 * events) so the classifier can detect "audio one way" without re-fetching.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

export interface DiagEvent {
  stage?: string;
  ts?: number;
  created_at?: string;
  active?: boolean;
  turn_count?: number;
  audio_in?: number;
  audio_out?: number;
  is_model_speaking?: boolean;
  greeting_sent?: boolean;
  consecutive_model_turns?: number;
  has_upstream_ws?: boolean;
  upstream_ws_state?: string;
  has_sse?: boolean;
  has_watchdog?: boolean;
  reason?: string;
  error?: string;
  code?: string;
  tool_name?: string;
}

export interface SessionAnalysis {
  total_events: number;
  stages_seen: string[];
  last_stage: string | null;
  stall_detected: boolean;
  stall_type: string | null;
  stall_description: string | null;
  flow: {
    greeting_sent: boolean;
    model_start_speaking: boolean;
    turn_complete: boolean;
    input_transcription: boolean;
    watchdog_fired: boolean;
    upstream_ws_error: boolean;
    upstream_ws_close: boolean;
  };
  suspicious_gaps: Array<{ from: string; to: string; gap_ms: number }>;
  audio_in_chunks: number;
  audio_out_chunks: number;
}

export interface SessionAnalysisResult {
  diagnostics: DiagEvent[];
  analysis: SessionAnalysis;
}

export async function analyzeSessionEvents(
  sessionId: string,
): Promise<SessionAnalysisResult> {
  const empty: SessionAnalysisResult = {
    diagnostics: [],
    analysis: {
      total_events: 0,
      stages_seen: [],
      last_stage: null,
      stall_detected: false,
      stall_type: null,
      stall_description: null,
      flow: {
        greeting_sent: false,
        model_start_speaking: false,
        turn_complete: false,
        input_transcription: false,
        watchdog_fired: false,
        upstream_ws_error: false,
        upstream_ws_close: false,
      },
      suspicious_gaps: [],
      audio_in_chunks: 0,
      audio_out_chunks: 0,
    },
  };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return empty;

  const query =
    `${SUPABASE_URL}/rest/v1/oasis_events?` +
    `topic=eq.orb.live.diag&` +
    `metadata->>session_id=eq.${sessionId}&` +
    `order=created_at.asc&` +
    `limit=200`;

  const resp = await fetch(query, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) return empty;

  const events = (await resp.json()) as Array<{
    metadata?: Record<string, unknown>;
    created_at?: string;
  }>;

  const diagnostics: DiagEvent[] = events.map((e) => {
    const m = (e.metadata || {}) as Record<string, unknown>;
    return {
      stage: m.stage as string | undefined,
      ts: m.ts as number | undefined,
      created_at: e.created_at,
      active: m.active as boolean | undefined,
      turn_count: m.turn_count as number | undefined,
      audio_in: m.audio_in as number | undefined,
      audio_out: m.audio_out as number | undefined,
      is_model_speaking: m.is_model_speaking as boolean | undefined,
      greeting_sent: m.greeting_sent as boolean | undefined,
      consecutive_model_turns: m.consecutive_model_turns as number | undefined,
      has_upstream_ws: m.has_upstream_ws as boolean | undefined,
      upstream_ws_state: m.upstream_ws_state as string | undefined,
      has_sse: m.has_sse as boolean | undefined,
      has_watchdog: m.has_watchdog as boolean | undefined,
      reason: m.reason as string | undefined,
      error: m.error as string | undefined,
      code: m.code as string | undefined,
      tool_name: m.tool_name as string | undefined,
    };
  });

  const stagesSeen = diagnostics.map((d) => d.stage).filter((s): s is string => Boolean(s));
  const uniqueStages = [...new Set(stagesSeen)];
  const lastStage = stagesSeen.length > 0 ? stagesSeen[stagesSeen.length - 1] : null;

  const hasGreeting = stagesSeen.includes('greeting_sent');
  const hasModelStart = stagesSeen.includes('model_start_speaking');
  const hasTurnComplete = stagesSeen.includes('turn_complete');
  const hasInput = stagesSeen.includes('input_transcription');
  const hasWatchdogFired = stagesSeen.includes('watchdog_fired');
  const hasWsError = stagesSeen.includes('upstream_ws_error');
  const hasWsClose = stagesSeen.includes('upstream_ws_close');

  let stallType: string | null = null;
  let stallDescription: string | null = null;

  if (hasWatchdogFired) {
    stallType = 'watchdog_timeout';
    stallDescription = 'Watchdog fired — model stopped responding mid-stream';
  } else if (hasWsError || hasWsClose) {
    if (!hasTurnComplete && hasModelStart) {
      stallType = 'upstream_disconnect_mid_response';
      stallDescription = 'Upstream WS dropped while model was speaking';
    } else if (!hasModelStart && hasGreeting) {
      stallType = 'upstream_disconnect_before_response';
      stallDescription = 'Upstream WS dropped before model started speaking';
    } else {
      stallType = 'upstream_disconnect';
      stallDescription = 'Upstream WebSocket disconnected';
    }
  } else if (hasGreeting && hasModelStart && !hasTurnComplete) {
    stallType = 'mid_stream_stall';
    stallDescription = 'Model started speaking but never sent turn_complete — audio froze mid-stream';
  } else if (hasGreeting && !hasModelStart) {
    stallType = 'no_model_response';
    stallDescription = 'Greeting sent but model never started speaking';
  }

  const gaps: Array<{ from: string; to: string; gap_ms: number }> = [];
  for (let i = 1; i < diagnostics.length; i++) {
    const prev = diagnostics[i - 1];
    const curr = diagnostics[i];
    if (prev.ts != null && curr.ts != null) {
      const gapMs = curr.ts - prev.ts;
      if (gapMs > 5000) {
        gaps.push({ from: prev.stage || '?', to: curr.stage || '?', gap_ms: gapMs });
      }
    }
  }

  let audioInMax = 0;
  let audioOutMax = 0;
  for (const d of diagnostics) {
    if (typeof d.audio_in === 'number' && d.audio_in > audioInMax) audioInMax = d.audio_in;
    if (typeof d.audio_out === 'number' && d.audio_out > audioOutMax) audioOutMax = d.audio_out;
  }

  return {
    diagnostics,
    analysis: {
      total_events: diagnostics.length,
      stages_seen: uniqueStages,
      last_stage: lastStage,
      stall_detected: stallType !== null,
      stall_type: stallType,
      stall_description: stallDescription,
      flow: {
        greeting_sent: hasGreeting,
        model_start_speaking: hasModelStart,
        turn_complete: hasTurnComplete,
        input_transcription: hasInput,
        watchdog_fired: hasWatchdogFired,
        upstream_ws_error: hasWsError,
        upstream_ws_close: hasWsClose,
      },
      suspicious_gaps: gaps,
      audio_in_chunks: audioInMax,
      audio_out_chunks: audioOutMax,
    },
  };
}
