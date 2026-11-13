# VTID-05023 cutover lane

Lane key: `vtid-05023/cutover` (queue slug `vtid-05023`, lane `cutover`). Not the `agentic-delivery/cutover` lane of VTID-05545.

## Claim

- **Status: no claim held.** The earlier claim (`78db61ff`, session `kiro-202611111450-a7d2`) used a session id I generated myself. It was not my real session id. I released it with `queue.mjs release vtid-05023/cutover --session kiro-202611111450-a7d2`, which returned `{"ok":true}`.
- **Real session id:** `KIRO_SESSION_ID` in this environment is `8e42cb36-56f1-4d98-b4e4-96425028a531`.
- **Blocker L-CLAIM:** the queue refuses that id. `queue.mjs claim vtid-05023/cutover --session "$KIRO_SESSION_ID"` fails with `--session <id> is required (session_… or kiro-YYYYMMDDHHMM-xxxx)`. The queue accepts only `session_<alnum>`, `kiro-[seat-]YYYYMMDDHHMM-xxxx`, `agent-…`, `pm-agent` and `ci-plan-spar`. The lane cannot be re-claimed under the real id until the queue accepts UUID session ids or the owner gives this session a queue-format id.
- Work after this point (the compat layer task) is on hold per the instructions: "If you cannot find that id, say so in the lane and stop there."

## Blockers (exact)

| ID | Task | Exact error or state | Next step |
|---|---|---|---|
| B-MR | Open draft MRs for `console-probes-a`, `console-probes-b`, `pm-mode-probes` | The GitLab API via the sandbox gateway returns `400 {"message":"Missing header field, please provide AuthToken"}` for `GET /api/v4/projects/vitana%2Fvitana-platform/merge_requests`. `git push -o merge_request.create` returned `Everything up-to-date` because the branches already exist on the remote. `glab` cannot write its config (`mkdir /root/.config/glab-cli: read-only file system`). | Owner (or a session with GitLab API access) opens the three MRs. Links are in the section below. |
| B-MERGE | Merge the three MRs after CI is green | Depends on B-MR | Same as B-MR |
| B-STAGING | STAGING-VERIFY green on one commit (Phase A acceptance) | Depends on B-MERGE | Watch the deploy after the third merge |
| B-AWS-V1 | `aws sts get-caller-identity` (preflight V1) | `NoCredentials: Unable to locate credentials`. The Kiro role `arn:aws:iam::472838866351:role/kiro-1-dstevanovic` exists, but no permission policies are attached and the sandbox does not get credentials from it. | Owner attaches permissions and confirms the role is registered for this sandbox. |
| B-AWS-C | Phase C (C1 to C9) | Depends on B-AWS-V1 | Start at C1 when V1 passes. |
| B-AWS-D | Phase D (D1 to D4) | Depends on C | Same |
| B-O5 | Migration list for the Aurora apply set (B2) | The handover names a 12 or 13 file list, but the repo does not define it. Owner step O5 is still open. | Owner confirms the list. See Phase B below. |

## Merge requests to open (drafts, target `main`)

- console-probes-a: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/new?merge_request[source_branch]=kiro/staging-verify-manifest-repair/console-probes-a&merge_request[target_branch]=main
- console-probes-b: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/new?merge_request[source_branch]=kiro/staging-verify-manifest-repair/console-probes-b&merge_request[target_branch]=main
- pm-mode-probes: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/new?merge_request[source_branch]=kiro/staging-verify-manifest-repair/pm-mode-probes&merge_request[target_branch]=main

Suggested title and description (VTID-05023, Phase A):
- `Draft: VTID-05023 Phase A: staging gate probe fixes (<lane>)`
- console-probes-a fixes 04887, 04975, 04984, 04999. Commit `42dfc93727`.
- console-probes-b fixes 05003, 05004, 05064, 05069, 05071. Commit `fc46e215a1`.
- pm-mode-probes fixes 05277, 05281 (runner gains `expect_json_in`). Commit `6f73cd6b01`.

## Phase A status

