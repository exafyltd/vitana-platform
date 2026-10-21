# WebRTC Integration

> WebRTC peer-to-peer infrastructure for human-to-human video and audio calling in Live Rooms and Messenger.

## Content

### Overview

Vitana implements WebRTC for real-time peer-to-peer audio and video communication. This covers two product surfaces: **Live Rooms** (multi-participant video conferencing for community events) and **Messenger Calls** (1-on-1 audio/video calls within message threads). Signaling is handled through Supabase Realtime channels rather than a dedicated signaling server.

### Core Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `useWebRTC` hook | `hooks/useWebRTC.ts` | Manages peer connections, media streams (audio/video/screen), multi-peer support |
| `useCallState` hook | `hooks/useCallState.ts` | Call state machine (idle, calling, ringing, active, ended) |
| `LiveRoom` component | `components/LiveRoom.tsx` | Multi-user video conferencing UI |
| `MessengerCall` component | `components/MessengerCall.tsx` | 1-on-1 call UI with picture-in-picture |
| `CallManager` component | `components/CallManager.tsx` | Global call state, incoming call notifications |

### Signaling Flow

1. User A initiates call or joins a room
2. Supabase Realtime broadcasts presence information
3. User B receives notification via the Supabase channel
4. WebRTC peer connection is established using ICE candidates
5. Media streams are exchanged directly between peers

STUN servers handle NAT traversal. A TURN server for firewall traversal is listed as a future enhancement.

### Live Room Features

- Multi-participant video conferencing (tested with up to 6 participants)
- Audio/video mute/unmute controls
- Screen sharing capability
- Participant count display
- Auto-cleanup on leave
- Each room has a unique ID with a dedicated Supabase Realtime channel
- Presence tracking for automatic peer discovery

### Messenger Call Features

- 1-on-1 audio and video calls
- Picture-in-picture local video
- Call duration tracking
- Incoming call notifications with accept/reject
- Call state machine: idle -> calling -> ringing -> active -> ended

### Database Schema

Optional persistence tables for room and call history:

- `live_rooms` -- UUID primary key, name, created_by, max_participants (default 10), is_active flag
- `call_history` -- caller_id, recipient_id, call_type (audio/video), duration_seconds, timestamps

### Browser Compatibility

- Chrome 56+, Firefox 44+, Safari 11+, Edge 79+
- Mobile: iOS Safari 11+, Chrome Mobile, Firefox Mobile
- HTTPS required for `getUserMedia`
- Native mobile apps can integrate via Capacitor camera plugin

### Performance Recommendations

- Use 640x480 resolution for mobile
- Limit frame rate to 24fps for bandwidth
- Disable video when audio-only is sufficient
- Clean up streams properly on unmount

### Future Enhancements

Key planned features include: screen sharing in messenger calls, recording, chat during live rooms, virtual backgrounds, noise cancellation, hand raise, breakout rooms, TURN server, and end-to-end encryption.

## Related Pages

- [[live-rooms]]
- [[daily-co]]
- [[gemini-live-api]]
- [[sse-event-streaming]]

## Sources

- `raw/communication/WEBRTC_INTEGRATION.md`

## Last Updated

2026-04-12
