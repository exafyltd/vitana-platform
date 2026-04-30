/**
 * Voice Failure Taxonomy (VTID-01958)
 *
 * The contract between OASIS event observation and the autonomous self-healing
 * dispatch pipeline. Each failure class has a stable normalized_signature
 * (pattern ID, never raw error_message text) so dedupe and Spec Memory Gate
 * keys are consistent across gateway revisions and tenant scopes.
 *
 * SIGNATURE_VERSION is part of the dedupe contract — bump it when revising
 * pattern IDs, which implicitly invalidates spec_memory entries from the prior
 * version (gateway_revision is part of the dedupe key).
 *
 * See plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

// Bumped to v2 (VTID-01994) — added 3 quality classes derived from
// session-stop metadata (no error events required). Bumping invalidates
// prior spec_memory entries which is the safe transition.
export const SIGNATURE_VERSION = 'v2';

export const VOICE_FAILURE_CLASSES = [
  'voice.config_missing',
  'voice.config_fallback_active',
  'voice.auth_rejected',
  'voice.model_stall',
  'voice.upstream_disconnect',
  'voice.tts_failed',
  'voice.session_leak',
  'voice.tool_loop',
  'voice.audio_one_way',
  'voice.permission_denied',
  // VTID-01994: quality failures detectable from session-stop metadata
  // alone, without any error event. Catches the dominant production
  // failure mode (model under-responds, terse replies, no engagement)
  // that the explicit-error-event classifier misses entirely.
  'voice.model_under_responds',
  'voice.no_engagement',
  'voice.low_turn_progression',
  'voice.unknown',
] as const;

export type VoiceFailureClass = (typeof VOICE_FAILURE_CLASSES)[number];

/**
 * The hardcoded fallback project_id at orb-live.ts:1029. When the active
 * project_id equals this value, sessions silently appear healthy even though
 * the env is misconfigured — we classify as `voice.config_fallback_active` so
 * the loop fixes the env regardless.
 */
export const CONFIG_FALLBACK_PROJECT_ID = 'lovable-vitana-vers1';

export interface ClassifierInput {
  topic?: string;
  status?: 'info' | 'warning' | 'error' | string;
  reason?: string;
  error_message?: string;
  http_status?: number;
  grpc_code?: string;
  metadata?: Record<string, unknown>;
}

export interface ClassifierOutput {
  class: VoiceFailureClass;
  normalized_signature: string;
}

/**
 * Severity ranking used by the classifier when multiple events for one
 * session map to different classes — pick the highest-severity class as
 * the dominant failure for dispatch.
 */
export const CLASS_SEVERITY: Record<VoiceFailureClass, number> = {
  'voice.config_missing': 100,
  'voice.permission_denied': 95,
  'voice.auth_rejected': 90,
  'voice.config_fallback_active': 85,
  'voice.tts_failed': 70,
  'voice.upstream_disconnect': 60,
  'voice.model_stall': 50,
  'voice.session_leak': 40,
  'voice.tool_loop': 30,
  'voice.audio_one_way': 20,
  // VTID-01994: quality classes — between unknown and tool_loop. They're
  // dispatch-worthy but rank below explicit-error classes because explicit
  // errors usually have a known fix; quality classes generally route to
  // the Architecture Investigator for prompt/model-config-level analysis.
  'voice.model_under_responds': 25,
  'voice.no_engagement': 22,
  'voice.low_turn_progression': 18,
  'voice.unknown': 0,
};

function lowerSafe(s: string | undefined): string {
  return (s || '').toLowerCase();
}

/**
 * Map a single OASIS event (or equivalent observation) to a (class, signature) pair.
 * Pattern IDs are extracted from structured fields (gRPC code, HTTP status,
 * reason) before falling back to substring matches on error_message.
 */