| Task | Status | Evidence |
|---|---|---|
| A1: 12 failing staging gate tests | Fixed on three branches. Not merged. Not verified on staging. | `docs/validation/VTID-04887/console-probes-a-check.log`, `docs/validation/VTID-05064/console-probes-b-check.log`, `docs/validation/VTID-05277/pm-mode-probes-runner-tests.log` |
| A2: track PR #4964 | Not started | |
| STAGING-VERIFY green on one commit | Not run (B-MERGE) | |

## Phase B status

| Task | Status | Evidence |
|---|---|---|
| B1: Aurora-compatibility lint, wired into PR-GATE | Done on this branch. Lint and tests pass (4 of 4). PR-GATE step `Aurora compatibility (changed migrations)` added; YAML parses. The step fails a PR only for migrations it changes. | `scripts/aws/aurora-compat-lint.mjs`, `scripts/aws/test/aurora-compat-lint.test.mjs`, fixtures `scripts/aws/test/fixtures/aurora-compat/{pass,fail}.sql`, `.github/workflows/PR-GATE.yml` |
| B2: run lint over the 12/13 migrations and fix every flagged file | Blocked on B-O5. The lint over all migrations flags 369 of 733 files. Not fixed. | `docs/validation/VTID-05023/aurora-compat-lint-full.txt` (by rule: auth-schema 1198 hits, supabase-role 1700, storage-schema 68) |
| B3: PGlite/pgTAP harness over the set | Not started | |

Held drop `20261102052300_vtid_05573_legacy_messages_drop.sql`: not modified.

### Why B2 is not done

Fixing all 369 flagged files means rewriting `auth.uid()`, `auth.users` and Supabase role grants across hundreds of migrations that were already applied. Each rewrite needs a decision on the replacement (auth_user_fk_map or the auth bridge). The apply set is also undefined in the repo, so B2 is not scoped. Owner step O5 must confirm the list first.

## Phase C and D status (all blocked on B-AWS-V1)

| Task | Blocked by | Exact error |
|---|---|---|
| C1 rehearsal clone | AWS credentials | `aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials.` |
| C2 to C9 | AWS credentials | Same |
| D1 to D4 | AWS credentials and C | Same |

## Owner steps still open

| ID | Step | State |
|---|---|---|
| O1 | IAM check and policy attach | Role `kiro-1-dstevanovic` created. No policies attached yet. |
| O2 | GitLab OIDC trust | Open |
| O3 | Port-4000 security-group rule | Open |
| O4 | Cloudflare token | Open |
| O5 | Confirm migration list | Open. Blocks B2. |
| O6 | Revoke the token exposed in chat | Open |

## Updates

- Claim recorded (`78db61ff`).
- Phase A branches pushed (`42dfc93727`, `fc46e215a1`, `6f73cd6b01`). MR creation blocked (B-MR).
- Phase B1 lint and PR-GATE wiring pushed on this lane branch.
- Phase C and D blocked on AWS (B-AWS-V1).

## Staging changes (owner decisions 1 to 4)

Branch: `cutover/vtid-05023-staging-hygiene` (not merged). Commits: `faa752f20f` (step 1), `0a2b003ae7` (step 3).

### Step 1: remove production Aurora credentials from staging

- Done in repo: `AURORA_DATABASE_URL` and `AURORA_RLS_DATABASE_URL` removed from the add-list and the lookup loop of `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`. The two names stay in the strip list, so a carried-forward copy is removed on deploy. Output: `yaml ok`; deploy-step script passes `bash -n`.
- Not deployed. `AWS-STAGE-DEPLOY-GATEWAY.yml` runs on push to `main` or `workflow_dispatch`. This sandbox cannot push to `main` (branch policy) and cannot dispatch the workflow (no GitLab API token).
- Not verified on a running task. Smoke test not run. Blocker: `aws sts get-caller-identity` → `NoCredentials: Unable to locate credentials`.
- Effect to know before deploy: the staging DB-i18n seam and the Aurora RLS diagnostic (`/api/v1/admin/aurora-rls-health`) lose their connection string and report unconfigured.

### Step 2: align Supabase keys

