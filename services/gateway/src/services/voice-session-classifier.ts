/**
 * Voice Session Classifier (VTID-01958)
 *
 * Classifies a voice session's failure into the taxonomy from
 * voice-failure-taxonomy.ts. Combines two signals:
 *
 *   1. Topic-based mapping over OASIS error/warning events for the session
 *      (config_missing, connection_failed, stall_detected, fallback_error, etc.)
 *   2. Flow-based stall detection from the existing voice-session-analyzer
 *      (the same logic Voice Lab UI shows in the diagnostics endpoint).
 *
 * When multiple events map to different classes the highest-severity class
 * wins (CLASS_SEVERITY in voice-failure-taxonomy.ts).
 *
 * Behind `system_config.voice_self_healing_mode` — callers must check the
 * mode flag before acting on the result. This module itself is read-only
 * and never dispatches anything.
 */

import { analyzeSessionEvents } from './voice-session-analyzer';
import {
  mapTopicToClass,
  mapStallTypeToClass,
  detectAudioOneWay,
  CLASS_SEVERITY,
  VoiceFailureClass,
  ClassifierInput,
} from './voice-failure-taxonomy';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const VOICE_ERROR_TOPICS = [
  'orb.live.startup.config_missing',
  'orb.live.config_missing',
  'orb.live.connection_failed',
  'orb.live.stall_detected',
  'orb.live.tool_loop_guard_activated',
  'orb.live.fallback_used',
  'orb.live.fallback_error',
];

export interface VoiceClassification {
  class: VoiceFailureClass;
  normalized_signature: string;
  severity: 'info' | 'warning' | 'error';
  evidence: {
    session_id: string;
    triggering_topic?: string;
    triggering_event_id?: string;
    stall_type?: string | null;
    stall_description?: string | null;
    error_count: number;
    audio_in_chunks: number;
    audio_out_chunks: number;
  };
}

interface OasisEventRow {
  id?: string;
  topic?: string;
  status?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

async function fetchVoiceErrorEvents(sessionId: string): Promise<OasisEventRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];

  const topics = VOICE_ERROR_TOPICS.map((t) => `"${t}"`).join(',');
  const url =
    `${SUPABASE_URL}/rest/v1/oasis_events?` +
    `topic=in.(${topics})&` +
    `metadata->>session_id=eq.${sessionId}&` +
    `status=in.(error,warning)&` +
    `order=created_at.asc&` +
    `limit=100`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
  });

  if (!res.ok) return [];
  return (await res.json()) as OasisEventRow[];
}

function eventToInput(ev: OasisEventRow): ClassifierInput {
  const md = ev.metadata || {};
  return {
    topic: ev.topic,
    status: ev.status,
    reason: (md.reason as string | undefined) ?? undefined,
    error_message:
      (md.error_message as string | undefined) ??
      (md.error as string | undefined) ??
      ev.message,
    http_status: md.http_status as number | undefined,
    grpc_code: md.grpc_code as string | undefined,
    metadata: md,
  };
}

/**
 * Classify the dominant voice failure for a session. Always returns a result
 * (never throws on classifier-internal errors); a hard failure to read events
 * surfaces as `voice.unknown` with signature `classifier_no_events`.
 */
export async function classifyVoiceSession(sessionId: string): Promise<VoiceClassification> {
  let events: OasisEventRow[] = [];
  try {
    events = await fetchVoiceErrorEvents(sessionId);
  } catch {
    events = [];
  }

  let analysis: Awaited<ReturnType<typeof analyzeSessionEvents>>['analysis'] | null = null;
  try {
    const analyzed = await analyzeSessionEvents(sessionId);
    analysis = analyzed.analysis;
  } catch {
    analysis = null;
  }

  // Track the highest-severity class found across all signals.
  let best:
    | {
        class: VoiceFailureClass;
        normalized_signature: string;
        severity: number;
        topic?: string;
        eventId?: string;
      }
    | null = null;

  // 1. Topic-based mapping over each error/warning event.
  for (const ev of events) {
    const r = mapTopicToClass(eventToInput(ev));
    const sev = CLASS_SEVERITY[r.class] ?? 0;
    if (!best || sev > best.severity) {
      best = {
        class: r.class,
        normalized_signature: r.normalized_signature,
        severity: sev,
        topic: ev.topic,
        eventId: ev.id,
      };
    }
  }

  // 2. Stall-type mapping from the analyzer's flow analysis.
  if (analysis?.stall_type) {
    const stallResult = mapStallTypeToClass(analysis.stall_type);
    if (stallResult) {
      const sev = CLASS_SEVERITY[stallResult.class] ?? 0;
      if (!best || sev > best.severity) {
        best = {
          class: stallResult.class,
          normalized_signature: stallResult.normalized_signature,
          severity: sev,
        };
      }
    }
  }

  // 3. Audio-one-way detection (residual check, no stall AND no model output).
  if (analysis) {
    const oneWay = detectAudioOneWay({
      audio_in_chunks: analysis.audio_in_chunks,
      audio_out_chunks: analysis.audio_out_chunks,
      stall_type: analysis.stall_type,
    });
    if (oneWay) {
      const sev = CLASS_SEVERITY[oneWay.class] ?? 0;
      if (!best || sev > best.severity) {
        best = {
          class: oneWay.class,
          normalized_signature: oneWay.normalized_signature,
          severity: sev,
        };
      }
    }
  }

  const audioIn = analysis?.audio_in_chunks ?? 0;
  const audioOut = analysis?.audio_out_chunks ?? 0;

  if (!best) {
    return {
      class: events.length > 0 ? 'voice.unknown' : 'voice.unknown',
      normalized_signature: events.length > 0 ? 'unknown' : 'classifier_no_events',
      severity: events.length > 0 ? 'warning' : 'info',
      evidence: {
        session_id: sessionId,
        stall_type: analysis?.stall_type ?? null,
        stall_description: analysis?.stall_description ?? null,
        error_count: events.length,
        audio_in_chunks: audioIn,
        audio_out_chunks: audioOut,
      },
    };
  }

  return {
    class: best.class,
    normalized_signature: best.normalized_signature,
    severity: 'error',
    evidence: {
      session_id: sessionId,
      triggering_topic: best.topic,
      triggering_event_id: best.eventId,
      stall_type: analysis?.stall_type ?? null,
      stall_description: analysis?.stall_description ?? null,
      error_count: events.length,
      audio_in_chunks: audioIn,
      audio_out_chunks: audioOut,
    },
  };
}
