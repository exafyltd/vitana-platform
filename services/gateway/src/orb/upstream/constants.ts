/**
 * Voice-pipeline thresholds + protocol constants.
 *
 * Phase D.1 (VTID-03124) moved the tunable thresholds out of `export
 * const` literals and behind accessor functions that read from
 * `PolicyResolver`. The literal values that previously lived here are
 * kept as `*_FALLBACK` constants — they are the safety-net `defaultValue`
 * the accessor passes to `getValue`, so behaviour is byte-identical when
 * the resolver cache is cold (boot warm-up race) or when the
 * `decision_policy` row is missing.
 *
 * Connection-issue messages (8 languages) remain as a literal Record for
 * now — Phase D.2 migrates them to `policy_render_block`.
 *
 * The protocol-derived constants (`SILENCE_PCM_BYTES`,
 * `SILENCE_AUDIO_B64`) stay as literals because they encode the on-wire
 * sample-rate format (16 kHz mono 16-bit) — not a tuning knob.
 *
 * Original BOOTSTRAP-ORB-MOVE phase 2 move-only history:
 *   - VAD / end-of-speech detection
 *   - Post-turn mic cooldown (echo prevention)
 *   - Silence keepalive (anti-idle-timeout)
 *   - Response watchdog (stall detection)
 *   - Forwarding watchdog (zombie upstream detection)
 *   - Loop guard + tool guard (runaway prevention)
 *   - User-facing connection-issue messages
 */

import { getPolicyResolver } from '../../services/decision-contract/policy-resolver';
import { POLICY_KEYS } from '../../services/decision-contract/policy-keys';

// ---------------------------------------------------------------------------
// Safety-net fallback values. Match the Phase D.1 seed rows byte-for-byte.
// Used by the accessor functions below when the resolver cache is cold or
// when no row is seeded for the key. Production source of truth is the
// `decision_policy` table.
// ---------------------------------------------------------------------------

// VTID-RESPONSE-DELAY / VTID-03019: 1_200 → 850 ms trims ~350ms off
// end-of-turn latency vs the original Vertex VAD default of 100 ms (too
// aggressive — cut users off mid-thought).
const VAD_SILENCE_DURATION_MS_FALLBACK = 850;

// VTID-ECHO-COOLDOWN: gates mic for 2s after turn_complete so the
// client's draining playback queue doesn't leak into the upstream WS
// as new user speech (mobile AEC is weak; ghost-response repro under
// PR #743).
const POST_TURN_COOLDOWN_MS_FALLBACK = 2_000;

// VTID-STREAM-SILENCE: Vertex closes the stream after ~25-30s of no
// audio. A 250ms silence frame every 3s keeps it open during pauses.
const SILENCE_KEEPALIVE_INTERVAL_MS_FALLBACK = 3_000;
const SILENCE_IDLE_THRESHOLD_MS_FALLBACK = 3_000;

// VTID-WATCHDOG: stall detection windows. 8s greeting / 10s turn — short
// enough to recover from a true Vertex stall, long enough to tolerate a
// healthy 5-7s first-turn inference.
const GREETING_RESPONSE_TIMEOUT_MS_FALLBACK = 8_000;
const TURN_RESPONSE_TIMEOUT_MS_FALLBACK = 10_000;

// VTID-FORWARDING-WATCHDOG (latest = VTID-01984): 45s tolerance for
// genuine first-turn before any sign of life. With ~15K-char system
// instruction + 16 tools, Vertex's first-turn inference can take 8-12s;
// shorter windows fire inside the compute window and destroy the
// utterance. Once Vertex has shown ANY sign of life (transcription,
// start_speaking, audio chunk), the arm site skips this watchdog
// entirely — see the call site in live-session-controller.ts.
const FORWARDING_ACK_TIMEOUT_MS_FALLBACK = 45_000;

// VTID-LOOPGUARD: pause silence keepalive after 3 model turns without
// user speech so Vertex's idle timeout breaks the loop.
const MAX_CONSECUTIVE_MODEL_TURNS_FALLBACK = 3;

// VTID-TOOLGUARD: 5 consecutive tool calls without audio output → inject
// a synthetic function_response so the model answers from data gathered
// so far. See PR #743 for the non-destructive injection pattern.
const MAX_CONSECUTIVE_TOOL_CALLS_FALLBACK = 5;