- Not done. Checking the Secrets Manager entries needs AWS access, which fails with `NoCredentials` (see step 1).
- Repo evidence: the staging workflow binds `SUPABASE_JWT_SECRET` and `SUPABASE_ANON_KEY` from `vitana/supabase/prod/*`. Its comment says staging talks to the production Supabase project through `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE`.
- Consequence: switching the JWT secret and anon key alone would make every token from the production Supabase project fail validation, and logins would break. The URL and service-role key must change in the same deploy. That depends on a staging Supabase project existing, which the repo does not show. Stopped here. Needs owner confirmation of the staging project ref.

### Step 3: plan a staging Aurora cluster

- Done as a plan only: `docs/validation/VTID-05023/plan-staging-aurora.md` (commit `0a2b003ae7`). Covers scope, steps 0 to 6, test plan and rollback.
- Plan PR not opened: blocker B-MR (no GitLab API token). Cluster not created. The plan depends on step 0 (staging Supabase project exists), which is unverified.

### Step 4: `vitana-postgres-staging`

- Not touched. No stop, delete, restore or modify was run.

### Still blocked

| ID | Blocked by | Exact error |
|---|---|---|
| S1-DEPLOY | No deploy path from sandbox | `NoCredentials` for AWS; no GitLab API token for MR or dispatch |
| S1-VERIFY | No running-task access | `NoCredentials` |
| S2 | No Secrets Manager access | `NoCredentials` |
| S3-PR | No MR creation | `400 Missing header field, please provide AuthToken` |

### Lane claim

Still no queue claim. The real session id is `8e42cb36-56f1-4d98-b4e4-96425028a531`, and the queue refuses it (see L-CLAIM above).

## Round 2: staging hygiene, plan and MR !12

### Step 1: plan fixed to a read-only snapshot

- Plan moved to its own branch `plan/vtid-05023-staging-aurora` (cut from `main`), commit `e444cc392b`. File: `docs/validation/VTID-05023/plan-staging-aurora.md`.
- The plan now copies production Supabase with a `pg_dump` snapshot (read-only transaction) using an existing credential the owner names. It has no DMS, replication, logical decoding, publication, slot, role creation or setting change on production.
- The staging gateway switch is step 6 of the plan and is marked as a separate, owner-gated change. It is not executed under this plan, so the staging URL and service-role key do not change.

### Step 2: plan PR

- Opened: MR !13, `plan(VTID-05023): staging Aurora cluster from a read-only Supabase snapshot`, target `main`. Opened by the `merge_request.create` push option on the new branch. Output: `View merge request for plan/vtid-05023-staging-aurora: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/13`.
- CI plan sparring is not yet verified. No AWS resource is created.

### Step 3: MR !12 diff contains only the workflow

- Hygiene branch `cutover/vtid-05023-staging-hygiene` was reset in a new commit (no force push): `51e3f4f63e` reverts lint, PR-GATE, lane and plan files to `main`.
- Output of `git diff --name-only origin/main origin/cutover/vtid-05023-staging-hygiene`: `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`.
- Branch history: `faa752f20f` (remove Aurora secrets from staging workflow), `0a2b003ae7` (earlier plan, now superseded on the plan branch), `51e3f4f63e`.

### Step 4: MR !12 green, merge, staging verification

- Not done. Blocked: the GitLab MR page returns a sign-in page to this sandbox (`https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/12`), and the GitLab API needs an `AuthToken` the sandbox does not have. I cannot read the pipeline status, merge it, or see the deploy.
- Post-deploy check (`AURORA_DATABASE_URL` and `AURORA_RLS_DATABASE_URL` absent from the running task) is not run. Needs AWS credentials: `aws ecs describe-services` and `describe-task-definition` for the staging service. Today: `NoCredentials: Unable to locate credentials`.

### Step 5: `vitana-postgres-staging`

- Not touched.

### Step 6: open items

- **Staging Supabase project does not exist.** Staging still reads and writes production Supabase (`https://inmkhvwdcuyhnxkgfvsb.supabase.co`). Creating a staging project is an owner decision. The staging URL and service-role key stay unchanged. The plan does not depend on it.
- **Owner decision:** which existing read-only credential the plan's `pg_dump` uses (plan step 0).
- **O5:** migration list for the staging restore's drift check (plan step 4).
- **Plan convergence:** MR !13 must converge before any AWS resource is created.
- **Compatibility layer** (round 1 task): not started; blocked on the queue claim.
- **Queue claim:** still not held. The real session id `8e42cb36-56f1-4d98-b4e4-96425028a531` is refused by the queue.

