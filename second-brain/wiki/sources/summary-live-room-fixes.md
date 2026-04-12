# Summary: Live Room Fix Reports

> Summary of all live room fix reports covering iOS crash fixes, session management issues, and Daily.co integration problems.

## Content

### Documents Summarized

1. `raw/live-rooms/IOS_CRASH_FIX_SUMMARY.md` -- detailed iOS crash analysis and fixes
2. `raw/live-rooms/LIVE_ROOM_IOS_FIX.md` -- condensed iOS fix summary
3. `raw/live-rooms/LIVE_ROOM_SESSION_FIX_SUMMARY.md` -- session management comprehensive fix

### iOS Crash Fixes (2026-02-17)

**Platforms affected:** iOS Safari (iPhone/iPad). Android and web desktop were unaffected.

**Five root causes identified:**

**1. AudioWorklet Not Supported on iOS (Critical -- ORB crash)**
- Location: `OrbVoiceClient.ts:279`
- iOS Safari does not support `AudioWorklet`; only supports deprecated `ScriptProcessorNode`
- Calling `audioWorklet.addModule()` throws and crashes the app
- **Fix:** New `ios-audio-polyfill.ts` file provides `CrossPlatformAudioRecorder` class that auto-detects iOS and falls back to ScriptProcessorNode (4096 buffer, zero-gain connection, Float32Array copying)

**2. Sample Rate Constraints Rejected by iOS**
- Location: `OrbVoiceClient.ts:258-266`
- iOS ignores `sampleRate: 16000` in getUserMedia, defaults to 48kHz
- Mismatched buffers cause audio distortion or crashes
- **Fix:** Polyfill handles 48kHz to 16kHz resampling

**3. Daily.co Iframe Missing iOS Permissions (Critical -- Live Room crash)**
- Location: `DailyVideoRoom.tsx:24`
- iOS requires explicit `allow` attribute on iframes for camera/microphone
- Without `allow="camera; microphone; autoplay; display-capture"`, iOS blocks media access
- **Fix:** Added allow attribute to DailyIframe.createFrame options

**4. AudioContext Autoplay Policy**
- iOS suspends all AudioContext instances by default
- Both ORB and Live Room create AudioContext without user interaction
- **Fix (to be applied):** Call `audioContext.resume()` after user gesture in the `start()` method

**5. EventSource (SSE) Instability on iOS**
- Location: `OrbVoiceClient.ts:160`
- iOS Safari EventSource has known connection timeout issues
- **Fix (recommended):** Auto-reconnect with 1-second delay on `readyState === CLOSED`

**Fix application status:** Fixes 1 and 3 applied. Fixes for OrbVoiceClient polyfill integration, AudioContext resume, and EventSource reconnect documented with code but marked to be applied.

### Session Management Fixes (2026-02-15)

**Five problems fixed:**

**1. Stuck Rooms (409 conflicts)**
- Rooms stuck in `lobby`/`scheduled` because `current_session_id` not cleared
- **Fix:** `endRoomFallback` in LiveRoomViewer.tsx now properly ends session, clears `current_session_id`, resets to idle

**2. Dual Data Source Confusion**
- Go Live creates in `live_rooms` + `live_room_sessions` (new tables)
- Listing queries `community_live_streams` (legacy table)
- **Fix:** Explicit sync to `community_live_streams` added in `useEndRoom` hook

**3. Incomplete End Room Reset**
- Rooms could not be reused because frontend fallback did not clear session state fully
- **Fix:** `endRoomFallback` now mirrors Gateway behavior: ends session, sets `left_at` on attendance, resets room, syncs listing

**4. Fragile isHost Detection**
- `isHost` relied on `location.state` from navigation, lost on refresh
- **Fix:** Database query fallback fetches `host_user_id` and compares with current user

**5. Duplicate Room Creation (Partial)**
- Users could get multiple rooms if Gateway `/rooms/me` fails
- **Mitigation:** Auto-provision checks `app_users.live_room_id` first; monitoring recommended

**Files modified:** LiveRoomViewer.tsx, GoLivePopup.tsx, useMyRoom.ts, plus new cleanup migration. Backend unchanged. ~150 lines modified, low risk.

### Known Limitations

- `community_live_streams` legacy table still required; full migration planned
- iOS background audio suspended by OS (cannot override)
- `ScriptProcessorNode` deprecated but required until Safari adds AudioWorklet
- Multiple rapid Go Live clicks can cause race conditions (mitigated with button disable)

## Related Pages

- [[live-rooms]]
- [[daily-co]]
- [[webrtc-integration]]
- [[sse-event-streaming]]
- [[summary-webrtc-integration]]

## Sources

- `raw/live-rooms/IOS_CRASH_FIX_SUMMARY.md`
- `raw/live-rooms/LIVE_ROOM_IOS_FIX.md`
- `raw/live-rooms/LIVE_ROOM_SESSION_FIX_SUMMARY.md`

## Last Updated

2026-04-12
