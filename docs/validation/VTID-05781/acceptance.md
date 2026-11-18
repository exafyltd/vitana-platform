# VTID-05781 — autonomous-to-staging-r2, lane `staging-cutover`

Plan `.kiro/specs/autonomous-to-staging-r2/plan.md` §3.4 (stage 3), decision record `design.md` §3, §4, §6, §8, §9.
Session `kiro-exafy-202611110920-270b`. Owner directive 2026-11-12: *"approval to revise and validate the plan, not
approval to incur infrastructure costs or execute the database provisioning and cutover"*; *"Do not switch staging away
from its current authentication or database configuration until a safe, reversible transition is demonstrated."*
This lane is code, tests and docs only: no AWS call was made, nothing was deployed or dispatched, no secret was read or
written, no production credential or role was used. Nothing is flipped by this lane. Runbook, rollback/recovery
criteria and impact: `runbook.md`.

## What changed
- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`: two marked blocks each
  (`# >>> VTID-05781` … `# <<< VTID-05781`, 10 lines per file) in the roll step: map `vars.STAGING_DATA_PLANE` /
  `vars.STAGING_CUTOVER_APPROVED`, and call `scripts/aws/staging-cutover-select.sh` only when the plane is not shared or
  the live task definition carries the isolated marker.
- `scripts/aws/staging-cutover-taskdef.mjs` (the switch, pure), `staging-cutover-select.sh` (resolves the staging-db secret
  ARNs, approval check), `staging-cutover-ecs.sh` (record / flip / rollback / verify / candidate-*; name guards),
  `staging-cutover-gate.mjs` (flip preconditions), `staging-cutover-smoke.mjs` (STAGING-VERIFY gateway smoke against one
  base URL, read-only), `staging-cutover-secrets.sh` (fills the two placeholder secrets of the stage-2 stack).
- `.github/workflows/AWS-STAGE-CUTOVER-REHEARSAL.yml` (dispatch: secrets / register / run on the `-iso` candidates) and
  `.github/workflows/AWS-STAGE-CUTOVER.yml` (dispatch: flip with automatic rollback, recover, manual rollback). No
  schedule, no push trigger.
- `scripts/ci/staging-db/impact.mjs` + `impact-classification.json` (task T4).
- Tests `scripts/ci/staging-db/cutover-{taskdef,ecs,gate,workflows}.test.mjs`, fixtures `scripts/ci/staging-db/fixtures/cutover/`
  (pinned copies of the two deploy workflows at origin/main `bb15274201`, staging-shaped task definitions, stub AWS CLI).

## Acceptance criteria → tests

AC-1 `shared` (variable unset, empty or `shared`) produces the pinned task-definition inputs: the roll steps, rendered and run with a stubbed AWS CLI, register a task definition byte-identical to the pinned (pre-lane) steps; outside the marked blocks the steps are the pinned steps; an unmarked task definition passes the switch byte for byte.
TEST: scripts/ci/staging-db/cutover-workflows.test.mjs ("AWS-STAGE-DEPLOY-GATEWAY.yml: with STAGING_DATA_PLANE unset, empty or shared the registered task definition is byte-identical to the pinned step's"; the same for AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml; "deploy workflows: exactly the marked blocks were added to the roll step; without them the step is the pinned one"; "deploy workflows: the switch reads the repository variables and calls the select script only off the shared path")
TEST: scripts/ci/staging-db/cutover-taskdef.test.mjs ("shared: an unmarked task definition passes through byte for byte (gateway, postgrest, compact and pretty)"; "round trip: shared(isolated(x)) is x exactly (same JSON text), for both services"; "re-deploy while isolated: a shared deploy refresh followed by isolated again stays isolated with one marker")
TEST: scripts/ci/staging-db/cutover-ecs.test.mjs ("select: unset / empty / shared + unmarked = the same bytes, no AWS call")

