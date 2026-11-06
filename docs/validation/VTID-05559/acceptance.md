# VTID-05559 — gateway-cohost acceptance

Lane: `live-room-edit-cohost/gateway-cohost`. Plan: `.kiro/specs/live-room-edit-cohost/plan.md`.
Status: red tests written first; implementation follows in this PR. Nothing below is verified yet.

AC-1: A listed co-host is host for enter and moderation, and the creator is host without any extra call.
TEST: services/gateway/test/live-room-cohost-helpers.test.ts :: isRoomHost
Status: red on base (module not yet written).

AC-2: An unlisted member is not host, and an RPC failure means not host without throwing.
TEST: services/gateway/test/live-room-cohost-helpers.test.ts :: isRoomHost
Status: red on base.

AC-3: Co-host validation keeps only valid ids, reports dropped ids (never silently), and fails loudly when the validation function is missing.
TEST: services/gateway/test/live-room-cohost-helpers.test.ts :: filterCoHosts
Status: red on base.

AC-4: A co-host who opens a scheduled room can start it, see the moderator view and token, and run it. Route-level behaviour.
TEST: services/gateway/test/live-room-cohost-routes.test.ts :: enter as co-host (planned, not yet written)
Status: planned.

AC-5: PATCH of a scheduled session is creator-only, honours locked fields while live, and returns 502 on listing failure with a repeatable retry.
TEST: services/gateway/test/live-room-cohost-routes.test.ts :: PATCH sessions/current (planned, not yet written)
Status: planned.

AC-6: Staging proof: the unauthenticated PATCH probe returns 401 on the deployed route. Read-only, no live write.
CURL: PATCH https://preview-aws-gateway.vitanaland.com/api/v1/live/rooms/00000000-0000-0000-0000-000000000000/sessions/current expects 401 (planned, in staging-tests.json)
Status: planned.