export function mapTopicToClass(input: ClassifierInput): ClassifierOutput {
  const topic = input.topic || '';
  const reason = input.reason || '';
  const msg = lowerSafe(input.error_message);
  const grpc = (input.grpc_code || '').toUpperCase();
  const http = input.http_status;
  const md = input.metadata || {};

  // Config: separate "fallback active" from "truly missing"
  if (topic === 'orb.live.startup.config_missing' || topic === 'orb.live.config_missing') {
    const usingFallback = md.using_fallback === true || md.config_fallback_active === true;
    const fallbackInMsg = msg.includes('fallback') || msg.includes(CONFIG_FALLBACK_PROJECT_ID);
    if (usingFallback || fallbackInMsg) {
      return { class: 'voice.config_fallback_active', normalized_signature: 'vertex_fallback_active' };
    }
    if (msg.includes('vertex_project') || msg.includes('project_id')) {
      return { class: 'voice.config_missing', normalized_signature: 'vertex_project_id_empty' };
    }
    if (msg.includes('vertex_location') || msg.includes('location')) {
      return { class: 'voice.config_missing', normalized_signature: 'vertex_location_empty' };
    }
    if (msg.includes('google_auth') || msg.includes('credentials') || msg.includes('adc')) {
      return { class: 'voice.config_missing', normalized_signature: 'google_auth_unready' };
    }
    return { class: 'voice.config_missing', normalized_signature: 'config_missing_generic' };
  }

  // Connection / auth / permission
  if (topic === 'orb.live.connection_failed') {
    if (grpc === 'PERMISSION_DENIED' || http === 403 || msg.includes('permission denied') || msg.includes('forbidden')) {
      return { class: 'voice.permission_denied', normalized_signature: 'permission_denied_vertex' };
    }
    if (grpc === 'UNAUTHENTICATED' || http === 401 || msg.includes('unauthenticated') || msg.includes('unauthorized')) {
      return { class: 'voice.auth_rejected', normalized_signature: 'auth_unauthenticated' };
    }
    if (msg.includes('jwt') || msg.includes('token expired') || msg.includes('expired token')) {
      return { class: 'voice.auth_rejected', normalized_signature: 'auth_jwt_expired' };
    }
    if (msg.includes('service account') || msg.includes('service_account') || msg.includes('invalid_grant')) {
      return { class: 'voice.auth_rejected', normalized_signature: 'auth_service_account_invalid' };
    }
    return { class: 'voice.unknown', normalized_signature: 'connection_failed_generic' };
  }

  // Model stall (stall_detected event has reason in metadata)
  if (topic === 'orb.live.stall_detected') {
    if (reason === 'audio_stall') {
      return { class: 'voice.model_stall', normalized_signature: 'model_stall_audio' };
    }
    if (reason === 'text_stall') {
      return { class: 'voice.model_stall', normalized_signature: 'model_stall_text' };
    }
    if (reason === 'forwarding_no_ack') {
      return { class: 'voice.model_stall', normalized_signature: 'model_stall_forwarding_no_ack' };
    }
    return { class: 'voice.model_stall', normalized_signature: 'model_stall_generic' };
  }

  // TTS — fallback_error means synthesis failed; fallback_used means TTS init/path issue
  if (topic === 'orb.live.fallback_error') {
    return { class: 'voice.tts_failed', normalized_signature: 'tts_synth_failed' };
  }
  if (topic === 'orb.live.fallback_used') {
    return { class: 'voice.tts_failed', normalized_signature: 'tts_init_failed' };
  }

  // Tool loop guard
  if (topic === 'orb.live.tool_loop_guard_activated') {
    return { class: 'voice.tool_loop', normalized_signature: 'tool_loop_8plus' };
  }

  return { class: 'voice.unknown', normalized_signature: 'unknown' };
}

/**
 * Map a stall_type from voice-session-analyzer output to taxonomy. Returns null
 * when the input is null/empty so callers can treat "no stall" cleanly.
 */
export function mapStallTypeToClass(stallType: string | null | undefined): ClassifierOutput | null {
  if (!stallType) return null;

  switch (stallType) {
    case 'watchdog_timeout':
      return { class: 'voice.model_stall', normalized_signature: 'model_stall_watchdog' };
    case 'upstream_disconnect_mid_response':
      return { class: 'voice.upstream_disconnect', normalized_signature: 'upstream_disconnect_mid_response' };
    case 'upstream_disconnect_before_response':
      return { class: 'voice.upstream_disconnect', normalized_signature: 'upstream_disconnect_before_response' };
    case 'upstream_disconnect':
      return { class: 'voice.upstream_disconnect', normalized_signature: 'upstream_disconnect_unknown' };
    case 'mid_stream_stall':
      return { class: 'voice.model_stall', normalized_signature: 'mid_stream_stall' };
    case 'no_model_response':
      return { class: 'voice.model_stall', normalized_signature: 'no_model_response' };
    default:
      return null;
  }
}

