# VTID-05559 — gateway-cohost (live-room-edit-cohost) acceptance

Lane: `live-room-edit-cohost/gateway-cohost`. Plan: `.kiro/specs/live-room-edit-cohost/plan.md`.

## Status of this PR (red tests first)
- `services/gateway/test/live-room-cohost-helpers.test.ts` covers `isRoomHost` and `filterCoHosts`.
- The module `services/gateway/src/services/live-cohosts.ts` does not exist yet, so the tests fail on the base branch.
- Implementation follows in this PR. Not yet verified: no test has run in CI yet.

## Acceptance (from tasks.md, gateway-cohost lane)
- A co-host who opens a scheduled room starts it, gets the moderator view and token, and can run it.
- A creator can change every field of a scheduled session and the list shows the new values.
- States: JWT identity decides the actor; 401 with no token; RPC failure means not host; locked fields refused while live; listing write failure is 502 and retry converges; more than 5 or invalid co-hosts is 400 with the ids.
- Staging proof: read-only `PATCH .../sessions/current` probe without a token returns 401. A real co-host run is not verified on staging (needs a live write).
