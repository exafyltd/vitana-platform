# VTID-04930 — Plan Sparring record

- Tier: session (gateway tier not live; record kept here per the plan-sparring skill)
- Partner: read-only general-purpose agent on Opus, given the plan-sparring-partner instructions verbatim (the `plan-sparring-partner` agent type was not loaded in this session — the skill's documented fallback). Not the Bedrock Opus 4.6 config value of rule 53.
- Class: standard. Rounds: 3. Verdict: **CONVERGED** (round 3).
- Plan hash (sha256 of the text between the plan markers): `d60bd730d26954125d1cf8f98f8dc14c81623e3acb147edadfa46274aabb1634`
- Owner approval (in session, 2026-10-07): "Approve, build from main" (Option A) and "Approve both" (the two test writes).

## Round summaries (partner findings and planner responses)

**Round 1 — NOT CONVERGED.** False premise: "`DEV_AUTOPILOT_USE_JOB` is not set on production" (AWS-PROD-DEPLOY-GATEWAY.yml:675-680 sets it). Findings:
- F1 [major] `IN("DEEPSEEK_API_KEY","DB_PASSWORD")` breaks vtid-03850:97 → ACCEPTED, separate `!= "DB_PASSWORD"` stage.
- F2 [major] production safety rests on `executorClaimsHere()` (dev-autopilot-execute.ts:3045-3050) → ACCEPTED, `DEV_AUTOPILOT_PROD_CLAIM_ENABLED` verified unset on vitana-gateway-awsdr:155.
- F3 [major] the step-5 writes and the global kill-switch window were unscoped → ACCEPTED, named for owner approval, preconditions, 45-minute cap.
- F4 [major] rollback underspecified → ACCEPTED, revision-27 image URI and the exact command recorded; Option B offered.
- F5 [minor] the 04858 extractor does not match the executor step → ACCEPTED, dedicated extractor asserting a match.
- F6 [minor] stale header comment → ACCEPTED.
- F7 [minor] STAGING-VERIFY evidence is a placeholder → ACCEPTED, read-only post-deploy proof stated.
- F8 [minor] other task families → ACCEPTED as follow-up (12 found, listed in acceptance.md).

**Round 2 — NOT CONVERGED.** F1, F2, F4–F8 closed; F3 acknowledged. New:
- F9 [major] the kill-switch window would also dispatch real members' spec_ready tickets → ACCEPTED, empty-backlog precondition (0 at 2026-10-07).
- F10 [minor] stale risk bullet → ACCEPTED, removed.
- F11 [minor] the 45-minute cap is shorter than one agent run → ACCEPTED, the cap bounds new claims only.

**Round 3 — CONVERGED.** F1–F11 closed; no new blocker or major. Note: record the post-deploy proof (b) as its own result.

## Final plan
<!-- plan:begin -->
## Problem (observed live, 2026-10-06 22:01 UTC)

Staging dispatched Dev Autopilot execution `971de3de` (support-pipeline test ticket
FB-2026-10-000145) to the one-shot ECS executor task. ECS stopped the task before the container
ran: `TaskFailedToStart / ResourceInitializationError: unable to retrieve secret from asm …
rds!cluster-eba8a4f2-3caa-4f11-88f0-c3102c3c176a-QR8ox2 … ResourceNotFoundException`.

The live task definition `vitana-autopilot-executor:27` (registered 2026-09-26) carries five
secrets. A read-only `DescribeSecret` on each found exactly one dead: `DB_PASSWORD`, pointing at
the deleted Aurora managed secret `rds!cluster-eba8a4f2-…`. The other four (SUPABASE_URL,
SUPABASE_SERVICE_ROLE, GITHUB_SAFE_MERGE_TOKEN, DEEPSEEK_API_KEY) exist. The cluster
`vitana-aurora-prod` now has managed secret `rds!cluster-4dab93b8-…`.

So no Dev Autopilot / Operator Console execution can run anywhere today. The last successful
executor runs were 2026-10-01 (288 agent steps, 3 runs held for approval); none since.

VTID-04849 (gateway) and VTID-04858 (orb-agent, verification-engine) already fixed the same dead
reference in their deploy workflows; the executor workflow was missed.

Nothing under `services/gateway/` outside tests reads `DB_PASSWORD` (`git grep`), and the
executor image is built from `services/gateway` (`Dockerfile.job`).

## Change

1. `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`, step "Register new task-definition revision": leave
   the existing DEEPSEEK strip list untouched (vtid-03850:97 pins it) and add a separate stage in
   the same form as the three sibling fixes (gateway:925, orb-agent:118, verification-engine:114):
   `| .containerDefinitions[0].secrets |= [ (. // [])[] | select(.name != "DB_PASSWORD") ]`,
   with a comment naming VTID-04849/04858 and the deleted secret. Correct the stale header
   comment at line 17 ("DB_PASSWORD are live").
2. New pin test `services/gateway/test/vtid-XXXXX-executor-deploy-drops-dead-db-secret.test.ts`,
   modelled on `vtid-04858-agent-deploys-drop-dead-db-secret.test.ts` but with its own extractor
   for the executor step (four `--arg`s across a line continuation), which asserts it found the
   filter; run it with `jq` and every `--arg` the step passes, over a live-
   shaped task definition with DB_PASSWORD + the four other secrets; assert DB_PASSWORD is gone,
   the four others remain (DEEPSEEK_API_KEY once, with the new ARN), image set, read-only fields
   stripped; works with no `secrets` key; `services/gateway` (minus tests) never reads
   DB_PASSWORD. The existing executor pin suites (vtid-03850, vtid-04237, vtid-04223,
   vtid-04764) must stay green.
3. Evidence pack + CHANGELOG row. `staging-tests.json`: the executor has no staging service, so
   it carries the pin suites as an `existing` jest reference plus `/alive`, and says plainly that
   the read-only proof is post-deploy: (a) the new revision has no DB_PASSWORD and every other
   secret exists (`DescribeSecret`), (b) the next real dispatch's ECS task reaches RUNNING, not
   `ResourceInitializationError`.

## Deploy and verify

4. Merge (staging gateway redeploys; no behaviour change there). Then dispatch
   `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` from `main` with a recorded reason (owner approved in
   session). It builds the executor image from `main` HEAD and registers a new task-def revision;
   there is no service to roll. Production does set `DEV_AUTOPILOT_USE_JOB=true`, but it never
   claims executions: `executorClaimsHere()` (VTID-04497, dev-autopilot-execute.ts:3045-3050)
   requires staging or `DEV_AUTOPILOT_PROD_CLAIM_ENABLED=true`, which is unset on the live prod
   task def (vitana-gateway-awsdr:155, checked read-only 2026-10-07). So only the staging gateway
   dispatches the new image. This is the governed path (rule 17: deploy via the AWS-*-DEPLOY-*
   workflows, never a manual `register-task-definition`); a minimal manual re-register of revision
   27's image (375401c8c37d) without DB_PASSWORD is the alternative offered to the owner (Option
   B below), not the default.
   Read-only check after: the new revision has no DB_PASSWORD and its other secrets exist.