## Round 3: MR !12 merged, staging checks (12 Nov 2026)

Checked from the Kiro sandbox, read-only. Time of checks: about 07:13 UTC, 12 Nov.

### AWS access
- `aws sts get-caller-identity`: account `472838866351`, assumed role `kiro-1-dstevanovic`. Access works now.
- The role has no ECS permissions. Output of `aws ecs describe-services --cluster Vitana-ECS-Cluster --services vitana-gateway`:
  `AccessDeniedException ... User: arn:aws:sts::472838866351:assumed-role/kiro-1-dstevanovic/... is not authorized to perform: ecs:DescribeServices ... because no identity-based policy allows the ecs:DescribeServices action`
- `ecs:ListClusters` is also denied.

### Step 1: staging deploy from MR !12
- Not verified. I cannot see the `AWS-STAGE-DEPLOY-GATEWAY.yml` run (no GitLab API access, and the GitLab remote now returns `403`).
- Indirect evidence: the staging gateway still serves a build that booted before the merge. `GET /api/v1/admin/build-info` returns `git_commit 0dc9a0646a33de0c8cfbad862c44d53fb81e3131`, `booted_at 2026-11-11T18:16:13Z`. The merge was 12 Nov 07:11 UTC. That commit is not in the sandbox's local history, so I cannot tell whether it contains MR !12.

### Step 2: running task
- Blocked by IAM (see AWS access). `AURORA_DATABASE_URL` and `AURORA_RLS_DATABASE_URL` are not verified absent.

### Step 3: staging smoke test (read-only GET, `https://preview-aws-gateway.vitanaland.com`)
- `GET /alive`: `200 application/json` `{"status":"ok","service":"gateway"}`
- `GET /api/v1/admin/health`: `200` `{"ok":true,"env":"staging","supabase_host":"inmkhvwdcuyhnxkgfvsb.supabase.co",...,"booted_at":"2026-11-11T18:16:13.335Z"}`. Staging still uses the production Supabase project, as expected.
- `GET /api/v1/admin/build-info`: `200` `{"ok":true,"env":"staging","git_commit":"0dc9a06…","booted_at":"2026-11-11T18:16:13.335Z"}`

### Step 4: MR !13 (plan)
- Not checked. The MR page returns a sign-in page to the sandbox. `git fetch origin` returns `403` (`resource match not found for entity '472838866351'`). Convergence status unknown.

### Step 5: read-only snapshot of production Supabase
- Not run. Gated on MR !13 converging, and convergence is unverified. No connection was made to production Supabase in this round.

### Step 6: `vitana-postgres-staging`
- Not touched.

### Open items
- **Owner: attach ECS read policy** to `kiro-1-dstevanovic` (at least `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:DescribeTasks`, `ecs:ListTasks`, `ecs:ListClusters`), so the running task can be read.
- **Owner: restore GitLab access for this sandbox** (the remote returns 403). Without it, MR state and pipeline results cannot be read.
- **Staging still uses the production Supabase project.** Creating a staging project is an owner decision.
- **Lane claim not held.** The queue refuses the real session id `8e42cb36-56f1-4d98-b4e4-96425028a531`.

## Round 4: owner instruction (two-day cutover), status after first checks

### Lane claim
- Not held. Real session id `8e42cb36-56f1-4d98-b4e4-96425028a531` is refused by `queue.mjs claim`. `queue.mjs claims` shows no VTID-05023 claim.
- Per the instruction, lane-dependent work stops here until the queue accepts this session's id.