// ---------------------------------------------------------------------------
// Accessor functions — call these instead of importing the old `const`.
// ---------------------------------------------------------------------------

export function getVadSilenceDurationMs(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_VAD_SILENCE_DURATION_MS,
    { defaultValue: VAD_SILENCE_DURATION_MS_FALLBACK },
  );
}

export function getPostTurnCooldownMs(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_POST_TURN_COOLDOWN_MS,
    { defaultValue: POST_TURN_COOLDOWN_MS_FALLBACK },
  );
}

export function getSilenceKeepaliveIntervalMs(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_SILENCE_KEEPALIVE_INTERVAL_MS,
    { defaultValue: SILENCE_KEEPALIVE_INTERVAL_MS_FALLBACK },
  );
}

export function getSilenceIdleThresholdMs(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_SILENCE_KEEPALIVE_IDLE_THRESHOLD_MS,
    { defaultValue: SILENCE_IDLE_THRESHOLD_MS_FALLBACK },
  );
}

export function getGreetingResponseTimeoutMs(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_WATCHDOG_GREETING_TIMEOUT_MS,
    { defaultValue: GREETING_RESPONSE_TIMEOUT_MS_FALLBACK },
  );
}

export function getTurnResponseTimeoutMs(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_WATCHDOG_TURN_RESPONSE_TIMEOUT_MS,
    { defaultValue: TURN_RESPONSE_TIMEOUT_MS_FALLBACK },
  );
}

export function getForwardingAckTimeoutMs(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_WATCHDOG_FORWARDING_ACK_TIMEOUT_MS,
    { defaultValue: FORWARDING_ACK_TIMEOUT_MS_FALLBACK },
  );
}

export function getMaxConsecutiveModelTurns(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_LOOP_GUARD_MAX_CONSECUTIVE_MODEL_TURNS,
    { defaultValue: MAX_CONSECUTIVE_MODEL_TURNS_FALLBACK },
  );
}

export function getMaxConsecutiveToolCalls(): number {
  return getPolicyResolver().getValue<number>(
    POLICY_KEYS.VOICE_LOOP_GUARD_MAX_CONSECUTIVE_TOOL_CALLS,
    { defaultValue: MAX_CONSECUTIVE_TOOL_CALLS_FALLBACK },
  );
}

// ---------------------------------------------------------------------------
// Protocol-derived constants (NOT tuning knobs — stay literal).
// ---------------------------------------------------------------------------
// 250ms at 16kHz mono 16-bit = 16000 * 0.25 * 2 = 8000 bytes. This encodes
// the on-wire audio format the upstream expects; changing it would mean
// a different frame size, not a different policy.
export const SILENCE_PCM_BYTES = 8_000;
export const SILENCE_AUDIO_B64 = Buffer.alloc(SILENCE_PCM_BYTES, 0).toString('base64');

// =============================================================================
// User-facing connection-issue messages (per language)
// =============================================================================
// Phase D.2 (next slice) will migrate these to `policy_render_block` so
// translations + edits don't require a code deploy. Kept inline for now
// so this PR stays bounded.
export const connectionIssueMessages: Record<string, string> = {
  'en': "I'm sorry, I seem to be having connection issues right now. Please try starting a new conversation.",
  'de': 'Es tut mir leid, ich habe gerade Verbindungsprobleme. Bitte versuchen Sie, ein neues Gespräch zu starten.',
  'fr': "Je suis désolé, j'ai des problèmes de connexion. Veuillez réessayer une nouvelle conversation.",
  'es': 'Lo siento, parece que tengo problemas de conexión. Por favor, intenta iniciar una nueva conversación.',
  'ar': 'عذراً، يبدو أنني أواجه مشاكل في الاتصال. يرجى محاولة بدء محادثة جديدة.',
  'zh': '抱歉，我目前似乎遇到了连接问题。请尝试重新开始对话。',
  'ru': 'Извините, у меня проблемы с подключением. Пожалуйста, попробуйте начать новый разговор.',
  'sr': 'Извините, изгледа да имам проблеме са везом. Молимо покушајте поново.',
};
