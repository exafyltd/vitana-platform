/**
 * A1 (orb-live-refactor): pure protocol/model constants.
 *
 * Lifted verbatim from services/gateway/src/routes/orb-live.ts.
 * Identical values — no behavior change. The route file now imports
 * these instead of declaring them locally so subsequent extraction
 * steps share the same model + sample-rate contract.
 *
 * What lives here: pure constants (model strings, sample rates) that
 * never depend on `process.env`. Env-derived configuration
 * (VERTEX_PROJECT_ID, VERTEX_LOCATION, feature flags, timeouts) moves
 * in A2 into config.ts.
 */

/**
 * Vertex AI Live API model — BidiGenerateContent endpoint.
 */
export const VERTEX_LIVE_MODEL = 'gemini-live-2.5-flash-native-audio';

/**
 * Vertex AI TTS model — Cloud TTS with Gemini voices.
 */
export const VERTEX_TTS_MODEL = 'gemini-2.5-flash-tts';

/**
 * Server-to-client audio sample rate (Hz).
 *
 * The Live API streams TTS audio to the orb client at 24kHz mono PCM.
 * The client's `AudioContext` must be configured for this rate or
 * playback will sound pitch-shifted.
 */
export const AUDIO_OUT_RATE_HZ = 24000;

/**
 * Client-to-server audio sample rate (Hz).
 *
 * The orb-widget captures microphone audio at 16kHz mono PCM.
 * That rate is the Live API input contract; resampling on the
 * server is forbidden because it adds 30–60ms of latency.
 */
export const AUDIO_IN_RATE_HZ = 16000;
