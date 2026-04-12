# Summary: WebRTC Integration Guide

> Summary of the WebRTC integration guide for human-to-human video/audio calling in Live Rooms and Messenger.

## Content

### Document Overview

**Source:** `raw/communication/WEBRTC_INTEGRATION.md`
**Scope:** Complete WebRTC infrastructure for peer-to-peer communication

### Architecture

Five core components form the WebRTC stack:
1. **useWebRTC hook** -- manages peer connections, media streams, multi-peer support via Supabase Realtime signaling
2. **useCallState hook** -- call state machine (idle -> calling -> ringing -> active -> ended)
3. **LiveRoom component** -- multi-user video conferencing for community events (tested up to 6 participants)
4. **MessengerCall component** -- 1-on-1 audio/video calls with picture-in-picture and duration tracking
5. **CallManager component** -- global state, incoming call notifications, active call display

### Signaling

Uses Supabase Realtime channels (not a dedicated signaling server):
1. User A initiates call/joins room
2. Supabase Realtime broadcasts presence
3. User B receives notification via channel
4. WebRTC peer connection established
5. Media streams exchanged peer-to-peer

STUN servers are used for NAT traversal. TURN server support is listed as a future enhancement.

### Integration Patterns

The guide provides complete code examples for:
- Adding call buttons to message threads via `MessageThreadCallButtons`
- Creating live rooms via `CreateLiveRoomDialog`
- Global call management via `CallManager` in root layout
- Starting audio calls: `useCallState(userId).startCall(recipientId, false)`
- Starting video calls: `useCallState(userId).startCall(recipientId, true)`

### Database Schema

Optional tables for persistence:
- `live_rooms` (id, name, created_by, max_participants default 10, is_active)
- `call_history` (call_id, caller_id, recipient_id, call_type, duration_seconds, timestamps)

### Browser Support

Desktop: Chrome 56+, Firefox 44+, Safari 11+, Edge 79+. Mobile: iOS Safari 11+, Chrome Mobile, Firefox Mobile. Requires HTTPS for getUserMedia.

### Future Enhancements

Screen sharing in calls, recording, in-room chat, virtual backgrounds, noise cancellation, hand raise, breakout rooms, TURN server, end-to-end encryption.

## Related Pages

- [[webrtc-integration]]
- [[live-rooms]]
- [[daily-co]]
- [[summary-live-room-fixes]]

## Sources

- `raw/communication/WEBRTC_INTEGRATION.md`

## Last Updated

2026-04-12
