# vitana-v1 companion patch — ORB Recovery 0.1 (DEV-COMHU-0501)

**Target repo:** `exafyltd/vitana-v1` (NOT reachable from the autonomous sandbox)
**Companion to:** vitana-platform PR — cross-provider speaking-state watchdog in
`services/gateway/src/frontend/command-hub/orb-widget.js`.

The gateway-served Command Hub widget now carries the watchdog. The community
surface (`vitanaland.com`) loads the SAME `orb-widget.js` from the gateway, so the
watchdog logic ships automatically once the gateway deploys. Two things still need a
human hand in the `vitana-v1` repo:

## 1. Cache-bust bump (required)

`vitana-v1` pins the widget version in its own HTML shell. Bump it so returning users
fetch the watchdog build.

```bash
# in the vitana-v1 checkout
grep -rn "orb-widget.js?v=" index.html src/ 2>/dev/null
```

Change the pinned query string to match the gateway:

```diff
- orb-widget.js?v=20260529-VTID-03185-audio-queue-closure
+ orb-widget.js?v=20260531-DEV-COMHU-0501-speaking-watchdog
```

## 2. LiveKit-path parity audit (recommended)

The watchdog in `orb-widget.js` is transport-agnostic by design: it stamps
`lastAudioReceivedAt` on every inbound frame routed through `_playAudio`, and clears a
stuck `audioPlaying` when frames stop for ≥2 s with nothing scheduled/queued.

`vitana-v1` drives LiveKit directly via the `livekit-client` SDK
(`src/hooks/useLiveKitVoice.ts`). Confirm that LiveKit audio frames also funnel through
the same `_playAudio` entry point (so `lastAudioReceivedAt` is stamped on the WebRTC
path too). If LiveKit plays its remote track via a separate `<audio>` element / Web
Audio node rather than `_playAudio`, add an equivalent stamp on the LiveKit
`TrackSubscribed` / `track.on('message')` frame handler:

```ts
// in the LiveKit remote-audio frame path
window.VitanaOrb && window.VitanaOrb._noteAudioFrame && window.VitanaOrb._noteAudioFrame();
```

(If you want this hook, the gateway widget can expose a tiny
`VitanaOrb._noteAudioFrame = () => { _s.lastAudioReceivedAt = Date.now(); }` —
tracked as a follow-up; not required for the Vertex/SSE path which already stamps.)

## Acceptance (post-deploy, community surface)
- Vertex multi-chunk TTS turn → watchdog does NOT fire (frames keep arriving).
- Simulated stalled subscription (LiveKit) → "Vitana speaking" clears within ~2 s,
  mic re-opens.
- `[VTOrb] session diagnostics: ...` line present in console at session open.