AC-2 `isolated` names no production identifier outside the unchanged authentication entries (staging-prod-ref-guard identifiers, `--enforce` semantics); any other production-bound entry refuses the switch; authentication is unchanged; the gateway runs with `VTID_ALLOCATOR_ENABLED=false`; isolated deploys need `STAGING_CUTOVER_APPROVED=yes`; unknown plane values fail closed.
TEST: scripts/ci/staging-db/cutover-taskdef.test.mjs ("isolated names no production identifier outside the unchanged auth entries (guard scanText, --enforce semantics)"; "isolated gateway: data-plane secrets move to the staging database, auth entries are unchanged, allocator off"; "isolated postgrest: …"; "refuses an unknown production-bound entry"; "refuses a production family"; "refuses a production ARN passed as the staging one"; and 10 more refusals)
TEST: scripts/ci/staging-db/cutover-workflows.test.mjs ("…: STAGING_DATA_PLANE=isolated without STAGING_CUTOVER_APPROVED=yes fails the step and registers nothing"; "…: STAGING_DATA_PLANE=isolated with approval registers the staging-db references; shared afterwards restores the shared plane"; "…: an unknown STAGING_DATA_PLANE value fails closed"; "gateway: isolated needs data_backend=keep")
TEST: scripts/ci/staging-db/cutover-ecs.test.mjs ("select: isolated refuses without STAGING_CUTOVER_APPROVED=yes; …"; "select: an unknown plane value is refused (fail closed)"; "select: isolated with approval resolves only the staging-db secret ARNs (describe-secret, never get-secret-value)"; "select: a staging-db secret that cannot be described refuses; nothing on stdout")
Evidence: `node scripts/ci/staging-prod-ref-guard.mjs --enforce` over every new script and workflow → 0 references (outputs/guard-enforce-cutover.txt); the default report is unchanged at 35 (outputs/guard-report.txt).

AC-3 The flip refuses without a passing rehearsal (mode run) on the same commit on main within 7 days, without `STAGING_CUTOVER_APPROVED=yes`, with `PLAN_SPAR_GATEWAY_URL` not the production gateway, with `STAGING_DATA_PLANE` not shared, without the client SG, while a staging deploy or STAGING-VERIFY runs, or with an unclassified or unresolved governance caller / an in-flight lane suite that reads data rows.
TEST: scripts/ci/staging-db/cutover-gate.test.mjs ("gate: allowed when every precondition holds"; 17 "gate refuses: …" cases; "impact: every workflow naming the staging gateway is classified on this checkout, and no classification is stale"; "impact: PLAN-SPAR and VTID-ALLOCATE block until PLAN_SPAR_GATEWAY_URL is the production gateway; owner acceptance cannot unblock them"; "impact: an acceptable governance-signal writer blocks until the owner lists it"; "impact: a new, unclassified workflow that names the staging gateway blocks the flip (temp repo)"; "impact: suites are classified; an in-flight lane suite that reads data blocks, a done lane suite does not")
TEST: scripts/ci/staging-db/cutover-workflows.test.mjs ("AWS-STAGE-CUTOVER.yml: dispatch only, gate, record → flip → verify → smoke → automatic rollback, recover, manual rollback"; mutations "cutover: gate script removed", "cutover: PLAN_SPAR_GATEWAY_URL not passed", "cutover: approval not passed", "cutover: flip without the gate", "cutover: flip runs main instead of the rehearsed commit")

AC-4 Rollback restores the recorded revisions (and network configuration) on a forced failure, with a stubbed AWS CLI; a half-done flip is rolled back too; the workflow runs the rollback on any failure after the record and re-checks with the smoke.
TEST: scripts/ci/staging-db/cutover-ecs.test.mjs ("ecs: rollback after a forced post-flip failure restores both recorded revisions and network configurations"; "ecs: a failed flip half-way (gateway rollout FAILED) is still rolled back to the record"; "ecs: verify fails when a service is not on the expected revision"; "ecs: record writes both live PRIMARY revisions and network configurations, and changes nothing"; "ecs: flip refuses without approval, with a bad SG, or when a service moved since the record (no update-service)")
TEST: scripts/ci/staging-db/cutover-workflows.test.mjs (mutations "cutover: automatic rollback removed", "cutover: smoke after flip removed", "cutover: flip before record", "cutover: recover dispatches a production deploy")
TEST: scripts/ci/staging-db/cutover-gate.test.mjs ("smoke: the STAGING-VERIFY gateway suite passes against a healthy candidate"; "smoke: a failing check is retried, then fails the run (cold start vs. real failure)"; "smoke: a production host is refused before any request; a write is never sent")