### Step 1: trigger staging deploy from main (AWS-STAGE-DEPLOY-GATEWAY.yml on GitHub)
- Blocked. `GH_Token` is set, but `curl -H "Authorization: Bearer $GH_Token" https://api.github.com/repos/exafyltd/vitana-platform` returns `401`. The workflow cannot be dispatched.
- Context, from GitLab read-only checks (GitLab `vitana/vitana-platform`, project id 2):
  - MR !12 merged 07:11:52 UTC. Merge-commit pipeline 270 (`a3806711a0`) failed in `gateway-jest 2/4` (job 1230).
  - Jest summary: `Tests: 4 failed, 39 skipped, 7221 passed`; `Test Suites: 1 failed`. The failing file is `services/gateway/test/orb/live/upstream/staging-aurora-database-url-pinned.test.ts`, which pins the removed `SEC_AURORA_RLS` wiring.
  - `gateway-staging-build` and `gateway-staging-deploy` were skipped in pipeline 270.
- Dispatching the deploy from a red `main` needs a decision: fix the test (a test change, owner approval needed), or revert MR !12.

### Step 2: Aurora compatibility layer
- Not started in this round. Depends on the lane claim (`compat-objects.md` inventory exists at `docs/validation/VTID-05023/compat-objects.md` only in the earlier local clone; not regenerated here).

### Step 3: gateway REST switch
- Not started. Same dependency.

### Step 4: window runbook
- Not started. Same dependency.

### Step 5: verify-cutover.sh
- Not run in this round. Reading `scripts/cutover/verify-cutover.sh` from `gitlab-migration-prep` is read-only and can be done once the lane is claimed.

### Step 6: MR !13
- `opened`, head pipeline 257 `success`, merge status `unchecked`. Convergence not recorded. Snapshot not run.

### Claude (AWS) items
- Claude must check the running staging task has no `AURORA_DATABASE_URL` or `AURORA_RLS_DATABASE_URL` once the deploy runs. This is not confirmed until step 1 runs.

### Owner decisions needed
1. Fix or revert: the failing staging-aurora pinned test on red `main`.
2. Queue acceptance of the real session id, or an approved id for this lane.
3. GitHub token for `exafyltd/vitana-platform` that returns 200, so the staging workflow can be dispatched.

## Round 5: MR !12 deploy through GitLab (owner decisions 1 to 3)

No GitHub workflow was used. The GitHub token was not used for deploys and is not stored anywhere.

### Step 1: fix the four assertions
- Branch `cutover/vtid-05023-aurora-pin-test`, commit `b46a9f51e0`, from GitLab `main` `a3806711a0`.
- File: `services/gateway/test/orb/live/upstream/staging-aurora-database-url-pinned.test.ts`. Four assertions changed from "pinned" to "not bound"; titles updated. Strip-list test and production test unchanged. No other code changed. MR description says the change was on purpose.
- Local: `npx jest test/orb/live/upstream/staging-aurora-database-url-pinned.test.ts` → `Tests: 6 passed, 6 total`.

### Step 2: pipeline green
- Local full gateway Jest (`npx jest --silent`): `Test Suites: 2 failed, 3 skipped, 1770 passed`; `Tests: 2 failed, 54 skipped, 6 todo, 29697 passed`. Failing suites were environmental in this sandbox: `vtid-04226` needs `openssl` (not installed here); `storage-provider` expects region `eu-central-1` while this sandbox sets `AWS_REGION=us-east-1` (passes with `AWS_REGION=eu-central-1`). Both suites passed in CI pipeline 272.
- MR !14 (`merge_request.create` push): pipeline 272 `success`, all five jobs green.
- Main pipeline 273 (merge commit): `gateway-jest 4/4` failed once with `Tests: 1 failed` in `test/vtid-05005-kiro-dev-tools-mcp.test.ts` (`the session pass › refuses a forged, tampered, cross-environment or garbage pass`, line 38). That test replaces the last two signature characters with `AA`, so it fails when the real signature already ends that way. The signature includes a timestamp, so the failure is random. Not related to this change. Retried once: job 1250 `success`, pipeline 273 green. The flaky test is still in the repo. A fix needs owner approval.

### Step 3: merge
- MR !14 merged 2026-11-12T11:25:09Z, merge commit `5282e7815d0960d4a76619e4a571d8d41ce04830`.

### Step 4: staging deploy on GitLab
- Build job `gateway-staging-build` (1248, manual, played): `success`.
- Deploy job `gateway-staging-deploy` (1249, manual, played): `success`. Job log, key lines:
  - `Rollback target: arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:1006  new image: 472838866351.dkr.ecr.eu-central-1.amazonaws.com/vitana/gateway:5282e7815d09`
  - `New task definition: arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:1007`
  - `Smoke OK: staging serves 5282e7815d0960d4a76619e4a571d8d41ce04830`
  - `Job succeeded`
