# Gemini Live API

> Google Gemini Live API integration for real-time multi-modal AI interaction via voice, camera, screen sharing, and text.

## Content

### Overview

Vitana's communication system enables real-time interaction with Google's Gemini 2.0 Flash model (`gemini-2.0-flash-exp`) through four input modalities: microphone (voice-only), camera (video conversation), screen sharing (AI-assisted screen review), and sparkles button (text-based AI advice). The system uses WebSocket connections proxied through a Supabase Edge Function (`vertex-live`) to maintain secure, low-latency bidirectional streaming.

### Architecture

```
Frontend (React)  -->  Supabase Edge Function (Deno)  -->  Google Gemini Live API
   WebSocket (wss://)        Proxy + Auth                    WebSocket (wss://)
```

The three-tier design ensures the Google API key never reaches the client. The Supabase Edge Function authenticates the user via Supabase Auth, upgrades HTTP to WebSocket, and proxies all traffic bidirectionally.

### Input Modes

**Mic Icon (Audio-Only)**
- Captures 24kHz mono PCM audio via `AudioRecorder`
- Auto-connects to Gemini if not already connected, with 30-second timeout
- No bell notification (intentional -- avoids auditory interruption during voice)
- Sends base64-encoded PCM16 audio chunks

**Camera Icon (Video Conversation)**
- Captures 640x480 JPEG frames at 1 FPS via `CameraRecorder`
- Bell notification rings on activation
- Automatically enables microphone (cascade behavior)
- Stopping camera also stops mic for user privacy

**Start Stream Button (Screen Sharing)**
- Uses `getDisplayMedia` for screen capture at 1 FPS JPEG
- Bell notification on activation
- Button changes color: gray (ready) to red (streaming)
- Polling-based state sync (150ms interval) to avoid race conditions

**Sparkles Icon (Text-Based Advice)**
- Sends a text prompt to Gemini without opening mic/camera
- Context-aware: uses conversation history if available
- Icon spins yellow during processing, auto-returns to neutral after 3 seconds
- No bell notification

### State Management

The `useVertexLive` hook (`src/hooks/useVertexLive.ts`) manages all AI communication state:

- Connection states: `disconnected` -> `connecting` -> `gemini_ready` -> `connected` (with `error` branch)
- Session flags track whether bell has been rung (per trigger type) to prevent duplicate notifications
- Auto-reconnect with exponential backoff up to 3 retries (2s, 4s, 8s delays, max 15s)
- `isUserDisconnectingRef` distinguishes intentional disconnects from errors

### WebSocket Message Format

**Outgoing (client to Gemini):**
- Audio: `{ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=24000", data: "<base64>" }] } }`
- Video/Screen: `{ realtimeInput: { mediaChunks: [{ mimeType: "image/jpeg", data: "<base64>" }] } }`
- Text: `{ clientContent: { turns: [{ parts: [{ text: "..." }] }] } }`

**Incoming (Gemini to client):**
- Connection ready: `{ type: "connection_ready", conversationId: "uuid" }`
- Setup complete: `{ setupComplete: true }`
- AI text: `{ serverContent: { modelTurn: { parts: [{ text: "..." }] }, turnComplete: true } }`
- AI audio: raw PCM16 binary ArrayBuffer at 24kHz

### Service Layer

`VertexLiveService` (`src/services/vertexLiveService.ts`) handles WebSocket communication and media encoding. Key classes:

- `AudioRecorder` -- 24kHz PCM capture with echo cancellation
- `CameraRecorder` -- 640x480 JPEG at 1 FPS, 0.8 quality
- `ScreenRecorder` -- screen capture JPEG at 1 FPS

### Voice Configuration

The Gemini model uses the "Aoede" prebuilt voice with audio + vision modalities enabled.

## Related Pages

- [[google-gemini]]
- [[webrtc-integration]]
- [[live-rooms]]
- [[sse-event-streaming]]

## Sources

- `raw/communication/TECHNICAL_REPORT_COMMUNICATION_LOGIC.md`

## Last Updated

2026-04-12