AC-5 Nothing is flipped by this lane; the rehearsal touches only the `-iso` candidates (always scaled back to 0), the flip only the two live staging services; production services are refused by name; only the staging roles are used (OIDC, no static keys, no production role, no repository secret); no schedule or push trigger.
TEST: scripts/ci/staging-db/cutover-workflows.test.mjs ("AWS-STAGE-CUTOVER-REHEARSAL.yml: dispatch only, owner gate, staging roles only, candidates only, always scaled to 0"; 12 rehearsal and 14 cutover mutation cases)
TEST: scripts/ci/staging-db/cutover-ecs.test.mjs ("ecs: flip rolls only the two live staging services …"; "ecs: candidate-register registers -iso families only and changes no service"; "ecs: candidate start/stop touch only the -iso services; stop leaves desired count 0"; "ecs: candidate-start refuses a registered revision of a live family"; "ecs: name guard (guard subcommand) — production names refused, live and candidate scopes are disjoint"; "ecs: wrong AWS account is refused before any ECS call")
TEST: scripts/ci/staging-db/cutover-taskdef.test.mjs ("candidate (rehearsal): -iso family, candidate URLs, background loops off, merge token dropped, -iso proxy URL")

AC-6 (stage-2 hand-over) The two placeholder secrets are filled by an owner-gated rehearsal mode with the staging database role only: dedicated login roles, values from a 0600 file, never printed; idempotent; refused for a non-staging cluster, an untagged cluster, a foreign endpoint or without the cost approval; `--plan` makes no AWS call.
TEST: scripts/ci/staging-db/cutover-ecs.test.mjs ("secrets: --plan makes no AWS call; a non-staging cluster and a missing cost approval are refused before any AWS call"; "secrets: fills both placeholders from the cluster endpoint with dedicated roles; never prints a password"; "secrets: idempotent (already set = nothing changed); untagged or foreign-endpoint clusters are refused")

Red on base: `outputs/red-on-base.txt` (origin/main `bb15274201` + these tests and fixtures: 34 tests, 32 fail; the 2 that pass
are the byte-identity tests, which on base compare the pinned step with itself — the shared path is unchanged by
definition there). Green: `outputs/green.txt` (107/107). All `scripts/**` tests (UNIT.yml file set): 1628 tests, 1622
pass, 0 fail, 6 skipped (`outputs/unit-all-scripts.txt`). Mutations: 24, each fails at least one test
(`outputs/mutation-*.txt`).

## Decisions taken
- **One switch, two existing workflows, minimal diff.** The roll step is the only place touched (10 lines per file, in
  marked blocks), after `taskdef-data-backend.py` and before `register-task-definition`. With the variable unset and an
  unmarked live task definition the block does nothing; the byte-identity test runs the pinned and the new step.
- **Isolated is reversible from the task definition itself.** The switch stores what it changed in two env entries
  (`STAGING_DATA_PLANE=isolated`, `STAGING_DATA_PLANE_SHARED` = base64 JSON of the changed/removed entries). A later
  shared deploy restores entry by entry, keeping values the deploy's own jq step refreshed. So "set shared and redeploy"
  is a real rollback path, not only "redeploy and hope".
- **Authentication carve-out.** The plan's "isolated names no production identifier" conflicts with the owner's "do not
  switch staging away from its current authentication": the GoTrue issuer is production. The entries of
  `AUTH_UNCHANGED` (JWT secret, anon key, service-role key, `GATEWAY_SERVICE_TOKEN`, `SUPABASE_PUBLIC_URL`,
  `SUPABASE_AUTH_HOST`, `PGRST_JWT_SECRET`) are left exactly as they are and are the only entries allowed to name
  production; every other entry is guard-checked and an unknown production-bound one refuses (fail closed, not guessed).
- **The isolated gateway requires the PostgREST proxy path** (`SUPABASE_URL` = `vitana/supabase/staging/url-aurora-proxy`,
  `SUPABASE_PUBLIC_URL` present, i.e. `data_backend=aurora` on the shared plane first). Without it the gateway's REST
  traffic would still reach production Supabase; the switch refuses rather than leave a half-isolated gateway.