5. Re-run the end-to-end test. These are two writes to the shared Supabase project and need the
   owner's explicit approval as such: (i) insert one feedback ticket as the operator-autopilot
   service account (`856c30ed-…`, registered in `service_bot_accounts`; same as FB-143/144/145);
   (ii) set `dev_autopilot_config.kill_switch=false` for one dispatch window, then back to true.
   Preconditions checked read-only immediately before (ii), and the window is not opened unless
   all hold: no execution in queued/cooling/running (true at 2026-10-07: `971de3de` ended
   `failed_escalated`, no self-heal child); `auto_approve_enabled = false`; and the ticket backlog
   is empty apart from the test ticket — no bug/ux_issue ticket in new/triaged/spec_ready with
   `linked_finding_id IS NULL`, placeholder or real spec (0 at 2026-10-07). If any real member
   ticket appears, stop and put it in front of the owner before opening the window. Window start and end recorded in the evidence pack; the switch goes back on as soon as
   the run is held at `awaiting_approval` (branch pushed, no PR — DEV_AUTOPILOT_PR_APPROVAL_REQUIRED)
   or fails. The 45-minute cap bounds new claims only (the switch does not stop a run in progress;
   AGENT_DEADLINE_MS is 35 minutes); a run still going at the cap is followed to its end with the
   switch armed, and a run that has not been claimed by then counts as a failed test. Rule 43: the ticket's reporter is a registered
   service account, the supervisor note marks it as a pipeline test, and the earlier test tickets
   produced no member notification. FB-145 cannot be reused: auto-dispatch only selects tickets
   with `linked_finding_id IS NULL`.

## Options for the owner (image)
- Option A (default, governed): dispatch the workflow from main → executor image = main HEAD
  (≈90 commits of gateway code newer than 375401c8c37d). The workflow fix also stays in force for
  every future executor deploy.
- Option B (minimal, manual): re-register revision 27 with image 375401c8c37d unchanged and only
  DB_PASSWORD dropped: `aws ecs describe-task-definition --task-definition vitana-autopilot-executor:27`
  → jq `.taskDefinition | .containerDefinitions[0].secrets |= map(select(.name!="DB_PASSWORD"))
  | del(read-only fields)` → `aws ecs register-task-definition`. A manual change outside CI
  (rule 17), so only on the owner's explicit choice; the workflow fix still merges for the future.

## Risks
- Option A ships ≈90 commits of executor code at once. Mitigation: the test run is held for
  approval, the step feed shows any failure, and the rollback is Option B's command (same manual,
  owner-approved path), recorded in the evidence pack with the revision-27 image URI.

## Not in scope (reported, separate VTIDs)
- 12 more active task families still load DB_PASSWORD from the deleted secret (read-only check
  2026-10-07): vitana-auth-proxy:5, cognee-extractor:5, conductor:6, memory-indexer:5,
  oasis-operator:5, oasis-projector:9, openclaw-bridge:5, planner-core:6, validator-core:6,
  vitana-memory-indexer:5, worker-core:6, worker-runner:7. Any restart of those services fails to
  start. Reported to the owner as a follow-up; not widened into this VTID.
- auto-dispatch never re-selects a ticket whose first attempt linked a finding.
- the lazy planner and the bridge plan the same finding concurrently (409 on plan v1).
<!-- plan:end -->
