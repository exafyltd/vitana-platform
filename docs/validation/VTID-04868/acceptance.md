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

AC-3: The PreToolUse hook DENIES an allocation that references no sparring record (multi-line SQL included). It is silent
when a sparring record is referenced and on unrelated commands.
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

AC-11: Stage `plan_sparring` is wired in every stage enumeration. It is Bedrock only, uses
`PLAN_SPARRING_MODEL` (default Opus 4.6 eu profile), and has no fallback. Policy validation
rejects a fallback for this stage, and the router refuses to run it on anything but Bedrock.
TEST: services/gateway/test/vtid-04868-plan-sparring-stage.test.ts

AC-12: Bedrock adapter and router history keep `thinking`/`redacted_thinking` blocks unchanged
across tool turns, and pass through `thinking: {type:'adaptive'}` and `output_config.effort`.
Other stages are unchanged.
TEST: services/gateway/test/vtid-04868-plan-sparring-stage.test.ts
TEST: services/gateway/test/bedrock-vision-tools.test.ts

AC-13: Partner loop:
- every call runs through the router with `allowFallback:false`;
- GitHub reads use `PLAN_SPARRING_GITHUB_TOKEN` only (never the merge token), pinned to `base_ref`,
  with a cap on tool calls;
- the canonical plan hash is enforced;
- the round-1 evidence floor is enforced;
- findings are stored verbatim;
- a model failure escalates as `model_unavailable` with zero calls to other providers.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts

AC-14: `/api/v1/plans/spar`:
- create, round and read need the service token or an admin;
- approve needs an exafy_admin and must echo `final_plan_hash`;
- an escalated session needs `acknowledge_escalation`;
- an attested record is refused with `gateway_pass_required`.
TEST: services/gateway/test/plans-spar.test.ts

AC-15: The operator (VTID-04465), support (VTID-04456) and roles (VTID-04560, atlas claims the new
route file) regression suites pass.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-16: The hourly reconciler (behind `PLAN_SPARRING_RECONCILER_ENABLED`, default off) reads
`plan_sparring_trigger_status()`. A disabled or missing trigger, a config change or a ledger row
without a sparring record emits `vtid.plan_sparring.tamper_detected`. A disabled trigger is visible
as `tgenabled='D'`.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts
TEST: supabase/tests/vtid_04868_plan_sparring_gate.test.sql

## Hardening (review findings on PR #3899, migration `20261004120000_vtid_04868_plan_sparring_hardening.sql`)

The first migration is already applied live and is not edited; every DB change below is in the
new migration, which the rollback also reverses.

AC-17 (finding 1, P1): the gateway's session create sends no `rounds` key (service_role has no
INSERT privilege on that column; the column default `[]` applies). Every key it does send is in the
service_role INSERT column grant. In SQL, an insert without `rounds` succeeds as service_role and
one naming `rounds` is refused.
TEST: services/gateway/test/vtid-04868-plan-sparring-repository.test.ts
TEST: supabase/tests/vtid_04868_plan_sparring_gate.test.sql

AC-18 (finding 2, P1): plan-hash binding at allocation.
- `allocate_global_vtid` is now 5-arg (`p_plan_hash text DEFAULT NULL` added; 4-arg dropped),
  stores `metadata.plan_hash`, EXECUTE service_role only.
- The gate binds a sparring id only when `metadata.plan_hash` equals the session's
  `final_plan_hash`; missing → `invalid/plan_hash_missing`, different → `invalid/plan_hash_mismatch`.
  Log mode never raises and moves the id to `metadata.sparring_id_unverified`; enforce mode raises.
- `/vtid/allocate` and `/vtid/allocate-internal` accept `plan_hash`; `sparring_id` without it is
  400 `plan_hash_required` (no RPC call); both are forwarded as `p_sparring_id`/`p_plan_hash`.
  A body without `sparring_id` produces the byte-identical 3-arg RPC body as before.
