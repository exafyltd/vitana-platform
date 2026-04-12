# Live Rooms

> Live Rooms system: architecture, session management, Daily.co integration, iOS crash fixes, and dual data source synchronization.

## Content

### Overview

Live Rooms is Vitana's real-time video conferencing feature for community events, coaching sessions, and meetups. It supports multi-participant video via two underlying technologies: a custom [[webrtc-integration|WebRTC implementation]] using Supabase Realtime for signaling, and a [[daily-co|Daily.co]] iframe integration for production-grade rooms. Session management uses a dual-table architecture (`live_rooms`/`live_room_sessions` and the legacy `community_live_streams`).

### Architecture

**Database tables:**
- `live_rooms` -- permanent room records with `status` (idle, lobby, scheduled, live), `current_session_id`, `host_user_id`, `host_present` flag
- `live_room_sessions` -- individual session records with status (active, ended, cancelled), attendance tracking
- `community_live_streams` -- legacy listing table, still used for the Live Rooms browse view

**Key frontend files:**
- `src/pages/community/LiveRoomViewer.tsx` -- room viewer with host controls
- `src/components/GoLivePopup.tsx` -- session creation flow
- `src/hooks/useMyRoom.ts` -- room management hook
- `src/components/liverooms/DailyVideoRoom.tsx` -- Daily.co iframe integration

**Backend:**
- Gateway routes: `POST /rooms/:id/sessions` (create session, line 1410-1441 in live.ts), `POST /rooms/:id/end` (end session, line 486-503)
- Gateway syncs to `community_live_streams` on both session creation and end

### Session Management Fixes (2026-02-15)

Five critical issues were fixed:

**1. Stuck Rooms (409 conflicts)**
Rooms stuck in `lobby` or `scheduled` status because `current_session_id` was not cleared when sessions ended. Fix: `endRoomFallback` now properly ends session, clears `current_session_id`, resets room to `idle`.

**2. Dual Data Source Confusion**
Sessions created via "Go Live" (using `live_rooms` + `live_room_sessions`) did not appear in the listing (which queries `community_live_streams`). Fix: explicit sync to `community_live_streams` added in `useEndRoom`.

**3. Incomplete End Room Reset**
Rooms could not be reused after ending because state was not fully cleared. Fix: `endRoomFallback` now mirrors Gateway behavior -- ends session, sets `left_at` on attendance, resets room to idle, syncs to `community_live_streams`.

**4. Fragile isHost Detection**
Host could not end their room after page refresh because `isHost` relied on `location.state` from navigation. Fix: database query fallback to fetch `host_user_id` and compare with current user.

**5. Duplicate Room Creation (Partial)**
Users could end up with multiple permanent rooms if Gateway `/rooms/me` failed. Mitigation: auto-provision logic checks `app_users.live_room_id` first. Monitoring recommended.

**Database cleanup migration:** `20260215000000_cleanup_stuck_live_sessions.sql` -- one-time idempotent cleanup of all stuck rooms/sessions.

### iOS Crash Fixes (2026-02-17)

Two critical iOS crashes were identified and fixed:

**1. AudioWorklet Not Supported on iOS (ORB crash)**
iOS Safari does not support `AudioWorklet`. When `OrbVoiceClient` tried to load it, iOS crashed immediately. Fix: `ios-audio-polyfill.ts` provides `CrossPlatformAudioRecorder` that auto-detects iOS and falls back to `ScriptProcessorNode` (4096 sample buffer, handles 48kHz to 16kHz resampling).

**2. Daily.co Iframe Missing iOS Permissions (Live Room crash)**
iOS requires explicit `allow` attribute on iframes for camera/microphone access. Fix: `DailyVideoRoom.tsx` now sets `allow: 'camera; microphone; autoplay; display-capture'` on the iframe.

**Additional iOS issues addressed:**
- AudioContext autoplay policy: iOS suspends AudioContext by default; must call `resume()` after user gesture
- Sample rate: iOS always uses 48kHz internally; the polyfill handles resampling
- EventSource instability on iOS Safari: added reconnect logic with 1-second delay

### Known Limitations

- `community_live_streams` table still exists as legacy; future migration planned to fully consolidate
- Race conditions possible with multiple rapid "Go Live" clicks (mitigated with button disable)
- iOS background audio is suspended by the OS and cannot be overridden
- iOS `ScriptProcessorNode` is deprecated but required until Safari adds AudioWorklet support

## Related Pages

- [[webrtc-integration]]
- [[daily-co]]
- [[gemini-live-api]]
- [[sse-event-streaming]]

## Sources

- `raw/live-rooms/LIVE_ROOM_SESSION_FIX_SUMMARY.md`
- `raw/live-rooms/IOS_CRASH_FIX_SUMMARY.md`
- `raw/live-rooms/LIVE_ROOM_IOS_FIX.md`
- `raw/communication/WEBRTC_INTEGRATION.md`

## Last Updated

2026-04-12
