# VTID-04654 — admin ORB opener: no apology, facts are the briefing insights

Found by the owner-requested full staging verification of the VTID-04560 program
(2026-09-26). Companion fixes in the same PR: VTID-04655 (role truth), VTID-04656
(live eval script). Full report: `docs/validation/VTID-04560/outputs/staging-verification-2026-09-26.md`.

## What was wrong (measured on staging, 11d116b1)

- 3 of 4 admin-surface voice sessions opened with the same canned line
  ("Es tut mir leid, aber ich kann die für Ihre Anfrage erforderlichen
  Informationen nicht abrufen…"), no tool call, although the session carried 5
  facts from the admin briefing. BackOffice, fed the same briefing, opened
  correctly 4 of 4.
- Cause: the admin instruction said "Use the admin_* tools for briefings" while
  the opener directive says "speak from these facts, call no tool before this
  first reply". The one success broke the rule and called `admin_briefing`.
- Second defect: `briefingHighlights()` took the first five non-empty lines, so
  the briefing's own instruction ("The supervisor just opened the orb… Do NOT
  do a generic greeting…") was served as a fact and the third insight dropped.

## Acceptance criteria

AC-1: Each numbered insight of an admin briefing becomes one fact (headline — detail); instruction lines are never facts; a block without numbered items falls back to plain lines.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-2: The admin instruction states the briefing is already loaded and names `admin_briefing` for a later refresh only; it no longer tells the model to fetch briefings with admin_* tools.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-3: Only the admin payload changes; every member scenario is byte-identical.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

AC-4 (staging, after deploy): admin-surface sessions open from the insights with no apology on repeated runs.
CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/orb/live/session/start {surface:'admin', view_role:'admin'} + SSE greeting transcript (greeting only, then /session/stop)

Mutation check: reverting the source changes fails 4 of the new tests.