- Job link: https://gitlab.vitanaland.com/vitana/vitana-platform/-/jobs/1249

### Step 5: running task check (Claude or Kiro, read-only)
- Kiro's ECS read is denied: `AccessDeniedException ... ecs:DescribeTaskDefinition ... no identity-based policy allows`. Not verified from this session.
- Task definition `vitana-gateway:1007` is the one the deploy registered. The deploy job's own jq removes `AURORA_DATABASE_URL` and `AURORA_RLS_DATABASE_URL` and does not re-add them. Claude must confirm on the live task: `aws ecs describe-task-definition --task-definition vitana-gateway:1007` shows no `AURORA_*` names in `environment` or `secrets`. Commit to check: `5282e7815d0960d4a76619e4a571d8d41ce04830`.
- Public smoke (read-only GET): `GET /alive` → `200 {"status":"ok","service":"gateway"}`. `GET /api/v1/admin/build-info` → `git_commit 5282e7815d0960d4a76619e4a571d8d41ce04830`, `booted_at 2026-11-12T11:42:17.733Z`. `GET /api/v1/admin/health` → `env staging`, `supabase_host inmkhvwdcuyhnxkgfvsb.supabase.co` (unchanged, as decided).

### Open items
- Owner approval: fix the flaky `vtid-05005` tamper check (test change).
- Owner approval: the `openssl` and `AWS_REGION` environment issues are local only; no action needed in CI.
- Claude: run the step 5 read-only check on `vitana-gateway:1007`.
- Staging Supabase project: not created (owner decision). Staging still uses production Supabase.
- `vitana-postgres-staging`: not touched.
- Compat layer, REST switch, window runbook, `verify-cutover.sh`: not started (lane claim still refused by the queue).
- GitHub: not used. GitHub `main` still binds production Aurora secrets. Do not dispatch the GitHub staging workflow.

## Round 6: revision 1007 still carried Aurora secrets. Root cause and fix

### Root cause
- `vitana-gateway:1007` (built from `5282e7815d`) still had `AURORA_*` names. MR !12 and MR !15 changed `AWS-STAGE-DEPLOY-GATEWAY.yml`, a GitHub workflow. The job that deploys staging on GitLab is `gateway-staging-deploy` in `infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml`. It copies the previous task definition and changes only the image and SHA. It never stripped Aurora names, so every GitLab deploy carried them forward.
- Job log, deploy 1268 (`fe182590`): `Rollback target: …vitana-gateway:1008`, `New task definition: …vitana-gateway:1009`, `Smoke OK`. Those messages come from this GitLab script, not the GitHub workflow.

### Fix (MR !16, merge commit `a02b8918f3`)
- Strip `AURORA_DATABASE_URL`, `AURORA_RLS_DATABASE_URL`, `AURORA_CA_BUNDLE_PATH` from environment and secrets of every container, in the same jq that sets the image.
- Gate before `register-task-definition`: fail if any `AURORA_` name remains in any container.
- Test `services/gateway/test/vtid-05023-gitlab-aurora-strip.test.ts`:
  - before (unpatched file): `Tests: 2 failed, 2 total`
  - after (patched): `Tests: 2 passed, 2 total`
- Pipeline 278 (MR !16): all five jobs `success`. Pipeline 279 (merge commit): `gateway-jest` 1/4 to 4/4 and `typecheck` `success`.

### Deploy
- Build job 1279 (manual, played): `success`.
- Deploy job 1280 (manual, played), https://gitlab.vitanaland.com/vitana/vitana-platform/-/jobs/1280: `success`.
  - `Rollback target: …vitana-gateway:1009  new image: …gateway:a02b8918f38a`
  - `New task definition: arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:1010`
  - `Smoke OK: staging serves a02b8918f38a57f7b0b6910a365e2a70629d6b89`
  - `Job succeeded`

