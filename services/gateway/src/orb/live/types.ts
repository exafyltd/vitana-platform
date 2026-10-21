/**
 * A1 (orb-live-refactor): shared types & wire-protocol shapes.
 *
 * Lifted verbatim from services/gateway/src/routes/orb-live.ts.
 * Identical declarations — no logic change. orb-live.ts now imports
 * these instead of declaring them locally so subsequent extraction
 * steps (A3 instruction builder, A8 session lifecycle, A9 transport
 * handlers) can share the same wire contract without depending on
 * the route file.
 *
 * What lives here: pure data shapes that don't reference Express,
 * WebSocket, or other runtime classes — only the protocol surface
 * the orb client and the gateway exchange on the wire.
 *
 * What does NOT live here yet: `GeminiLiveSession`, `WsClientSession`,
 * `OrbLiveSession`, and other types that wrap runtime state (Maps,
 * AbortControllers, sockets). Those move in A8.
 */

/**
 * VTID-CONTEXT: Client environment context gathered at session start.
 * Injected into system instruction to make Vitana contextually aware.
 */
export interface ClientContext {
  ip: string;
  city?: string;
  country?: string;
  timezone?: string;
  localTime?: string;       // e.g. "Saturday evening, 20:35"
  timeOfDay?: string;       // morning | afternoon | evening | night
  device?: string;          // iPhone, Android, Desktop
  browser?: string;         // Chrome, Safari, Firefox
  os?: string;              // iOS, Android, Windows, macOS
  isMobile?: boolean;
  lang?: string;            // from Accept-Language
  referrer?: string;        // how they found us
}

/**
 * VTID-01155: Live session start request
 */
export interface LiveSessionStartRequest {
  lang: string;
  voice_style?: string;
  response_modalities?: string[];
  conversation_summary?: string;
  // VTID-RESPONSE-DELAY: Per-session VAD silence threshold override (ms).
  // Allows clients to tune response latency vs. pause tolerance.
  vad_silence_ms?: number;
  // VTID-02020: contextual recovery — when the client is re-starting after a
  // disconnect, it sends the last few transcript turns + the stage the user
  // was in (idle / listening_user_speaking / thinking / speaking) so the
  // backend can route to the contextual recovery prompt instead of the
  // standard greeting. conversation_id is the pinned thread identifier.
  transcript_history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  reconnect_stage?: 'idle' | 'listening_user_speaking' | 'thinking' | 'speaking';
  conversation_id?: string;
}

/**
 * VTID-01155: TTS request body
 */
export interface TtsRequest {
  text: string;
  lang?: string;
  voice_style?: string;
}

/**
 * VTID-01155: Stream message types from client
 */
export interface LiveStreamAudioChunk {
  type: 'audio';
  data_b64: string;
  mime: string;  // audio/pcm;rate=16000
}

export interface LiveStreamVideoFrame {
  type: 'video';
  source: 'screen' | 'camera';
  data_b64: string;  // JPEG base64
  width?: number;
  height?: number;
}

export type LiveStreamMessage = LiveStreamAudioChunk | LiveStreamVideoFrame;