TEST: supabase/tests/vtid_04868_plan_sparring_gate.test.sql
TEST: services/gateway/test/vtid-04868-plan-sparring-migration.test.ts
TEST: services/gateway/test/routes/vtid-04868-allocate-plan-hash.test.ts

AC-19 (finding 3, P1): the 5-arg allocator restores the bounded collision-skipping loop of
`20260628120000` (`FOR i IN 1..1000 … nextval … IF NOT EXISTS … EXIT`, `unique_violation` when no
slot is free), keeps the shell-row shape and `allocator_version 'VTID-0542'`, and pins
`search_path = public, pg_temp`. On local Postgres: when the next sequence values are taken,
allocation skips them; 1000 taken slots fail loudly and insert nothing.
TEST: supabase/tests/vtid_04868_plan_sparring_gate.test.sql
TEST: services/gateway/test/vtid-04868-plan-sparring-migration.test.ts

AC-20 (finding 4, P2): `plan_sparring_append_round(p_session, p_round, p_expected_round)` replaces
the 2-arg RPC. Under `SELECT … FOR UPDATE` it raises SQLSTATE `PS409` (`round_conflict`) unless the
session is `in_progress` and the expected round is the current count + 1. The repository sends the
expected round and treats an RPC error or an `{ ok: false }` reply as a failure; the service maps a
conflict to 409 `round_conflict` on `POST /api/v1/plans/spar/:id/rounds`. Two racing round
submissions: one lands, the other gets 409, the duplicate never lands.
TEST: supabase/tests/vtid_04868_plan_sparring_gate.test.sql
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts
TEST: services/gateway/test/vtid-04868-plan-sparring-repository.test.ts
TEST: services/gateway/test/plans-spar.test.ts

AC-21 (finding 5, P2): the reconciler reads ledger rows without a sparring id in
`[last run, now)` as keyset pages over `(created_at, id)` to exhaustion. 450 rows over 3 pages are
all reported and none is re-reported next run. A failed read leaves the cursor in place. Hitting
the page cap (100 × 200) advances only to the last row read, so the rest is reported next run.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts
TEST: services/gateway/test/vtid-04868-plan-sparring-repository.test.ts

AC-22: the rollback reverses both migrations (5-arg allocator and 3-arg append dropped, the live
pre-VTID-04868 3-arg allocator restored), and both migrations re-apply cleanly afterwards.
TEST: scripts/ci/test-vtid-04868-plan-sparring.sh

ROUTE_MOUNT: `mountRouterSync(app, '/api/v1/plans/spar', plansSparRouter, { owner: 'plans-spar' })` in
services/gateway/src/index.ts. It holds four routes in services/gateway/src/routes/plans-spar.ts:
`POST /`, `POST /:id/rounds`, `GET /:id` (all `requireServiceOrAdmin`) and `POST /:id/approve`
(`requireAdminAuth`).
FINAL_URL: GET https://preview-aws-gateway.vitanaland.com/api/v1/plans/spar/<session-id>
CURL_PROOF:
- Before merge, on staging: `/alive` → `200 application/json`, so the gateway is up. The new route
  `/api/v1/plans/spar/00000000-0000-0000-0000-000000000000` → `404 text/html`, because it is not
  deployed yet.
- After deploy, the same unauthenticated GET must answer `401 application/json`. This is checked by
  staging-tests.json, read-only.

OASIS_PROOF: four new event types in the `CicdEventType` union (services/gateway/src/types/cicd.ts):
- `vtid.plan_sparring.attached` / `vtid.plan_sparring.missing`: emitted once per allocation by
  `/vtid/allocate` and `/vtid/allocate-internal`, carrying `vtid` and `sparring_id` when present.
- `vtid.plan_sparring.break_glass` / `vtid.plan_sparring.tamper_detected`: emitted by the reconciler
  per detection, a state transition and never a heartbeat.

Sparring rounds and approval are stored only on `plan_sparring_sessions`, not in OASIS (design
F3: there is no VTID yet).
