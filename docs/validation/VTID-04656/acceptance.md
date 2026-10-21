# VTID-04656 — the live developer-assistant eval sends UUID thread ids

`scripts/orb/eval-developer-assistant.mjs` (VTID-04565) sent
`threadId: "eval-<id>-<ts>"`; `/api/v1/operator/chat` validates `threadId` as a
UUID, so every question returned 400 ("threadId: Invalid uuid") — measured on
staging 2026-09-26, 69/69 rejected. Now `randomUUID()`.

AC-1: the script sends a UUID and the route still validates a UUID.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-2 (live, verified with the same request shape): 69/69 answered HTTP 200 on staging.