### Open problem
- The job log does not contain the gate line `Aurora gate: no AURORA_ names …`, and the trace has no output from the gate code. The job did run commit `a02b8918f3`, and that file on `main` contains the gate. I could not find why the gate did not print. So revision `1010` is not confirmed clean.
- Needed: a read-only check of `vitana-gateway:1010`. `aws ecs describe-task-definition --task-definition vitana-gateway:1010` must show no `AURORA_` names in `containerDefinitions[*].environment` or `.secrets`. Kiro's role has no ECS read permission.

### Other
- `vtid-05005` flaky test: not changed.
- Staging Supabase URL and keys: not changed.
- `vitana-postgres-staging`: not touched.

## Local migration classification (PGlite stand-in, not the rehearsal)

Source: every top-level migration on main, applied in name order to a fresh PGlite with the harness shim and base schema. The held drop is excluded. Each failing file is rolled back and the run continues. Output: `tools/logs/pglite-classify.tsv` (outside the repo). Counts: OK 365, FAILED 367, EXCLUDED 1.

| Class | Count | Rule |
|---|---|---|
| bug | 18 | syntax error in the file, index predicate with a non-immutable function, or a column/table created by a later migration (ordering) |
| missing-dependency | 264 | the object is created by an earlier migration that failed or was skipped in this pass |
| environment | 81 | no migration creates the object (the local base is incomplete), or an extension/schema is absent |
| data-state | 4 | a guard in the migration refuses to run without tenant data |

### Bug rows

| File | Reason |
|---|---|
| 20251231000001_vtid_01088_matchmaking_engine.sql | column is_active is added later in 20261102070350_vtid_05493_mt_tenant_archive_switch.sql (ordering) |
| 20251231000001_vtid_01098_memory_timeline_causality.sql | SQL syntax in the file itself |
| 20260116000000_vtid_01179_autopilot_event_loop.sql | index predicate calls a non-immutable function |
| 20260117000000_vtid_01183_worker_agent_connector.sql | SQL syntax in the file itself |
| 20260205000000_fix_oasis_events_disk_io_indexes.sql | SQL syntax in the file itself |
| 20260412400000_seed_maxina_settings.sql | column feature_flags is added later in 20260526060000_VTID_03107_redemption_codes.sql (ordering) |
| 20260412500000_fix_maxina_settings_seed.sql | column feature_flags is added later in 20260526060000_VTID_03107_redemption_codes.sql (ordering) |
| 20260420130000_BOOTSTRAP_ai_usage_log.sql | SQL syntax in the file itself |
| 20260420170000_BOOTSTRAP_seed_ai_policies_fixed.sql | SQL syntax in the file itself |
| 20260421220000_BOOTSTRAP_admin_kpi_surface.sql | SQL syntax in the file itself |
| 20260421230000_BOOTSTRAP_admin_kpi_retention_fix.sql | SQL syntax in the file itself |
| 20260421250000_BOOTSTRAP_admin_insights.sql | SQL syntax in the file itself |
| 20260430120000_BOOTSTRAP_pause_dev_autopilot_auto_approve.sql | SQL syntax in the file itself |
| 20260501000000_VTID_02639_autopilot_finding_completed_state.sql | SQL syntax in the file itself |
| 20260501010000_VTID_02640_dev_autopilot_get_table_schema.sql | SQL syntax in the file itself |
| 20260502120000_vtid_02690_seed_orb_agent_google_cascade.sql | agent_voice_configs is created later in 20260507100000_vtid_livekit_foundation_voice_tables.sql (ordering) |
| 20260522010000_chat_group_members_recursion_fix.sql | chat_group_members is created later in 20260525000000_VTID_03089_chat_groups.sql (ordering) |
| 20260524000000_VTID_03036_bootstrap_cache.sql | SQL syntax in the file itself |

Caveat: the rehearsal log is not in this sandbox. The local base lacks production tables, so the missing-dependency and environment counts overstate what fails on the rehearsal. The bug rows are the ones to check first.

## Steering run: non-migration merges, staging verification, held items

### Merged
- **MR !34** (psql session-setting strip in `aurora_sql_split.py`, with tests). Draft prefix removed, title `VTID-05023 apply path blanks psql session settings (\set, \echo)`. Pipeline 350 on the merge commit: typecheck and all four gateway-jest shards `success`. Merge commit `b48f95b2df52e36b3f7256ee76e560cb5d032db2`.

