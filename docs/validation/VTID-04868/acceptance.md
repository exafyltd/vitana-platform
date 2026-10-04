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

AC-7: The migration drops the 3-arg `allocate_global_vtid` and creates the 4-arg version with
`p_sparring_id uuid DEFAULT NULL`. EXECUTE is revoked from PUBLIC, anon and authenticated and
granted to service_role only. Existing 3-arg named callers keep working.
TEST: services/gateway/test/vtid-04868-plan-sparring-migration.test.ts

AC-8: The `vtid_ledger` trigger in log mode never raises:
- an upsert of an existing VTID passes;
- a missing sparring record writes `missing` to the shadow log;
- a valid, owner-approved, hash-matching record writes `ok` and binds the VTID;
- an unverified id is moved to `metadata.sparring_id_unverified`.

In enforce mode the trigger raises. All of this runs against a real local Postgres 16, including
rollback and re-apply.
TEST: scripts/ci/test-vtid-04868-plan-sparring.sh (supabase/tests/vtid_04868_plan_sparring_gate.test.sql)

AC-9: `submit_plan_sparring_record` cannot set `converged` or a human approval; attested records
land as `pending_human_approval`. `service_role` cannot rewrite `rounds`, the config or the shadow
log.
TEST: supabase/tests/vtid_04868_plan_sparring_gate.test.sql

AC-10: The operator (VTID-04465) and support (VTID-04456) regression suites stay green with the new
allocator signature.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

OASIS_PROOF: none in this push. The session layer and Phase 0 emit no events. The gateway commit
for this VTID adds `vtid.plan_sparring.*` types and will update this line.
