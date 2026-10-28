# vitana-v1 companion patch — ORB Recovery 4: audio-ready handshake (DEV-COMHU-0504)

**Target repo:** `exafyltd/vitana-v1` (NOT reachable from the autonomous sandbox)
**Companion to:** vitana-platform PR — `POST /api/v1/orb/session/:id/audio-ready`
endpoint + `_signalAudioReady()` in `orb-widget.js`.

## What ships automatically
The audio-ready signal lives in the gateway-served `orb-widget.js` (it POSTs the ack as
soon as the AudioContext reaches `running`). The community surface gets it on deploy.

## 1. Cache-bust bump (required)
```diff
- orb-widget.js?v=20260529-VTID-03185-audio-queue-closure
+ orb-widget.js?v=20260531-DEV-COMHU-0504-audio-ready
```

## 2. LiveKit path (recommended)
If `vitana-v1` plays the LiveKit remote audio track through a path that doesn't go
through the widget's `_signalAudioReady`, post the ack when the LiveKit room's audio
output is ready:

```ts
// once the LiveKit AudioContext / output is confirmed playable
await fetch(`${gatewayUrl}/api/v1/orb/session/${sessionId}/audio-ready`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: '{}',
});
```

## Acceptance (post-deploy)
- Delayed audio unlock (synthetic) → greeting waits for the ack (≤3s).
- No ack within 3s → greeting proceeds anyway (session not stranded).
- Reconnect with `first_audio_ended` recorded <15 min → no full greeting re-send.
