# Google Gemini

> Google Gemini API integration in Vitana for real-time multi-modal AI communication through voice, camera, screen sharing, and text.

## Content

### What It Is

Google Gemini is the AI model powering Vitana's real-time interactive communication features. Specifically, Vitana uses the **Gemini 2.0 Flash** model (`gemini-2.0-flash-exp`) via the **Gemini Live API** for bidirectional streaming of audio, video, and text between users and the AI.

### API Details

- **Endpoint:** `generativelanguage.googleapis.com` (Gemini Live API)
- **Model:** `gemini-2.0-flash-exp`
- **Voice:** Aoede (prebuilt voice)
- **Modalities:** Audio + Vision (simultaneous)
- **Protocol:** WebSocket (bidirectional streaming)

### How It Is Used

Vitana proxies all Gemini communication through a **Supabase Edge Function** (`vertex-live`, Deno runtime) to keep the API key server-side. The flow:

1. Frontend establishes WebSocket to the Edge Function
2. Edge Function authenticates user via Supabase Auth
3. Edge Function opens a second WebSocket to the Gemini Live API
4. All messages are proxied bidirectionally between client and Gemini

### Input Modalities

| Mode | Media | Format | Rate |
|------|-------|--------|------|
| Microphone | Audio | PCM16 at 24kHz, base64 | Continuous streaming |
| Camera | Video frames | JPEG 640x480, base64 | 1 FPS |
| Screen share | Screen frames | JPEG, base64 | 1 FPS |
| Text (Sparkles) | Text prompt | JSON | On-demand |

### Output

- **Text transcripts** via `serverContent.modelTurn.parts[].text` with `turnComplete` flag
- **Audio responses** as raw PCM16 binary ArrayBuffer at 24kHz, played back through the Web Audio API

### Connection Lifecycle

1. Client sends auth token via WebSocket handshake
2. Edge Function validates and opens Gemini connection
3. Gemini sends `{ setupComplete: true }` when ready
4. Frontend transitions to `gemini_ready` state
5. AI sends a greeting prompt automatically
6. Bidirectional streaming begins (audio/video/text)
7. On disconnect, exponential backoff with up to 3 retries

### Integration with ORB Voice

The ORB Voice feature (`OrbVoiceClient`) also uses Gemini for voice-based AI interaction, but connects via SSE (`/api/v1/orb/live/stream`) rather than the WebSocket proxy. On iOS, this required special handling due to AudioWorklet not being supported (uses ScriptProcessorNode fallback) and EventSource instability.

### Known Limitations

- iOS Safari requires AudioContext resume after user gesture
- iOS uses 48kHz sample rate internally; resampling needed for 16kHz ORB audio
- Camera/screen share at 1 FPS provides limited visual context per frame
- Auto-reconnect capped at 3 retries with max 15-second delay

## Related Pages

- [[gemini-live-api]]
- [[webrtc-integration]]
- [[live-rooms]]
- [[daily-co]]

## Sources

- `raw/communication/TECHNICAL_REPORT_COMMUNICATION_LOGIC.md`
- `raw/live-rooms/IOS_CRASH_FIX_SUMMARY.md`

## Last Updated

2026-04-12
