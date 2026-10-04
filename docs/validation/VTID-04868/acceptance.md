# VTID-04868 — Plan Sparring Gate (+ VTID-04869 Overview Phase 0 in the same PR)

Owner decision 2026-10-03: every new plan is sparred by an independent ping-pong partner before its
VTID is allocated, as a standard process for every plan producer. Sparring record:
`plan-sparring.md` (this folder). This PR also carries VTID-04869 (Command Hub Overview Phase 0),
whose own record is `docs/validation/VTID-04869/plan-sparring.md`.

AC-1: CLAUDE.md carries Part 1 rules 51–55. Rule 2b and §4.1 put VTID allocation after a sparred,
owner-approved plan. The partner model is Opus 4.6 on Bedrock, with no fallback.
TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts

AC-2: The `plan-sparring-partner` agent is read-only (Read/Grep/Glob) and pinned to Opus 4.6. The
`plan-sparring` skill defines at least two passes, the round caps and the record location.
TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts

AC-3: The PreToolUse hook injects a reminder on an allocation without a sparring id. It is silent
when a sparring id is present and on unrelated commands, and it never blocks.
TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts

AC-4 (VTID-04869): the Overview uses the router's real state keys, so its polls run. The
shared-health path no longer crashes, `navigateTo` is replaced, and there are no inline `onclick=`
handlers.
TEST: services/gateway/test/command-hub/vtid-04869-overview-phase0.test.ts

AC-5 (VTID-04869): missing data shows UNKNOWN, never OPERATIONAL or "No failures". The ORB card is
provider-neutral, with no Vertex/Gemini badges.
TEST: services/gateway/test/command-hub/vtid-04869-overview-phase0.test.ts

AC-6 (VTID-04869): staging serves the new Command Hub build. This check is read-only, after merge.
CURL: GET https://preview-aws-gateway.vitanaland.com/command-hub/ -> 200 text/html containing app.js?v=20261026-vtid-04869

OASIS_PROOF: none in this push. The session layer and Phase 0 emit no events. The gateway commit
for this VTID adds `vtid.plan_sparring.*` types and will update this line.
