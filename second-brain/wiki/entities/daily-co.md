# Daily.co

> Daily.co is the third-party video infrastructure service integrated into Vitana's Live Rooms for production-grade multi-participant video conferencing.

## Content

### What It Is

Daily.co is an external video API platform that Vitana uses to power the iframe-based video experience inside [[live-rooms|Live Rooms]]. Rather than relying solely on the custom [[webrtc-integration|WebRTC peer-to-peer implementation]] (which uses Supabase Realtime for signaling), the production Live Rooms feature embeds a Daily.co iframe via `DailyIframe.createFrame()`.

### Integration Point

**Component:** `src/components/liverooms/DailyVideoRoom.tsx`

The Daily.co iframe is created inside a container ref with configuration for leave button visibility and iframe styling. The `DailyIframe` API is used to join meetings programmatically.

### iOS Permissions Fix

A critical iOS crash was caused by the Daily.co iframe lacking explicit permission attributes. iOS Safari requires the `allow` attribute on iframes to grant camera and microphone access. Without it, iOS blocks media access entirely and the app crashes.

**Fix applied:**
```
allow: 'camera; microphone; autoplay; display-capture'
```

This grants the iframe permission to access camera, microphone, autoplay audio (required by Daily.co), and screen sharing (display-capture).

### Relationship to WebRTC

Vitana maintains two video calling paths:
1. **Custom WebRTC** (via Supabase Realtime signaling) -- used for Messenger 1-on-1 calls and community live rooms with peer-to-peer connections
2. **Daily.co iframe** -- used for production Live Room sessions with more robust infrastructure

Both paths coexist. The custom WebRTC path handles signaling and media directly, while Daily.co provides a managed infrastructure layer for rooms that need higher reliability and scale.

### Session Lifecycle

When a host clicks "Go Live":
1. A session is created via `POST /rooms/:id/sessions` on the Gateway
2. The Gateway syncs the session to `community_live_streams` for listing
3. `DailyVideoRoom` renders the Daily.co iframe
4. Participants join through the Daily.co meeting URL
5. On "End Room," the session is ended, room reset to idle, and listing synced

### Known Issues

- iOS requires explicit iframe permissions (fixed)
- Daily.co iframe does not natively integrate with Supabase presence tracking
- The `community_live_streams` legacy table must be synced separately

## Related Pages

- [[live-rooms]]
- [[webrtc-integration]]
- [[google-gemini]]

## Sources

- `raw/live-rooms/IOS_CRASH_FIX_SUMMARY.md`
- `raw/live-rooms/LIVE_ROOM_IOS_FIX.md`
- `raw/communication/WEBRTC_INTEGRATION.md`

## Last Updated

2026-04-12