- **The flip deploys from the recorded live task definitions, not by dispatching the deploy workflows.** GITHUB_TOKEN
  cannot set repository variables, and the automatic rollback must run in the same job. The owner sets
  `STAGING_DATA_PLANE=isolated` after a green flip; until then the next deploy restores shared (safe default).
- **Candidate isolation beyond the data plane.** The `-iso` gateway runs with the background loops off and without the
  GitHub merge token, so a second staging gateway never acts on GitHub or on members.
- **OIDC only in the new workflows.** They assume `vars.AWS_STAGING_ROLE_ARN` (the staging deploy role) or
  `vars.AWS_STAGING_DB_ROLE_ARN` (secrets mode), never the static staging keys or the production role, and refuse when
  the variable is unset. The existing deploy workflows' credential steps are untouched.
- **Rehearsal = STAGING-VERIFY gateway smoke, run against one base URL.** `STAGING_TARGETS` is fixed in
  `scripts/ci/staging-verify/lib.cjs` (outside this lane), so `staging-cutover-smoke.mjs` runs the same `smoke/gateway.json`
  with the same `evaluateHttp`/`httpRequestInit` and the same production-host refusal. A first version ignored
  `evaluateHttp`'s return shape (`{ ok, problems }`) and would have passed everything; the smoke test caught it.
- **Impact classification is data, reviewed in the PR** (`impact-classification.json`): 19 workflows name the staging
  host; ledger writers (PLAN-SPAR, VTID-ALLOCATE) can only be resolved by pointing them at production; seven
  governance-signal writers can be redirected or accepted by the owner (`STAGING_CUTOVER_IMPACT_ACCEPTED`). Suites:
  in-flight lanes = executing, in-review, verified (8 needs-review today).
- **Dedicated database roles** (`vitana_staging_app` with `rds_superuser`, mirroring the production admin URL class on
  synthetic data; `authenticator` NOINHERIT, NOSUPERUSER, NOBYPASSRLS): the RDS-managed master password rotates, so it is
  never put in a URL. Passwords are 48 hex characters from `/dev/urandom` (no `openssl` dependency).
- **No schedule triggers** (loop catalog untouched). One concurrency group `aws-stage-cutover` for rehearsal and flip.

## Not done here (owner actions, other lanes, or outside this lane's paths)
- Owner actions in order: `runbook.md` §2 (stage 2 first; IAM additions; `AWS_STAGING_ROLE_ARN`; rehearsal secrets →
  register → stack apply with the candidate parameters + DNS → `url-aurora-proxy-iso` secret → rehearsal run;
  `PLAN_SPAR_GATEWAY_URL`; impact acceptances; `STAGING_DB_CLIENT_SG_ID`; `STAGING_CUTOVER_APPROVED`; flip; then
  `STAGING_DATA_PLANE=isolated`).
- Outside the lane's paths (reported, not edited): `infra/staging-db/stack.yaml` gives `vitana-postgrest-aurora-staging-iso`
  no service-discovery entry, so the candidate gateway needs a reachable URL for the candidate PostgREST (owner creates
  `vitana/supabase/staging/url-aurora-proxy-iso`; a stack change adding a Cloud Map service would make it automatic);
  `scripts/aws/iam/eng-platform-oidc-staging-deploy-policy.json` lacks the design §4 cutover additions; the isolated seed
  should keep the DB control `vtid_allocator_enabled` off (the env flag alone does not disable the allocator when the
  control is on, `services/gateway/src/services/system-controls-service.ts:417-430`); `docs/STAGING.md` should link `runbook.md`.
- Not isolated by this switch (unchanged, documented): `/auth`, `/storage`, `/functions`, `/realtime` pass through the
  proxy to production Supabase.
- Not verified against AWS: every AWS step runs only after the owner actions; each refuses closed.

Staging: this lane's merge redeploys the gateway and the proxy on the shared plane (both workflows are in their own
push paths). `staging-tests.json` proves the shared plane serves as before (read-only).
