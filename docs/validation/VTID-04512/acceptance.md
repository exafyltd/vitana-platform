# VTID-04512 — WebSocket per-IP slot leaked while the token was being verified

VTID: VTID-04512

## What happened (staging, 2026-09-24 16:02:36–16:04:50)

Three ORB taps sat on "connecting" and never connected. No event from the
member reached the gateway in that window (no identity, no session start).
At 16:04:50 the tab started using SSE (`transport: sse`) and stayed there.

`handleWebSocketConnection` increments the per-IP counter
(`MAX_CONNECTIONS_PER_IP = 5`), then awaits token verification and the tenant
lookup, and only after that attaches its `close`/`error` handlers. A socket
that closes during those awaits — the widget's 8 s start timeout, the member
closing the ORB mid-connect, a dropped prewarm socket — never decrements the
counter. Once five slots have leaked, every new WebSocket from that IP is
closed with 4029 before any event is emitted; the widget then latches the tab
to the SSE fallback (where VTID-04511's second voice lived). The staging
endpoint itself upgrades normally (HTTP/1.1 probe: 12/12 `101`, 16:1x UTC).

The exact close code of the member's three attempts is not in the event
store (the refusal emits nothing) and CloudWatch was not reachable from this
session; the leak is established from the code path, not from a log line.

## Fix

The slot is released by a `once('close')`/`once('error')` handler attached
immediately after the increment, before any await. The release is idempotent;
the later close/error handlers call the same release.

## Acceptance

AC-1: The release handlers are attached after the increment and before the first await.
TEST: services/gateway/test/orb/live/transport/vtid-04512-ws-connection-slot-release.test.ts

AC-2: The release is idempotent (close and error both fire it).
TEST: services/gateway/test/orb/live/transport/vtid-04512-ws-connection-slot-release.test.ts

AC-3: No handler decrements the counter directly any more.
TEST: services/gateway/test/orb/live/transport/vtid-04512-ws-connection-slot-release.test.ts

AC-4 (post-deploy, staging): repeated open/close of the ORB (including closing during "connecting") never leaves the ORB stuck on "connecting"; sessions stay `transport: ws`.
UI: https://preview-aws.vitanaland.com, open and close the ORB ten times, then start a conversation
