/**
 * BOOTSTRAP-ORB-MOVE: Phase 2 (move-only) — protocol + watchdog + keepalive
 * constants that were previously inline in routes/orb-live.ts.
 *
 * All values are preserved byte-for-byte. No behaviour change.
 *
 * Categories:
 *   - VAD / end-of-speech detection
 *   - Post-turn mic cooldown (echo prevention)
 *   - Silence keepalive (anti-idle-timeout)
 *   - Response watchdog (stall detection)
 *   - Forwarding watchdog (zombie upstream detection)
 *   - Loop guard + tool guard (runaway prevention)
 *   - User-facing connection-issue messages
 */

// =============================================================================
// VTID-RESPONSE-DELAY: VAD silence threshold for end-of-speech detection
// =============================================================================
// How long Vertex waits after user stops speaking before triggering a response.
// Default Vertex VAD is ~100ms which is too aggressive — the model starts
// responding while users are still mid-thought or pausing between sentences.
// 1200ms provides natural pause tolerance for conversational speech.
export const VAD_SILENCE_DURATION_MS_DEFAULT = 1_200;

// =============================================================================
// VTID-ECHO-COOLDOWN: Post-turn mic audio cooldown
// =============================================================================
// After Vertex sends turn_complete, the server unsets isModelSpeaking
// immediately. But the client is still draining its audio playback queue
// (Web Audio API scheduled sources). During this window, speaker output gets
// picked up by the mic and forwarded to Vertex as new user speech, causing
// phantom responses. Mobile AEC is weak — diagnostics show ghost responses
// triggered on 2 chunks (~170ms) within 740ms of turn_complete. 2000ms covers
// realistic mobile playback drain without killing responsiveness.
export const POST_TURN_COOLDOWN_MS = 2_000;

// =============================================================================
// VTID-STREAM-SILENCE: Silence audio keepalive for Vertex Live API
// =============================================================================
// Vertex closes the stream with code 1000 after ~25-30s of no audio.
// Periodic 250ms silence frames keep it alive during user pauses.
export const SILENCE_KEEPALIVE_INTERVAL_MS = 3_000; // Check every 3s
export const SILENCE_IDLE_THRESHOLD_MS = 3_000;     // Send silence after 3s idle
export const SILENCE_PCM_BYTES = 8_000;             // 250ms at 16kHz, 16-bit mono
export const SILENCE_AUDIO_B64 = Buffer.alloc(SILENCE_PCM_BYTES, 0).toString('base64');

// =============================================================================
// VTID-WATCHDOG: Response watchdog — stall detection across failure modes
// =============================================================================
// Monitors whether Gemini produces ANY output (audio/text) within N seconds
// after greeting prompt or user speech. Catches Vertex stalls, tool-call
// cascade failures, network drops, post-function-response hangs, etc.
export const GREETING_RESPONSE_TIMEOUT_MS = 8_000;  // 8s for greeting to arrive
export const TURN_RESPONSE_TIMEOUT_MS = 10_000;     // 10s after user speech

// =============================================================================
// VTID-FORWARDING-WATCHDOG: Detect zombie upstream WebSocket connections
// =============================================================================
// Armed when user audio is forwarded but no watchdog is running and model is
// not speaking — catches the case where the upstream WS is OPEN but silently
// not processing anything. If Vertex doesn't acknowledge within this window
// (via input_transcription or model response), stall recovery force-closes
// the WS to trigger a transparent reconnect.
//
// BOOTSTRAP-ORB-RELIABILITY-R2: Reduced 15 s → 6 s. 24 h production diagnostic
// showed 21 % of sessions (14 of 67) hit forwarding_no_ack; with 15 s
// detection + reconnect + greeting re-setup users experienced 20–30 s of
// dead air. Vertex's SLO for input_transcription is under 2 s; 6 s gives
// 3× headroom while halving the user-visible interruption window. All 14
// stalls in the 24 h window successfully recovered via transparent reconnect,
// so faster detection just makes the recovery faster without raising the
// false-positive rate.
//
// BOOTSTRAP-ORB-WATCHDOG-RESTORE: Raised 6 s → 10 s after voice sessions
// started flickering on/off with user reports "greeting and first question
// break." Field diagnostics showed Vertex legitimately takes 8–9 s to respond
// to the first user turn when system_instruction is ~15 K chars + 16 tools
// (our current config with memory + profile + tools). 6 s was firing on every
// real first question and triggering a reconnect storm. 10 s accommodates
// normal first-turn latency while still cutting the original 15 s interruption
// window by a third.
export const FORWARDING_ACK_TIMEOUT_MS = 10_000;

// =============================================================================
// VTID-LOOPGUARD: Response loop prevention
// =============================================================================
// Gemini Live can enter a generative loop where the model keeps responding to
// its own turn_complete without user input. After MAX_CONSECUTIVE_MODEL_TURNS
// model turns without user speech, silence keepalive is paused so Vertex's
// idle timeout stops the loop.
export const MAX_CONSECUTIVE_MODEL_TURNS = 3;

// VTID-TOOLGUARD: Hard limit on consecutive tool calls without audio output.
// Gemini can spiral calling tools indefinitely (search_memory + search_events
// + search_memory + ...). After this many consecutive calls, a synthetic
// function_response is sent instructing the model to answer with data
// already gathered. See PR #743 for the fix that made this non-destructive.
export const MAX_CONSECUTIVE_TOOL_CALLS = 5;

// =============================================================================
// User-facing connection-issue messages (per language)
// =============================================================================
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