### Staging deploy of the merge commit
- Build job 1820 (manual, played): `success`.
- Deploy job 1821, https://gitlab.vitanaland.com/vitana/vitana-platform/-/jobs/1821: `success`.
  - `Rollback target: …vitana-gateway:1015  new image: …gateway:b48f95b2df52`
  - `New task definition: …vitana-gateway:1016`
  - `Smoke OK: staging serves b48f95b2df52e36b3f7256ee76e560cb5d032db2`

### STAGING-VERIFY on the merge commit
- The `staging-verify:gateway` job is defined in the CI template but is not in pipeline 350. The pipeline was built from a config that does not include it. So no GitLab run link exists for this commit.
- Ran the repo runner instead, read-only: `node scripts/ci/staging-verify/run.mjs verify --service gateway --sha b48f95b2df52e36b3f7256ee76e560cb5d032db2 --repo-root . --out <out dir>`. Run from the full clone (a copy without git history fails the production-baseline check, a setup error, not a staging result).
- Result: **Staging verified. Tests 12/12 passed.** Smoke: alive, admin health reports staging, build-info, ORB, Nova Sonic, autopilot, VTID ledger, scheduler, operator, OASIS tasks, community members requires auth, publish route rejected-write probe. Output in `tools/logs/sv-out2/` (outside the repo: `results.json`, `message.md`).
- Production baseline `c7e17d64d9ec`, range 1 commit, none touching the gateway.

### MR state (all draft unless stated; nothing merged except !34)

| MR | Content | State | Pipeline |
|---|---|---|---|
| !34 | psql session-setting strip (non-migration) | **merged** `b48f95b2df` | success |
| !41 | F1 record (docs) | draft, not merged | success |
| !35 | F3 autopilot index immutable (migration, held) | draft, not merged | success |
| !36 | fix memory_timeline `window` identifier (migration, held) | draft | success |
| !37 | fix worker_agent_connector policy syntax (migration, held) | draft | success |
| !38 | fix oasis_events_disk_io_indexes dollar quote (migration, held) | draft | success |
| !39 | fix ai_usage_log dollar quote (migration, held) | draft | success |
| !40 | fix bootstrap_cache comment (migration, held) | draft | success |
| !28 | welcome-chat trigger (migration, held) | draft | **failed**, fix forward needed, not done |
| !32 | welcome skip test (test, stacked on !28) | draft | **failed**, fix forward needed, not done |
| !33 | allowlist baseline (migration, held, RLS owner question) | draft | **failed**, fix forward needed, not done |
| !42 | skip manifest (docs, not applied by any tool) | draft, not merged | — |

### Gate
- Migrations do not merge until the owner confirms the Supabase integration check. Repo search of workflows and CI includes: no job applies migrations on a push to `main`. `RUN-MIGRATION.yml` is dispatch-only. The three push-triggered SQL workflows say they never run against Supabase. External Supabase integration: not visible from the repo; owner to confirm.

### Held items (keep in list)
- `vtid_specs` rename
- nav dedupe
- column additions (the 01088 second graph model, see decision below)
- `encrypted_password` drop
- `tenants(id)` key
- 01088 matchmaking: **owner decision, option c**. Leave failing on a fresh database. Owner check on production: whether `relationship_edges` has `source_user_id`, `target_user_id`, `edge_type`, and whether the matchmaking functions exist.

### Owner decisions
1. Skip-manifest mechanism (MR !42): apply tool reads the manifest, or a manual skip with a logged list.
2. Supabase integration check: confirm no external integration applies migrations to production on merge.
3. 01088 matchmaking: option c, owner production check.
4. RLS on `notification_test_actors` and `service_bot_accounts` (MR !33), before any merge.
5. Whether a draft's `Draft:` prefix is removed to merge it (applies to !35 to !40 once the gate is cleared).

### Not done in this run
- Fix-forward for the three failing pipelines (!28, !32, !33).
- Rehearsal-pass counts: not in this sandbox.
- Pending-migration list check (task 3) and the staging switch for the runbook (task 4): inputs not yet received.
