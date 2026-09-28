# VTID-04601 — no push notifications for Vitana voice replies during a live ORB session

Reported 2026-09-26 (screenshot): in a Serbian ORB conversation, every Vitana
reply also arrived as a MAXINA push notification on the lock screen.

## Evidence (read-only, production Supabase)

`outputs/live-evidence.md`. Over 7 days, **all 8** `new_chat_message` rows
titled "Vitana" belong to Serbian (`sr`) voice sessions, while the same window
bridged 300+ German/English voice turns into `chat_messages` with **zero**
notifications.

## Root cause

Voice turns reach `chat_messages` from two `turn_complete` paths in
`orb/live/session/upstream-message-handler.ts`:

- `handleTurnComplete()` — the shared path Nova Sonic and the cascade use. Bridges, never notifies.
- the legacy raw-message path — still used by `VertexLiveClient`, i.e. the
  Serbian-only Vertex bridge (VTID-04000). VTID-03520 added
  `notifyOrbVoiceBridgeWrite()` here, which fired `notifyUserAsync(... 'new_chat_message')`
  (push + in-app) after each Vitana reply.

So only Serbian — the one language still on Vertex — pushed every spoken reply
to the lock screen while the member was listening to it.

## Change

- Removed `notifyOrbVoiceBridgeWrite()` and its call. The Vitana leg is still
  written to `chat_messages` with `read_at` set, exactly like the shared path,
  so the Vitana inbox thread keeps the transcript.
- The test for the removed helper is replaced by a regression guard.

## Acceptance criteria

AC-1 No turn_complete path imports or calls the notification service.
  TEST: services/gateway/test/orb/live/session/chat-bridge-reliability.test.ts ("does not import or call the notification service")
AC-2 Both paths still bridge the Vitana leg into chat_messages, marked read.
  TEST: services/gateway/test/orb/live/session/chat-bridge-reliability.test.ts ("still bridges the Vitana leg into chat_messages on both paths, marked read")
AC-3 bridgeVoiceTranscript never triggers a notification.
  TEST: services/gateway/test/orb/live/session/chat-bridge-reliability.test.ts ("bridgeVoiceTranscript itself never calls notifyUserAsync")
AC-4 Retry + failure telemetry of the bridge unchanged.
  TEST: services/gateway/test/orb/live/session/chat-bridge-reliability.test.ts (existing bridgeVoiceTranscript suite)

## Not fixed here (separate finding)

The same session's stored Vitana reply is duplicated
("Razumem. Nema problema. Želim vam prijatan dan!Razumem. Nema problema. …") —
the Vertex path accumulates the output transcript twice for one turn. That is
why the notification text repeated. It still affects the inbox transcript and
needs its own VTID.