/**
 * Detect "audio one way" — input chunks present, model produced no output,
 * and there was no recognized stall (so it's not just a frozen pipeline).
 * Used by the classifier as a residual check after topic+stall mapping.
 */
export function detectAudioOneWay(input: {
  audio_in_chunks: number;
  audio_out_chunks: number;
  stall_type: string | null;
}): ClassifierOutput | null {
  if (input.stall_type) return null;
  if (input.audio_in_chunks > 0 && input.audio_out_chunks === 0) {
    return { class: 'voice.audio_one_way', normalized_signature: 'audio_one_way_post_chime' };
  }
  return null;
}

// =============================================================================
// VTID-01994: Quality classifier — detects failures from session-stop metrics
// alone, no error events required. Catches the dominant production failure
// mode the explicit-error-event classifier misses: sessions that complete
// "successfully" (reason=normal, ws closed cleanly) but the user clearly had
// a broken experience (model under-responds, terse replies, never engaged).
// =============================================================================

export interface SessionStopMetrics {
  audio_in_chunks: number;
  audio_out_chunks: number;
  duration_ms: number;
  turn_count: number;
  user_turns?: number;
  model_turns?: number;
}

/** Bucket a numeric value to keep signatures stable across small variations. */
function bucketRatio(ratio: number): string {
  if (ratio >= 100) return 'r100plus';
  if (ratio >= 20) return 'r20to100';
  if (ratio >= 10) return 'r10to20';
  if (ratio >= 5) return 'r5to10';
  return 'rUnder5';
}

/**
 * Classify a session as a quality failure based on session-stop metadata.
 * Returns null when session looks healthy. Pure function — no I/O, no
 * dependencies. Adapter passes the metrics straight from the
 * vtid.live.session.stop emit payload.
 *
 * Thresholds:
 *   voice.no_engagement         turn_count==0 AND duration_ms>30s AND audio_in>=20
 *                               (user spoke but model never started speaking)
 *   voice.model_under_responds  audio_in>=100 AND audio_out/audio_in<0.15 AND turn_count>=1
 *                               (real conversation but model under-responded)
 *   voice.low_turn_progression  duration_ms>60s AND turn_count<3 AND audio_in>=50
 *                               (long session that never developed)
 */
export function classifyQualityFromSessionStop(
  metrics: SessionStopMetrics,
): ClassifierOutput | null {
  const ai = metrics.audio_in_chunks || 0;
  const ao = metrics.audio_out_chunks || 0;
  const dur = metrics.duration_ms || 0;
  const turns = metrics.turn_count || 0;

  // Skip sessions that are too short or had no real input — they're not
  // meaningfully broken, just not real conversations (mic permission test,
  // page abandoned, etc.).
  if (ai < 20 && turns < 1) return null;

  // 1. No engagement: user spoke but model never started a turn.
  if (turns === 0 && dur > 30_000 && ai >= 20) {
    return {
      class: 'voice.no_engagement',
      normalized_signature: ai >= 100 ? 'no_engagement_user_active' : 'no_engagement_brief',
    };
  }

  // 2. Model under-responds: real turn cycle but model produced very little.
  if (turns >= 1 && ai >= 100) {
    const ratio = ao > 0 ? ai / ao : ai;
    if (ratio >= 5) {
      return {
        class: 'voice.model_under_responds',
        normalized_signature: `model_under_responds_${bucketRatio(ratio)}`,
      };
    }
  }

  // 3. Low turn progression: long session, few turns. Conversation didn't
  // develop. Catches "user struggling to engage" patterns the others miss.
  if (dur > 60_000 && turns < 3 && ai >= 50) {
    return {
      class: 'voice.low_turn_progression',
      normalized_signature: turns === 0 ? 'low_turn_zero' : 'low_turn_one_or_two',
    };
  }

  return null;
}
