---
change_class: standard
---
# plan(agentic-delivery): one delivery process for dozens of agents, on our own GitLab, supervised in the Command Hub

Author: Kiro, seat `exafy`, session `kiro-exafy-202611041929-802c` (Kiro Web), for pickup by
`kiro-exafy-202611021438-cff7`. Premises are pinned to vitana-platform `origin/main`
`4066f563e7232237f77c44469c77924b94d1e098` (the base of this PR) and vitana-v1 `origin/main`
`7829ef2f2ef12364862961d339161229c286d6f0` (`spar_refs` in handoff.md). Queue numbers were read on 2026-11-04 between
19:40 and 20:10 UTC with read-only GitHub REST calls. This plan builds on `eng-gitlab-m1` (PR #4677: the running GitLab),
`eng-gitlab-m2` (PR #4667: fleet, settings, merge bot, webhook route, monitoring, rehearsal on the Free tier),
`e2e-autonomy` (PR #4678: the host-neutral autonomy rule), `eng-platform-p01` (merged: keyless staging roles and
`docs/ENGINEERING-PLATFORM-PLAN.md`) and `operating-workflow` (approved, not built). Files of those plans that are not
on `main` are named by plan section, not by `file:line`. It is milestone 3 of program `engineering-platform`.

<!-- plan:begin -->
## 1. Summary
- GitHub stops being where work waits. vitana-v1 moves to our own GitLab first (wave 1). The gateway's GitHub calls and
  vitana-platform follow (wave 2). The self-healing and self-improving loops come last (wave 3). GitHub ends as a
  read-only mirror and is then archived.
- For agents: a push gets its first check result in about 3 minutes, from a throw-away machine that holds no secret. A
  merge bot lands reviewed, green work one change at a time. Every landing deploys to staging and runs STAGING-VERIFY.
  A failure becomes a repair task, tried at most 3 times.
- For the owner: nothing to approve on the way. One staging summary per finished change, the PUBLISH button for
  production, and one new Command Hub screen, Delivery, that shows the merge queue, pipelines, releases and cost.
- The VTID ledger and OASIS stay the single record of all work. Every step on GitLab writes an OASIS event with its
  VTID, and the Command Hub reads only the ledger and OASIS.
- Each wave has numbers it must reach before the next starts (§8): time to first check result, accept to main,
  landings per hour, STAGING-VERIFY pass rate, change failure rate, time to restore and AWS cost per day (§10).

## 2. Today
### 2.1 The flow and where the time goes
A change goes `plan(` PR → PLAN-SPAR → VTIDs → lanes → reviewer agent → merge under `collaboration.md` §7b → staging
deploy → STAGING-VERIFY → Gate 2 → PUBLISH. Every step runs on GitHub Actions or the GitHub API, in one runner pool
that both repositories share.

| Measure (2026-11-04) | vitana-platform | vitana-v1 |
|---|---|---|
| Runs queued now | 322 (28 running) | 1 |
| Queued runs from `pm-agent/*` branches, of 308 sampled | 303 | – |
| Queued runs that are ENFORCE-FRONTEND-CANONICAL-SOURCE (85) or PHASE-2B-NAMING-ENFORCEMENT (77) | 53 % | – |
| Wait for a runner, 27 jobs of 16 runs since 11-01 | – | p50 11.1 min, p90 28.1 min |
| Run time of the same jobs | – | p50 1.8 min, p90 3.7 min |
| Wall time of PR-GATE runs (41) | – | p50 54.9 min |
| PRs merged 10-28 to 11-04 | 137 (most in a day: 24) | 48 (most in a day: 16) |
| Open PRs | 115 | 35 |

A vitana-v1 job waits about six times longer for a machine than it runs. The wait comes from the shared pool, which the
platform's bookkeeping fills:
- The Project Manager writes one commit per file through the Contents API
  (`services/gateway/src/services/project-manager/writers.ts:150-156`) on `pm-agent/<slug>` branches, each with its own
  PR (`writers.ts:130-143`). The staging gateway runs it live (`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1228-1229`).
- Each such push starts 6 runs and 8 jobs. ENFORCE-FRONTEND-CANONICAL-SOURCE runs on every PR
  (`ENFORCE-FRONTEND-CANONICAL-SOURCE.yml:4`) with a full gateway install and build. Neither it nor
  PHASE-2B-NAMING-ENFORCEMENT (`PHASE-2B-NAMING-ENFORCEMENT.yml:3`) cancels a superseded run.
- Landing is serial by rule (`collaboration.md` §8a item 3) and each update of a branch re-runs its checks, so every
  landing pays the queue wait again.

The GitHub-side fixes in flight (pipeline-speed VTID-05535 PR #4674, ci-superseded-pr-runs, operating-workflow lanes
`pm-noop` and `ci-activity-guard`, ci-queue-flood-r2) stay useful until each repo's cutover. This plan edits none of
their files (§9).

### 2.2 Workflow families and their fate
There are 159 workflow files: 113 in vitana-platform and 46 in vitana-v1. Their triggers: 60 `pull_request`, 1
`pull_request_target`, 42 `push`, 31 `schedule`, 134 `workflow_dispatch`, 4 `workflow_run`, 5 `repository_dispatch`.
14 build and push images. 29 assume an AWS role. 12 reference the stored `AWS_STAGING_*` keys: 11 only when the role
variable is unset, and vitana-v1 `AWS-PROD-DEPLOY-FRONTEND.yml:172-173` always. They use 37 stored secret names plus
the built-in `GITHUB_TOKEN`. The per-file list with trigger lines is `inventory.md` in this folder. This table is
binding. Templates T1 to T7 are defined in §3.3.

| Repo | Family (files) | What it does | Fate |
|---|---|---|---|
| v1 | PR-GATE, UNIT-TESTS, STAGING-TESTS-REQUIRED, i18n-check, CALENDAR-REGRESSION, NATIVE-CI, SQL-* (4) | checks on PRs | T1, plus the full suite in T2 and T3, at wave 1. Disabled on GitHub at the v1 cutover. PR-GATE is a protected gate file: it is disabled, and deleted later only on the owner's instruction naming the plan |
| v1 | AWS-STAGE-DEPLOY-FRONTEND | image, ECR, staging ECS, then it starts STAGING-VERIFY (`AWS-STAGE-DEPLOY-FRONTEND.yml:319-321`) | T2 at wave 1 |
| v1 | PREVIEW-DEPLOY-FRONTEND, PREVIEW-TEARDOWN-FRONTEND, E2E-PREVIEW-ORB | per-PR previews on S3 and CloudFront | T4 at wave 1 |
| v1 | I18N-PROPAGATE, i18n-translate, i18n-audit-llm, i18n-long-words, WHATS-NEW-DRAFT | jobs that write to a branch or open a PR | T7 at wave 1 |
| v1 | SCREENS-CATALOG-TRIGGER | tells platform to rebuild the screens catalog | a T2 job at wave 1; a GitLab pipeline trigger at wave 2 |
| v1 | AWS-PROD-DEPLOY-FRONTEND, DEPLOY | production frontend (PUBLISH) | kept on GitHub, dispatch only, until wave 2, then T5. Protected |
| v1 | supabase-functions-deploy, SUPABASE-FUNCTIONS-RETIRE, apply-*-migration (21) | production edge functions and owner-approved migrations | kept on GitHub, dispatch only, until wave 2, then T6 owner-dispatched jobs (one migration job that takes the file; applied one-offs retired) |
| v1 | STAGE-DEPLOY-FRONTEND | Cloud Run era | retired |
| platform | PR-GATE, UNIT, TEST-SUITE, CICDL-* (3), OASIS-PERSISTENCE, VALIDATOR-CHECK, COMMAND-HUB-GUARDRAILS, CI-SCRIPTS-TEST, AURORA-* (2), VOICE-* (2), ORB-TOOLS-LIFT-SCANNER, CALENDAR-REGRESSION, DEV-AUTOPILOT-IMPACT, VCAOP-GUARDRAILS-CI, STAGING-TESTS-REQUIRED, MIGRATION-DRIFT-CHECK, SQL-* (21) | checks on PRs | T1 plus the full suite at wave 2. PR-GATE: a GitLab twin is built beside it and PR-GATE.yml is retired at the platform cutover on the owner's instruction naming the plan |
| platform | ENFORCE-FRONTEND-CANONICAL-SOURCE, PHASE-2B-NAMING-ENFORCEMENT, PHASE-2B-DOC-GATE | gateway build and validator, naming, phase_2b docs | T1 checks that run only when their own files change, with the same rules, at wave 2. "validate" is a required status on `main` today (`DAILY-STATUS-UPDATE.yml:60`) |
| platform | PLAN-SPAR | sparring and VTID allocation | kept until wave 2; a GitLab twin beside it; retired at the platform cutover on the owner's instruction naming the plan (protected) |
| platform | AWS-STAGE-DEPLOY-* (4) | staging image and deploy | T2 at wave 2 |
| platform | AWS-PROD-DEPLOY-* (9), VISUAL-VERIFY-FRONTEND | production deploy, post-publish check | kept until wave 2, then T5. AWS-PROD-* are protected: retired at the platform cutover on the owner's instruction naming the plan |
| platform | STAGING-VERIFY, STAGING-VERIFY-NIGHTLY, VTID-AUTO-CLOSE | verification and VTID close | the vitana-v1 part moves to T2 and T3 at wave 1 with the same scripts; the platform part at wave 2 |
| platform | ALERT-* (7), CRON-* (3), E2E-ORB-MONITOR, MORNING-SYSTEM-HEALTH-CHECK, SCREEN-LOAD-* (2), EXERCISE-STAGING-SHADOW* (2), MARKETPLACE-SYNC-CRON, DEV-AUTOPILOT, VCAOP-HEALTH, TENANT-RESERVED-SLUGS-DRIFT, SMOKE-WELCOME-GREETING, CI-HEALTH, DAILY-STATUS-UPDATE, TEST-CATALOG, CODEINTEL-INDEX | schedules, health checks, reports, index builds | kept until wave 2, then T6 (scheduled) or T2 (after landing) |
| platform | RUN-MIGRATION, AWS-PROD-SETUP-* (2), AWS-PROVISION-* (2), AWS-OPS-ECS-SCALE-UNGOVERNED, AWS-REHEARSAL-AURORA-CLONE, AWS-STAGING-VALIDATION, SET-STAGING-TENANT-CONSENT, SETUP-OPERATOR-MEDIA-BUCKET, JOURNEY-TRANSLATIONS-BACKFILL, BOOTSTRAP-CLOUDFLARE-KV, ANDROID-DEVICE-E2E, MOBILE-DEVICE-E2E, E2E-TEST-RUN, OPS-TOGGLE-FLOW-V3-STAGING | owner-run operations | kept until wave 2, then T6 owner-dispatched jobs; migrations keep §7d |
| platform | I18N-DB-SEED, REGEN-SCREENS-CATALOG, APPLY-FB061-DEBOUNCER-FIX | jobs that open PRs or push | kept until wave 2, then T7 (the one-off is retired when applied) |
| platform | DEPLOY-CLOUDFLARE-WORKERS | production Workers on every push to `main` | kept until wave 2. Whether it stays automatic or moves under PUBLISH is an owner decision in the wave 2 plan |
| platform | DRIVER-WAKE, TEST-SUITE-RERUN, REUSABLE-NOTIFY | wake drivers, re-run after runner loss, shared step | retired at wave 2: GitLab events wake drivers through the gateway, GitLab retries runner failures, templates replace the step |
| platform | AUTO-DEPLOY, VTID-02409-BOOTSTRAP, VCAOP-CICD | GCP-era and dead paths | retired |

### 2.3 Gateway files and scripts that need a Git-provider layer
53 gateway files touch GitHub: 43 make the calls themselves, 7 wire them, and 3 only carry GitHub-named topics. No
gateway file receives a GitHub webhook and none uses Octokit; `https://api.github.com` is hard-coded in 20 files.

| Group | Files (gateway `src/`) | GitHub operations | Moves in |
|---|---|---|---|
| Shared client and tokens | `services/github-service.ts` (merge :686, dispatch :758), `vitana-repos.ts`, `project-manager/github-rest.ts`, `project-manager/github-app-token.ts` | every operation below | wave 2 (behind the provider) |
| PUBLISH and deploy | `routes/operator.ts` (STAGING-VERIFY gate :2205; gateway leg :2298-2304; frontend leg :2328-2348, which rebuilds vitana-v1 `main` without a commit pin), `services/deploy-orchestrator.ts` (dead EXEC-DEPLOY) | workflow dispatch, run lookup | wave 2 |
| Merges and PRs | `routes/cicd.ts` (`safeMerge`; reads `config/service-path-map.json` at :111), `project-manager/{observe-live,writers,gate2,act,loop}.ts`, `routes/approvals.ts` | PR read, checks, compare, merge, update-branch, contents commits | wave 2 |
| Dev Autopilot and self-heal | `dev-autopilot-execute.ts`, `autopilot-agent/{run-agent-execution,agent-workspace}.ts`, `dev-autopilot-{approval,watcher,bridge,ci-logs,llm-review,llm-review-tools,overlap,planning}.ts`, `dev-autopilot/planner-tools.ts`, `autopilot-validator.ts`, `self-healing-diagnosis-service.ts`, `routine-runner/learn-outcomes.ts`, `jev/gates/deploy-cause-gate.ts` | branches, contents commits, PRs, merge, revert, check logs | wave 2 |
| Operator and Kiro | `gemini-operator.ts`, `orb-tools/cicd-pr-tools.ts`, `orb-tools/database-migrations-tools.ts`, `operator-bootstrap-pack.ts`, `kiro/{kiro-push-branch,kiro-mcp-writes,kiro-repo-readiness}.ts`, `orb/developer/deep-dive.ts`, `dev-memory/resume-pack.ts` | code reads, Git Data API commits, PRs, dispatch | wave 2 |
| Views and tools | `operator-runs/run-view.ts`, `routes/testing.ts`, `routes/admin-i18n-ops.ts`, `routes/ops-runtime-health.ts`, `plan-sparring/github-tools.ts`, `db-i18n/notify-source-changed.ts`, `routes/tenant-specialists.ts`, `routes/worker-orchestrator.ts` | reads, dispatch, repository dispatch | wave 2 |
| Topics only | `types/cicd.ts` (`cicd.github.*` at :174-184), `autopilot-event-mapper.ts`, `routes/vtid-terminalize.ts` | none | wave 2 adds GitLab aliases |

13 scripts call GitHub at run time: `scripts/collab/{plan-spar,land-guard,plan-driver,preflight,queue,kiro-web-session}.mjs`,
`scripts/ci/plan-spar-slot/slot.mjs`, `scripts/ci/staging-verify/run.mjs` (deploy-run listing at :180),
`scripts/ci/test-suite/rerun-policy.mjs`, `scripts/ci/regen-screens-catalog-pr.sh`, `scripts/cleanup-github.sh`,
`scripts/dev/context.mjs` and the dead `scripts/deploy/publish-to-prod.sh`. Wave 1 changes only `run.mjs` (one new
input, §3.6); the rest move in wave 2. The provider interface for wave 2 has these operations: change read, list,
search, files, commits, create, merge (with expected SHA), update branch, close; checks of a SHA; pipeline dispatch,
runs, jobs, log, re-run; file read, tree, refs, commit files, compare; webhook verify.

### 2.4 What the VTID ledger and OASIS record today
CLAUDE.md makes OASIS the single source of truth for task state, lifecycle and governance (ALWAYS 1). Every real
transition emits an OASIS event (ALWAYS 7), and polling and heartbeats never do (NEVER 10). The Command Hub reads
status only from `vtid_ledger` and the timeline only from `oasis_events` (`routes/board-adapter.ts:8-22`, VTID-01169
and VTID-01170). The PUBLISH gate reads STAGING-VERIFY results from OASIS (`services/testing/publish-gate.ts:148`).

| Delivery fact | In the ledger or OASIS today? | Writer |
|---|---|---|
| VTID allocated, plan sparred | yes: ledger row, `vtid.plan_sparring.*` | gateway `/api/v1/vtid/allocate` (`routes/vtid.ts:144`), called by PLAN-SPAR |
| Platform staging deploy | yes: `staging.deploy.completed` or `.failed` | direct insert from the workflow (`AWS-STAGE-DEPLOY-GATEWAY.yml:1457-1476`) |
| vitana-v1 staging deploy | **no**; it only starts STAGING-VERIFY | – |
| STAGING-VERIFY | yes: `staging.verify.passed`, `.failed` or `.superseded` | `scripts/ci/staging-verify/record-oasis.sh:28-59` |
| VTID closed at merge | yes: ledger terminal fields plus a lifecycle event | `VTID-AUTO-CLOSE.yml` → `/api/v1/oasis/tasks/:vtid/complete` (`routes/oasis-tasks.ts:550`, idempotent) |
| PUBLISH, production rollback | yes: `production.publish.*`, `prod.deploy.rolled_back` | gateway, production workflows |
| Gateway merges (`safeMerge`) and Dev Autopilot runs | yes: `cicd.github.*`, `vtid.execute.*` | gateway |
| Kiro lane PR opened, merged, merge SHA | **no** (land-guard merges with `gh api`, `land-guard.mjs:286`) | – |
| Review verdicts, lane states, fix-forward attempts | **no**, only git trailers and lane files | – |
| Project Manager decisions | **no**, logged only (`project-manager/emit.ts:2-33`; `pm.decision` is not in `CicdEventType`) | – |
| CI results and queue waits | **no**, only GitHub check runs | – |

So today a VTID's history is split between OASIS, git and GitHub. This plan closes the gaps on GitLab (§3.11).

## 3. Target process
### 3.1 Principles
1. One source of truth per repository at any moment. Never a two-way sync.
2. The VTID ledger and OASIS are the record of all work. GitLab, and GitHub until it is off, are where work happens.
   Git keeps the content (plans, lane files, code) and stays the only channel between agents (`collaboration.md` §1).
3. A trusted tool judges untrusted work. Every gate runs code from `main` or from `vitana/ci-config` and reads the
   branch as data, as Lane scope does today with the base revision's `queue.mjs` (`PR-GATE.yml:166-173`).
4. Feedback on a branch is fast and cheap. The full proof runs once, after landing, and then on staging.
5. Production stays the owner's PUBLISH after Gate 2.
6. Speed comes from parallel machines and selective checks; accuracy comes from the gates that do not change: an
   independent review on the current head, the full suite once after landing, and STAGING-VERIFY on the deployed build.

### 3.2 Runner classes
| Class (runner tag) | Runs | Holds | Machines |
|---|---|---|---|
| untrusted `vitana-eng` (M2 fleet) | every job of every merge-request pipeline | nothing: no AWS role, no secret, no ID token; egress 80, 443 and DNS only (M2 §3.2) | single-use VMs, scale to zero, max 32 in wave 1 |
| main `vitana-eng-main` (protected runner: protected refs only, `main` and `assist/*`) | full suites after landing, image builds, STAGING-VERIFY, nightly, assist jobs | per-job ID tokens for read-only secrets (test user, LLM keys); no instance policy | second ASG under the M2 manager, single-use, max 6 |
| deploy `vitana-eng-deploy` | only central-script jobs: push image, staging deploy and rollback, preview upload and teardown, record, VTID close, notify platform | per-job ID tokens for the deploy roles (§7); never runs repo code | third ASG, single-use, max 4 |
| trusted host (GitLab machine) | GitLab, the merge bot and the settings sync (M2) | bot tokens | no CI job |

A structure test fails when a job tagged `vitana-eng` declares `id_tokens` or names a secret, or when a job tagged
`vitana-eng-deploy` runs a repository script.

### 3.3 Service list and templates
`config/delivery/services.json` (new, schema `vitana.delivery-services/v1`) lists for each repository its services:
paths, checks, image, staging target, STAGING-VERIFY service id, preview kind and assist rules. For platform services
the paths must equal `config/service-path-map.json` (a parity test), which stays the map the gateway reads
(`routes/cicd.ts:111`). `scripts/eng/pipeline-gen.mjs` renders one pipeline file per project into
`infra/gitlab-engineering/ci/`, and `--check` fails on drift. The M2 settings sync copies that directory into
`vitana/ci-config` (M2 §3.3), so a branch can never change the pipeline that judges it. The templates:

| Template | Runs when | Does | Classes |
|---|---|---|---|
| T1 `mr-checks` | every push to a merge request | governance jobs, then only the checks of changed services, then `gate` | untrusted |
| T2 `main-delivery` | every landing on `main` | every check of the repository once, image, push by digest, staging deploy, STAGING-VERIFY, records | main, deploy |
| T3 `nightly` | 02:17 UTC every day | every check, STAGING-VERIFY with `full=true`, CI health report (CI-HEALTH rules) | main, deploy |
| T4 `preview` | a merge request that changes a previewable service | build on untrusted; upload to `mr-<iid>/` on deploy; stop on close | untrusted, deploy |
| T5 `publish` (wave 2) | the owner's PUBLISH | promote the verified image by digest, read-only post-deploy check, automatic rollback | deploy |
| T6 `ops-job` (wave 2) | a schedule or an owner dispatch | health checks, reports, owner-approved migrations | main, deploy |
| T7 `assist` | a rule in the service list | main's tool on the branch's data; the result is pushed or opened as a merge request by `bot-assist` | main |

### 3.4 Merge-request pipeline (T1)
- Governance jobs always run and are required: `lane-scope` imports `scopeCheck` (`scripts/collab/queue.mjs:912`)
  unchanged and reads lane files from `main` of the vitana-platform mirror with the job's own short-lived token (the
  settings sync lets vitana-v1 jobs read that project), so a lane whose `plan(` PR is not merged cannot land (fails
  closed; the driver merges the plan PR first, `driver.md` step 2); `change-suite` runs
  `run.mjs check-pr` ("no suite, no merge"). Two more run report-only, as today: `pr-gate-report` (the same `gate.mjs`
  checks; `scripts/ci/pr-gate/config.json` has `enforce: false`) and `collab-handoff` (imports `validateRange`,
  `queue.mjs:779`; report-only on vitana-v1 as today, required on platform from wave 2).
- Service checks for vitana-v1 come from today's workflows: Vitest in three shards with a union check (the design of
  plan ci-push-to-result), typecheck, ESLint and design ratchets, build, i18n checks, calendar regression, edge data
  client and realtime helper, mobile, SQL tests, migration lint. Each job has generated `rules: changes:` from its
  service paths. A change to a shared path (lockfiles, `package.json`, TypeScript, Vite, ESLint or Tailwind config)
  selects every job.
- `gate` needs every check with `optional: true`. With the governance jobs it is the only required job, so no
  required job is ever path-filtered (the lesson of ci-github-modernization; M2's bot refuses an absent required job).
- Selection is never narrower than GitHub's path filters: a test over the file lists of the last 60 merged vitana-v1
  PRs (a fixture read once) checks that each PR selects every check whose GitHub workflow ran for it.
- `interruptible` plus auto-cancel: a new push cancels the old pipeline of that branch.
- Retry only on runner failure, stuck job or scheduler failure, at most once (M2 central CI). A failing test is never
  retried automatically and never skipped.
- The signed-in part of vitana-v1's `preview-e2e` (`vitana-v1/.github/workflows/PR-GATE.yml:196`, test-user secrets
  at :259-260) cannot run on an untrusted machine. On GitLab the merge request runs the same specs without a session,
  and the signed-in specs run after landing in STAGING-VERIFY on the deployed build, which is the binding run under
  rule 46. No spec is dropped; the session moves from before merge to after merge.

### 3.5 Landing (the merge queue)
M2's merge bot (`scripts/eng/gitlab-land.mjs`, eng-gitlab-m2 §3.4) lands one reviewed, green, up-to-date merge
request per project at a time with fast-forward plus squash, using the `land-guard.mjs` decisions unchanged. Wave 1 adds:
- **Cross-repo review source.** A vitana-v1 merge request titled `VTID-xxxxx (<slug>/<lane>): …` has its review entry
  in the platform lane file. The bot reads that entry from the vitana-platform mirror (`main`, then branches
  `kiro/<slug>/*`). It must pass `reviewCurrent` (`land-guard.mjs:59`) against the merge request's commits, and the
  reviewer's `Collab-Session` must not appear on any commit of the merge request. Same-repo lanes keep M2's
  push-identity check.
- **Order.** First, revert and `fix-main` merge requests while `main` is red. Then the oldest accept. A merge request
  that touches a hot file (`collaboration.md` §8a item 4) waits until the previous hot-file landing has its
  STAGING-VERIFY result.
- **Main red pauses landing**, except for the first group.
- **Squash message.** The merge request title (VTID first) and description, plus trailers `Merge-Request: !<iid>`,
  `Source-Branch:`, `Reviewed-Head:`, `Review-Verdict: accept`, `Reviewer: agent:vitana-lane-reviewer (<model>)` and
  `Accepted-At:`. STAGING-VERIFY keeps reading VTIDs from the subject; the trailers feed `delivery.landed` (§3.11).
- **Queue labels** (`queue-ready`, `queue-updating`, `queue-waiting`, `queue-blocked`, `queue-paused`; plain labels,
  Free) so the state reaches OASIS through merge-request events.
- **Assist trigger** (§3.9). Protected gate files are never landed by the bot; the owner merges them in GitLab (M2).

### 3.6 Main pipeline: full suite, image, staging, STAGING-VERIFY, records (T2)
1. `full-suite`: every check of the repository on the landed commit (main class). Main pipelines are not interruptible,
   so a red `main` is always tied to one landing.
2. For each changed deployable service: `build-image` (main class, rootless BuildKit with
   `--oci-worker-no-process-sandbox`, output an OCI archive, no push); `push-image` (deploy class, push to ECR, record
   the digest); `deploy-staging` (deploy class: copy the live task definition, change only the image digest and the
   commit variables, register, update the service, wait until stable, check the served build stamp). A deploy that
   starts after a newer landing was already deployed ends as superseded without deploying.
3. `staging-verify` (main class, `resource_group` per service, oldest first): platform `main`'s
   `scripts/ci/staging-verify/run.mjs verify` unchanged, except one new input `--deploy-runs-file` that the deploy job
   writes, in place of the GitHub Actions API call (`run.mjs:180`). Each run covers every commit between production and
   the deployed commit (`run.mjs:373-375`), so every landed VTID is verified even when deploys batch.
4. `record` (deploy class): `record-oasis.sh` unchanged writes the `staging.verify.*` rows the PUBLISH gate reads.
5. `vtid-close` (deploy class): `scripts/ci/vtid-auto-close.cjs` unchanged, with its environment taken from the squash
   commit (title, body, `Source-Branch:`).
6. `notify-platform` (vitana-v1 only, until wave 2): the repository dispatch SCREENS-CATALOG-TRIGGER sends today.
7. The plan driver (or the Project Manager when live) sends the staging summary, Gate 2, from OASIS evidence. Closing
   records stay lane-file commits in vitana-platform.
8. Shadow mode (`DELIVERY_MODE=shadow`, before the cutover): `deploy-staging` only renders the task definition and
   shows the diff; STAGING-VERIFY waits until staging serves the commit GitHub deployed and keeps its result in the job
   artifact; `record`, `vtid-close`, `notify-platform` and the assists do not run. So GitHub stays the only writer of
   OASIS verification rows and VTID closes until the cutover.

### 3.7 Previews for vitana-v1 (T4, wave 1)
The untrusted class builds with `--base=/mr-<iid>/` against the staging gateway, as PREVIEW-DEPLOY-FRONTEND does today
(`vitana-v1/.github/workflows/PREVIEW-DEPLOY-FRONTEND.yml:107-124`), and saves `dist/` as an artifact. The deploy class
uploads it with role `gl-v1-preview` to `s3://vitana-pr-previews/mr-<iid>/` and invalidates the preview CloudFront path.
A GitLab environment `review/mr-<iid>` (environments are Free) shows the link on the merge request and stops it on close.
The `mr-` prefix keeps GitLab previews apart from GitHub's `pr-<n>/` during the move. The role is narrow (one bucket
prefix and one distribution), so previews are in wave 1.

### 3.8 Rollback
- Staging (new): the deploy job captures the live task definition first. When the service does not stabilise or does
  not serve the new stamp, `rollback-staging` re-points it and waits for the old stamp, the pattern of the production
  gateway (`AWS-PROD-DEPLOY-GATEWAY.yml:1718-1745`), and records `staging.deploy.rolled_back`. Today staging has no
  automatic rollback (`vitana-v1/.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml:297`).
- Code: a revert merge request, reviewed, landed first in the queue (§3.5).
- Production: unchanged in wave 1. T5 brings the same rollback to every service in wave 2.
- A whole wave: §8.

### 3.9 Assist jobs (T7)
Some jobs must write to a branch. I18N-PROPAGATE fills every language when the German source changes, and
i18n-check's "no language left behind" step blocks a merge without it; WHATS-NEW-DRAFT opens a draft after a landing.
They need secrets (LLM keys, Bedrock), so they cannot run on the untrusted class. The rule:
- The bot creates the protected ref `assist/<iid>-<rule>` at `main` (only `bot-land` and the owner may push there) and
  starts a pipeline on it with the merge request's id and head.
- The job runs the tool from `main` and reads the merge request's files only as data (catalog JSON), never its code.
  It pushes the result as one commit to the merge-request branch as `bot-assist` (Developer on vitana-v1 only; its
  token is a protected, masked CI variable that the settings sync rotates), once per head and rule, and only before the
  review accept. A What's New draft runs after landing and becomes a new merge request instead.
- LLM keys come from Secrets Manager through role `gl-v1-assist`; providers stay as the workflows use them today.

### 3.10 Environments and who may deploy where
| Environment | Target | Started by | Class | AWS role | Wave |
|---|---|---|---|---|---|
| Merge-request preview | `s3://vitana-pr-previews/mr-<iid>/` and the preview CloudFront | central T4 job | deploy | `gl-v1-preview` | 1 |
| Staging, vitana-v1 | ECS `vitana-community-app-staging` | T2 after landing | deploy | `gl-v1-staging` | 1 |
| Staging, platform services | the staging ECS services of `vitana-gha-staging-deploy` | T2 after landing | deploy | `gl-platform-staging` | 2 |
| Production | the production ECS services and the frontend | the owner's PUBLISH only | deploy | `gl-prod-publish` | 2 |
| Engineering account | GitLab, runners | the owner's apply only (decision D5) | – | owner | all |

### 3.11 The record: VTID ledger and OASIS
- **Rule.** The ledger is the authority for status and OASIS for the timeline (`board-adapter.ts:8-22`). Every
  delivery step on GitLab writes one OASIS event that carries its VTID. The ledger changes only through the governed
  endpoints behind `requireLedgerWriteAuth`: allocation (`routes/vtid.ts:144`) and completion
  (`routes/oasis-tasks.ts:550`). Finished VTIDs are terminalized (ALWAYS 6) and never modified (IF–THEN 3). A fix
  after a terminal VTID is a new lane with a new VTID from PLAN-SPAR, as `driver.md` step 7 already says.
- **Writers.** The GitLab webhook route (M2 §3.5: signed, through `emitOasisEvent`,
  `services/oasis-event-service.ts:59`) writes every GitLab fact. The `record` job writes STAGING-VERIFY with
  `record-oasis.sh` unchanged. The `vtid-close` job closes VTIDs through the governed endpoint. No new writer inserts
  into the database directly.
- **Events.**

| Fact | Topic | Writer | Wave |
|---|---|---|---|
| Merge request opened, closed, merged | `scm.gitlab.merge_request.opened`, `.closed`, `.merged` (M2) | webhook | M2; wave 1 adds lane key, head SHA and URL |
| Merge request updated (queue label, new head) | `scm.gitlab.merge_request.updated` | webhook | 1 |
| Pipeline started and finished, with each job's name, status, wait and run seconds | `scm.gitlab.pipeline.started`, `.succeeded`, `.failed`, `.canceled` | webhook | M2 and 1 |
| Landed: merge SHA, merge request, reviewed head, verdict, reviewer model, seconds from accept to land | `delivery.landed` | webhook, from the trailers of the `main` pipeline's commit | 1 |
| Staging deploy finished or rolled back | `staging.deploy.completed`, `.failed` (existing, `types/cicd.ts:1037-1038`), `staging.deploy.rolled_back` | webhook, from the deploy job's status | 1 |
| STAGING-VERIFY | `staging.verify.passed`, `.failed`, `.superseded` (existing) | `record` job | 1 |
| VTID closed at landing | lifecycle event of `/api/v1/oasis/tasks/:vtid/complete` | `vtid-close` job | 1 |
| A GitHub PR moved to GitLab; a repository cut over | `scm.migration.pr_moved`, `scm.migration.cutover` | webhook (the merge-request description line `Moved from <PR URL>`; the tag `delivery/cutover-<repo>`) | 1 |
| Lane state change, review verdict | `delivery.lane.state_changed`, `delivery.review.recorded` | platform `main` pipeline job, from the lane-file diff | 2 |
| Gate 2 sent | `delivery.gate2.sent` | driver or Project Manager | 2 |
| Heal and improve actions | `delivery.heal.*`, `delivery.improve.*` | gateway loop service | 3 |

- **VTID on every event.** It is the first `VTID-\d{5}` in the merge-request title, or in the subject of the commit on
  `main` (the rule STAGING-VERIFY uses, `run.mjs:375`). Pipeline-level facts without one (a nightly run) use
  `BOOTSTRAP-DELIVERY`, as STAGING-VERIFY uses `BOOTSTRAP-STAGING-VERIFY` (`record-oasis.sh:28`).
- **Exactly once for readers.** Each event carries `metadata.dedupe_key` (host, project, object, id, state). Readers keep
  the first row per key. GitLab redeliveries are already dropped by `webhook-id` (M2); the key catches duplicates
  across gateway tasks.
- **Environment tag.** `emitOasisEvent` stamps `metadata.env` with the writing gateway's environment
  (`oasis-event-service.ts:80-90`), which is staging in wave 1. Delivery events add `metadata.plane: delivery` and
  `metadata.host: gitlab`, and delivery views do not filter them by `env`. The PUBLISH gate keeps reading only the
  CI-written `staging.verify.*` rows.
- **History across the move.** Nothing is rewritten. GitHub-era rows stay (`cicd.github.*`, `types/cicd.ts:174-184`),
  and ledger links to GitHub PRs stay readable in the archived repositories. With `scm.migration.pr_moved` and
  `scm.migration.cutover`, one VTID's timeline runs through both hosts.
- **Lifecycle mapper.** `autopilot-event-mapper.ts` is not edited in wave 1. Its GitLab aliases come in wave 2 with Dev
  Autopilot's move, so no GitLab event can complete a Command Hub card by accident (`autopilot-event-mapper.ts:326-333`).
- **Metrics** (§5, §10) are computed from OASIS and the ledger, not from the Git host, so they survive the GitHub
  shutdown.

### 3.12 Command Hub: the Delivery screen
The Command Hub is the one console (program finding F10). A new module, Delivery, reads only the ledger and OASIS
(VTID-01170) through a new read route `/api/v1/delivery/*` (exafy_admin).
- Wave 1: **Merge queue** per project (order, state label, wait, paused), **Pipelines** (latest per merge request, wait
  and run times, red `main`), **Releases** (staging commit per service, latest STAGING-VERIFY with link, the existing
  PUBLISH popover).
- Wave 2: **Flow** (plans and lanes with state, seat, VTID, review verdict), **Agents** (sessions with their current
  lane, from lane and merge-request events), **Metrics** (§10).
- Wave 3: **Loops**: each heal and improve loop with attempts, outcomes and its kill switch (Governance → Controls,
  `system_controls` with audit).
Machine counts and cost stay in CloudWatch (M2 monitoring); the screen links there, because polling metrics are not
OASIS events (NEVER 10).

## 4. Governance on GitLab
| Gate | Today | On GitLab | Stays exactly |
|---|---|---|---|
| Plan sparring and VTIDs | PLAN-SPAR.yml runs `plan-spar.mjs` (2 sessions, `:36`); VTIDs from `/api/v1/vtid/allocate` | Wave 1: unchanged on GitHub; plans live in vitana-platform, including plans for vitana-v1 work. Wave 2: a `plan-spar` job for merge requests titled `plan(`, running `main`'s `plan-spar.mjs` unchanged on the deploy class and writing back as `bot-plan-spar`. PLAN-SPAR.yml is retired at the platform cutover on the owner's instruction naming the plan | policy `converged-auto-v1`, partner chain, the cap of 2, the `vtid_ledger` gate, VTIDs only from CI |
| PR gate | `PR-GATE.yml:27-117`, report-only | `pr-gate-report`: the same `gate.mjs` and `guard.cjs` from `main`, the same switch | checks and their enforce switch |
| Lane scope | `PR-GATE.yml:150-173` | `lane-scope` job (required), `scopeCheck` unchanged | rule and code |
| Collab handoff | `PR-GATE.yml:123-142`; a report-only step on vitana-v1 | `collab-handoff` job, `validateRange` unchanged | same |
| Reviewer verdict bound to the head | review-entry trailers (`collaboration.md` §3); `reviewCurrent` | the bot calls `reviewCurrent`; cross-repo entries come from the platform lane file (§3.5) | trailers, chain models, never the builder |
| Protected gate files | `scripts/collab/protected-gate-files.json`; `mergeDecision` refuses them (`land-guard.mjs:108-110`) | the bot refuses them and the owner merges in GitLab. At wave 2 the list gains the GitLab merge authority and publish files, on the owner's instruction naming the plan | owner instruction plus reviewer accept |
| STAGING-VERIFY and "no suite, no merge" | `STAGING-VERIFY.yml`, `STAGING-TESTS-REQUIRED.yml`, `run.mjs` | T2, T3 and `change-suite` with the same runner from `main` | suites, read-only guard, never production, superseded rule, nightly full run |
| VTID auto-close | `VTID-AUTO-CLOSE.yml` | `vtid-close` job | script and opt-outs |
| Gate 1 and Gate 2 | policy approval; message from STAGING-VERIFY evidence | unchanged; commit lists from the GitHub mirror in wave 1, from GitLab through the provider in wave 2 | text and evidence |
| PUBLISH | Command Hub → `operator.ts:2445` → `AWS-PROD-DEPLOY-*` | wave 1 unchanged: it runs on the GitHub mirror, which has the same commits. Wave 2: T5 through the provider layer, promoting by digest | owner only, after Gate 2, pinned to the verified commit |
| Migrations | §7d: the owner approves the files and the database | wave 1 unchanged; wave 2: one T6 owner-dispatched job | same |
| Identity, trailers, no force-push | `common-rules.md` rule 8 | one GitLab service account per seat (M2); author `kiro-agent[bot]` unchanged; force push off on `main` | same |

## 5. Concurrency for dozens of agents
| Measure | Today | Wave 1 target (vitana-v1) | Wave 2 target (both) |
|---|---|---|---|
| Push to first job result | wait p50 11.1 min, then the job | p50 ≤ 3 min, p95 ≤ 6 min | same |
| Required merge-request checks done | PR-GATE wall time p50 54.9 min | p95 ≤ 15 min | p95 ≤ 20 min |
| Accept to on `main` | not recorded | p50 ≤ 15 min, p95 ≤ 45 min | same |
| Landing to STAGING-VERIFY result | staging deploy wall time p50 61.4 min, then verify | p95 ≤ 45 min | p95 ≤ 60 min |
| Landing capacity per repository | serial | ≥ 4 per hour | ≥ 4 per hour each |
| Machine maximum (untrusted / main / deploy) | shared GitHub pool | 32 / 6 / 4 | 48 / 8 / 4 |
| AWS budget, engineering account | – | 1,200 USD per month | 2,000 USD per month |

- **Demand model.** Busy machines ≈ agents × pushes per agent-hour × jobs per pipeline × (minutes per job + 1.5 boot)
  ÷ 60. For 30 agents, 2 pushes an hour, 6 jobs and 4 minutes: about 33 machines. vitana-v1 carries about a quarter of
  today's PRs, so 32 untrusted machines cover wave 1 bursts. M2's quota check prints the vCPU requests.
- **Serial queue.** Capacity ≈ 60 ÷ (merge-request pipeline minutes + about 2) landings an hour, about 5 at 10
  minutes. Each landing makes every other ready merge request re-run once. Staging does not cap landing: deploys queue
  per service and each STAGING-VERIFY covers every commit since production.
- **When a batch queue is needed.** When, on 3 working days in a row, accept to `main` p95 exceeds 60 minutes, or
  4 or more ready merge requests wait for more than 2 hours a day, or demand stays above 4 landings an hour for 2
  hours. Then a later plan builds batch landing (test K ready merge requests together, land all on green, split on
  red). That is an owner scope decision (§10).
- **Flaky tests.** Only runner failures retry, once. A job that fails and then passes on the same SHA counts as flaky
  (the CI-HEALTH definition). Three in 7 days opens an improve task (§6). A flaky test is never skipped or quarantined.
- **What the serial queue cannot do.** It cannot land two independent changes at once, it cannot test a change
  against the ones queued ahead of it, and every landing costs one extra pipeline for each waiting merge request.
- **Queue priority** is the order of §3.5: revert and fix-main first while `main` is red, then the oldest accept, with
  hot files kept one at a time.
- **Fairness.** Classes have separate machine pools, so merge-request load never starves `main`, staging or previews.
- **Agent caps stay**: at most 6 build lanes per plan, 2 PLAN-SPAR sessions (Bedrock quota shared with production,
  `collaboration.md` §8a item 2), one landing per repository and one staging deploy per service at a time. The
  sparring cap becomes the first limit at roughly 40 plans a day (2 slots, up to 25 minutes per run, about 3 runs per
  plan). Raising it needs Bedrock quota and an owner instruction, because `PLAN-SPAR.yml` and `plan-spar.mjs` are
  protected.

## 6. Self-healing and self-improvement loops (wave 3)
Each loop reacts to an OASIS event, acts through the normal pipeline (a lane or a merge request with a VTID), and
records each step as an OASIS event. They map to the loop catalog's engineering loops
(`services/gateway/specs/loop-catalog-v1.json`: L1 Repair, L2 Build & Release, L3 Learn, L4 Simplify, L5 Guard).

| Loop | Trigger (topic) | Who acts | Action |
|---|---|---|---|
| H1 red `main` | `scm.gitlab.pipeline.failed` on `main` | merge bot; Operator; Autopilot or a Kiro driver | pause landing; a revert merge request for the landing that broke it, or a fix-main lane; land it first |
| H2 staging deploy failed | `staging.deploy.failed`, `.rolled_back` | deploy job; Operator | staging rollback (§3.8), then as H1 |
| H3 STAGING-VERIFY failed | `staging.verify.failed` with `per_vtid` | plan driver; Autopilot | a fix-forward lane for the attributed VTID (`driver.md` step 7); revert when the fix is not green in 2 hours |
| H4 production rollback | `prod.deploy.rolled_back` | Operator | an incident in Ops attention and a repair proposal; never an automatic re-publish |
| I1 flaky test | three flaky results in 7 days | Autopilot or a driver | a task to stabilise the test |
| I2 slow checks | merge-request pipeline p95 over target 3 days in a row | Autopilot or a driver | a task to shard, cache or split |
| I3 queue pressure | the batch-queue trigger of §5 | Operator | a proposal to the owner |
| I4 review rework | a lane with 2 or more `changes` verdicts | Operator | a proposal on lane or plan quality |

**Guardrails for every loop.**
- At most 3 attempts per failure fingerprint (repository, job, first failing test or error signature). The fourth
  failure parks the work with the five-part stop message (stop 5).
- Never a protected gate file: the bot refuses it and loop lanes exclude those paths.
- Never production: loops act up to staging, and production stays PUBLISH.
- Every loop has a kill switch (`system_controls` key `delivery.<loop>.enabled`, audited in `system_control_audit`)
  and at most 3 open tasks per repository.
- Tests are never weakened to pass (the PR-GATE weakening check and the reviewer agent).
- **Evidence and rollback.** Each attempt is a merge request with its pipeline link and a `delivery.heal.attempt` event
  (fingerprint, attempt, outcome). The undo is a revert merge request or the staging rollback job.
- **Autonomy.** Each loop starts at level L1 (it proposes; a driver or the owner acts). Moving a loop to L2 (acts inside
  the guardrails), switching off `EXECUTION_DISARMED` or switching on `AUTOPILOT_LOOP_ENABLED` is the owner's step
  (stop 13; `routes/worker-orchestrator.ts:1087` keeps the autonomous plane to its own tasks).
- **Metrics, from OASIS.** Lead time (first push to STAGING-VERIFY passed), deployment frequency (staging per day,
  PUBLISH per week), change failure rate (landings followed within 24 hours by a red `main`, a failed STAGING-VERIFY, a
  revert or a production rollback), time to restore (red to green), queue wait, heal success rate.

## 7. Security
- **Trust zones** are the classes of §3.2. A merge-request job cannot reach the instance metadata service or the GitLab
  host's private address, and has no `AWS_*` variable (M2 acceptance A2). Wave 1 repeats those checks on the two new
  classes, and adds one: an ID token minted in a merge-request pipeline cannot assume a staging role.
- **GitLab sign-in to AWS.** The owner creates one IAM OIDC provider for `https://gitlab.vitanaland.com` in account
  `472838866351` (eu-central-1) by running `scripts/aws/setup-gitlab-oidc.sh --apply` in CloudShell. The script is a
  dry run by default and prints every call. For a self-managed GitLab, AWS evaluates only the `sub` and `aud` claims
  (the GitLab-specific condition keys are for GitLab.com only: IAM User Guide, "Available keys for OIDC federation").
  So:
  - project path and ref are pinned in `sub` (`project_path:vitana/vitana-v1:ref_type:branch:ref:main`);
  - the environment is pinned in `aud`, one audience per role;
  - GitLab enforces that `main` and `assist/*` are protected (push No one, merge Maintainers: `bot-land` and the owner;
    M2 settings);
  - audiences appear only in central job definitions in `vitana/ci-config`, which agents cannot edit;
  - GitLab refuses ID tokens for a reclaimed project path, and the settings sync never deletes or renames a project.
- **Wave-1 roles.**

| Role | `aud` | `sub` | May | Class |
|---|---|---|---|---|
| `gl-v1-staging` | `aws:v1:staging` | `…:ref:main` | push to ECR `vitana/community-app`; register task definitions of family `vitana-community-app`; update and describe `vitana-community-app-staging` only; pass only its task roles | deploy |
| `gl-v1-preview` | `aws:v1:preview` | `project_path:vitana/vitana-v1:ref_type:branch:ref:*` | write `vitana-pr-previews/mr-*` and `gl-main/*`; invalidate the preview distribution | deploy |
| `gl-v1-verify` | `aws:v1:verify` | `…:ref:main` | read secret `vitana/ci/v1/test-user` | main |
| `gl-v1-record` | `aws:v1:record` | `…:ref:main` | read secrets `vitana/ci/oasis-recorder` and `vitana/ci/gateway-service-token` | deploy |
| `gl-v1-assist` | `aws:v1:assist` | `…:ref:assist/*` or `…:ref:main` | read secret `vitana/ci/v1/llm-keys`; invoke the Bedrock model WHATS-NEW-DRAFT uses | main |

- **Secrets.** vitana-v1's GitHub secrets move as follows: `AWS_STAGING_*` → none (roles); `TEST_USER_*`,
  `DEEPSEEK_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `ANTHROPIC_API_KEY` and `PLATFORM_DISPATCH_TOKEN` (until wave 2) →
  Secrets Manager; `PREVIEW_CF_*` → plain CI variables; `CROSS_REPO_PAT` → the `bot-assist` token;
  `WHATS_NEW_BEDROCK_ROLE_ARN` → `gl-v1-assist`. GitLab tokens (seats, `bot-assist`) are rotated by the settings sync
  (90 days, M2). No AWS key exists on the GitLab side. The vitana-v1 production deploy keeps its stored keys on GitHub
  until plan eng-platform-p02 or wave 2 (A31 at the end of wave 2).
- **Push mirror.** A fine-grained GitHub token (contents and workflows: write; vitana-v1 only) is held in the
  engineering account's Secrets Manager and used only by GitLab's push mirror.
- **Accepted for now, fixed later.** Staging shares the production Supabase (decision D7). The `record` job holds the
  Supabase service-role key, as STAGING-VERIFY on GitHub does today (wave 3 moves recording into the gateway). The
  reviewer agent runs inside the driver's session, so independence is by session id, not by credential (wave 3: a
  reviewer service with its own GitLab account).

## 8. Migration in waves
### Wave 1: vitana-v1 pilot
- **Preconditions.** M1 done (restore test, green pipelines). M2 rehearsal accepted (A1 to A9). The owner applied the
  wave-1 roles and runner classes. e2e-autonomy merged.
- **Steps.**
  1. Build the six lanes of §9 on GitHub under today's process.
  2. Shadow for at least 5 working days: GitLab runs the generated vitana-v1 pipeline on every mirrored `main` commit
     with `DELIVERY_MODE=shadow`. It builds, pushes a `shadow-<sha12>` image, renders the staging task definition
     without registering it, deploys the non-production preview path `gl-main/`, and runs STAGING-VERIFY read-only
     against the staging build GitHub deployed for the same commit (§3.6 step 8). The vitana-v1 webhook is switched on
     (M2 §10), and shadow events carry `metadata.mode: shadow`. `parity-report.mjs` compares pass and fail with GitHub
     for the same SHAs; a commit staging never served is counted as not comparable.
  3. Rehearsal (owner, one command, a one-hour merge pause): one live pipeline deploys the current `main` to staging
     from GitLab and STAGING-VERIFY passes.
  4. Cutover (owner's command, then `v1-cutover.sh apply`): drivers stop opening vitana-v1 PRs 24 hours before and
     land what is ready. The script stops the GitHub-to-GitLab mirror for vitana-v1, sets the cutover marker (native
     profile, landing on, `DELIVERY_MODE=live`), turns on the push mirror to GitHub, restricts GitHub `main` to the
     mirror account, disables the 21 GitHub workflows whose work moved to GitLab (the 25 dispatch-only production and
     migration workflows stay enabled; `scripts/eng/github-v1-workflows.json` lists both), and tags
     `delivery/cutover-vitana-v1`.
  5. Open PRs: `migrate-open-prs.mjs` re-creates every open vitana-v1 PR from a `kiro/` or `claude/` branch as a
     merge request with the same branch, head SHA, title and body plus the line `Moved from <PR URL>`. The review entry
     stays valid because it is bound to the head SHA. It closes the GitHub PR with a link. Other PRs are closed with a
     note. Nothing is deleted.
- **Exit criteria, over 10 working days after cutover.** First result p50 ≤ 3 min and p95 ≤ 6 min. Accept to `main`
  p50 ≤ 15 min and p95 ≤ 45 min. Every landed vitana-v1 VTID has a `delivery.landed` event and a STAGING-VERIFY result.
  No push to GitHub vitana-v1 except by the mirror. No GitHub vitana-v1 run except owner-dispatched production or
  migration work. Change failure rate no worse than the baseline of the 30 days before cutover (from OASIS
  STAGING-VERIFY results and reverts). Cost per day within budget. Shadow parity: at least 20 commits with no
  unexplained difference.
- **Rollback, within the 10 days.** `v1-rollback.sh` (owner): stop landing on GitLab, push GitLab `main` to GitHub
  (already mirrored), restore GitHub protection and workflows, reopen the moved PRs from their branches, restart the
  GitHub-to-GitLab mirror. No commit is lost because GitHub has every commit. About one hour.
- **Known gaps until wave 2.** Command Hub buttons that dispatch vitana-v1 GitHub workflows (`routes/admin-i18n-ops.ts`,
  `routes/testing.ts`) answer with an error after cutover; the same jobs run on GitLab by schedule or by the owner.
  PUBLISH's frontend leg still rebuilds `main` on GitHub without a pin (`operator.ts:2328-2348`).

### Wave 2: gateway provider layer and vitana-platform (a later `plan(` PR that cites this one)
The provider interface of §2.3 with a GitHub implementation that wraps `github-service.ts` unchanged and a GitLab one;
the call sites move module by module. The PLAN-SPAR and PR-GATE twins. Platform workflows move to T1 to T7. PUBLISH
moves to T5 with promote-by-digest. The protected list gains the GitLab merge authority and publish files. The
platform cutover follows the wave 1 steps. **"GitHub can be switched off" means, for 14 days in a row:** no workflow run
in either GitHub repository; no call to `api.github.com` from the gateway or scripts (a counter in the provider, and
`git grep api.github.com services scripts` finds only tests and docs); no task definition that references a GitHub
token; the `vitana-gha-*` roles unused in CloudTrail for 30 days; both repositories are push-mirror targets only. Then
the owner archives them; issues and PR history stay readable there. Rollback: a provider switch per repository in the
gateway, and the platform mirror flips back as in wave 1.

### Wave 3: heal and improve loops (a later `plan(` PR)
The loops of §6, the Command Hub Loops and Metrics tabs, a reviewer service with its own identity, recording without a
database key in CI, and the batch queue if its trigger fired. Exit: change failure rate and time to restore at or below
their wave-2 values, heal success at least 60 % as a starting target, no guardrail breach. Rollback: each loop's kill
switch.

## 9. Wave 1 lanes
All in vitana-platform, executor kiro, seat `exafy`, reviewer agent. No two lanes edit the same file. A lane that edits
a file of M1 or M2 starts when the M2 lane that owns that file is `done` (the plan driver applies this; lane files cannot
name another plan's lane). The interfaces between lanes are fixed in §3: template file names, the job names `.build-image`,
`.push-image`, `.deploy-staging`, `.rollback-staging`, `.preview-upload`, `.preview-stop`, `.staging-verify`, `.record`,
`.vtid-close`, `.notify-platform`, `.assist`, and the service-list schema.

| Lane | Builds | Owns (paths) | Starts | Deploys |
|---|---|---|---|---|
| `pipelines` | §3.3, §3.4, the orchestration of §3.6, T3, T7 jobs | `config/delivery/**`, `scripts/eng/pipeline-gen.mjs` and its tests and fixture, `infra/gitlab-engineering/ci/{tpl-checks,tpl-main,tpl-nightly,tpl-assist}.yml`, `infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml` | after M2 `settings` | nothing |
| `deploy-path` | §3.2 classes, §3.6 step 2, §3.7, §3.8, §7 roles | `scripts/eng/deploy/**`, `infra/gitlab-engineering/ci/tpl-deploy.yml`, `infra/gitlab-engineering/terraform/fleet-classes.tf`, `infra/gitlab-engineering/host/fleet-manager-install.sh`, `scripts/aws/iam/gitlab-oidc-*.json`, `scripts/aws/setup-gitlab-oidc.sh`, structure tests, `infra/gitlab-engineering/RUNBOOK-delivery-aws.md` | after M2 `fleet` | nothing on merge |
| `verify-on-gitlab` | §3.6 steps 3 to 6 | `scripts/ci/staging-verify/run.mjs`, `scripts/ci/staging-verify/deploy-runs.test.mjs`, `infra/gitlab-engineering/ci/tpl-verify.yml`, `scripts/eng/verify/**` | at once; the template merges after M2 `settings` | nothing |
| `merge-queue` | §3.5, §3.9 trigger, governance job wrappers | `scripts/eng/gitlab-land.mjs`, `scripts/eng/gitlab-land-queue.test.mjs`, `scripts/eng/review-source.mjs`, `scripts/eng/gitlab-gates.mjs`, `scripts/eng/assist-trigger.mjs` and their tests | after M2 `merge-bot` | nothing |
| `gateway-delivery` | §3.11 webhook mapping, §3.12 wave 1 | `services/gateway/src/services/gitlab-events/**`, `services/gateway/src/types/cicd.ts`, `services/gateway/src/routes/delivery.ts`, `services/gateway/src/index.ts`, `services/gateway/src/frontend/command-hub/{delivery.js,app.js,navigation-config.js,index.html}`, `services/gateway/specs/dev-screen-inventory-v1.json`, `services/gateway/test/delivery/**` | after M2 `scm-webhook` | gateway to staging |
| `v1-cutover` | §8 wave 1 steps 2 to 5, rollback, metrics | `infra/gitlab-engineering/settings/gitlab-settings.json`, `scripts/eng/gitlab-settings.mjs`, `scripts/eng/gitlab-settings-cutover.test.mjs`, `scripts/eng/{v1-cutover.sh,v1-rollback.sh,migrate-open-prs.mjs,parity-report.mjs,delivery-metrics.mjs}` and tests, `scripts/eng/github-v1-workflows.json`, `infra/gitlab-engineering/RUNBOOK-v1-cutover.md` | after the other five and M2 `settings` | the shadow pipelines |

Every lane also owns `docs/validation/<its VTID>/**`. Hot files: `types/cicd.ts`, `index.ts` and `app.js` belong to
`gateway-delivery` only; M2 files are edited only after their M2 lane is `done`. Tests are red on base because the
files or behaviours do not exist there; each lane's tests are in `tasks.md`. Node tests are dependency-free
(`UNIT.yml` runs `scripts/**/*.test.mjs` with no install); gateway tests run in the gateway Jest suite.

**Staging proof.** `gateway-delivery` deploys the gateway and proves on staging that `/api/v1/delivery/summary` answers
JSON 401 without a token and that the Command Hub serves the Delivery module. The template lanes deploy nothing when
merged. They are proven by `v1-cutover`'s shadow pipelines, which deploy a non-production path to staging: the
`gl-main/` preview build, the `shadow-<sha12>` image in the staging ECR repository, the rendered task definition diff,
and a read-only STAGING-VERIFY of the same commit. The rehearsal then proves the real staging deploy.

## 10. Cost, risks, owner actions and measurement
**Cost (AWS only, eu-central-1 list prices, to be replaced by the price-list estimate the M2 fleet lane writes).**

| Item | Per month |
|---|---|
| Always on, from M1 and M2: GitLab host (m6i.xlarge, about 0.23 USD/h), fleet manager, NAT gateway, load balancer, about 320 GB of gp3, S3, Secrets Manager, CloudWatch | about 300 to 350 USD |
| Wave 1 machines: roughly 2,300 machine-minutes a day at a blended 0.0021 USD/min (80 % spot) | about 150 USD |
| Wave 2 machines, both repositories at three times today's activity | about 900 USD |
| NAT data for package installs, the main variable risk | kept low by the S3 cache through the gateway endpoint (M2) |

Caps: each class's machine maximum (§5) bounds the spend per hour; the AWS budget alarm warns at 50, 80 and 100 %
(M2 monitoring), with the amounts of §5.

**Risks.**
- R1 Cross-repo review entries are trailers, as today, until the reviewer service (wave 3).
- R2 In wave 1 the staging gateway writes delivery events into the shared database. They are for display; the
  PUBLISH gate reads only the CI-written STAGING-VERIFY rows.
- R3 Free has no merge train: about 5 landings an hour per repository. The batch-queue trigger is defined (§5).
- R4 Rootless BuildKit needs seccomp and AppArmor unconfined on the main class (not privileged). The fallback is
  rootless Buildah. The lane proves it on the M2 image.
- R5 One GitLab machine is a single point of failure (M1); the wave-1 rollback to GitHub stays open for 10 days.
- R6 The push mirror lags up to 5 minutes, so GitHub-side readers (Gate 2 commit lists, PUBLISH's frontend rebuild) can
  see vitana-v1 `main` late.
- R7 Until the protected list includes the GitLab merge authority (wave 2), a reviewed lane can change the bot or the
  settings file. The settings sync reports any Maintainer other than `bot-land` and the owner (M2).
- R8 Signed-in preview specs move from before merge to after merge (§3.4).

**Owner actions (only A to E).**
- A1 Run `scripts/aws/setup-gitlab-oidc.sh --apply` in CloudShell and fill the new secrets the script lists.
- A2 Apply the runner classes in the engineering account (the M2 owner entry point), with any quota request it prints.
- A3 Create the GitHub token for the vitana-v1 push mirror and store it where the runbook says.
- A4 Hand out the seat logins for the shadow period (M2 §6 step 8).
- A5 Run the rehearsal (`v1-cutover.sh rehearse`).
- A6 Command the cutover and run `v1-cutover.sh apply`; `v1-rollback.sh` if the exit criteria fail.
- A7 (wave 3, stop 13) Switch a loop from L1 to L2, `EXECUTION_DISARMED` or `AUTOPILOT_LOOP_ENABLED`.
- B None in wave 1. In wave 2 the first production run on GitLab is a normal PUBLISH after Gate 2.
- C1 Build the batch queue when its trigger fires. C2 Automatic Workers deploy versus PUBLISH (wave 2). C3 Raise the
  sparring cap.
- D1 Archive both GitHub repositories. D2 Delete the `claude-staging-validation` keys (eng-platform-p01 §8). D3 Retire
  PLAN-SPAR.yml, PR-GATE.yml and AWS-PROD-*.yml at the platform cutover (protected gate files, stop 3).
- E None planned. An escalated sparring verdict on this plan goes to the owner (stop 6).

**Measurement.** `docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`, `collaboration.md` §8b) and
`docs/validation/<plan VTID>/delivery-metrics.json` (`vitana.delivery-metrics/v1`): first-result time, required-checks
time, accept to `main`, landings per hour, queue depth, landing to STAGING-VERIFY result, STAGING-VERIFY pass rate,
change failure rate, time to restore and cost per day. Each field holds the GitHub baseline of §2.1 and the wave-1
value. They are computed from OASIS and the ledger through `/api/v1/delivery/metrics`; a field without a source is
`null`, never 0. Gate 2 of each wave quotes the file.

**Sources (read 2026-11-04).** AWS IAM condition keys, GitLab.com-only claims:
https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html · GitLab ID token claims:
https://docs.gitlab.com/ci/secrets/id_token_authentication/ · GitLab push mirroring (Free; 5 minutes, 1 minute for
protected branches only): https://docs.gitlab.com/user/project/repository/mirror/push/ · Rootless BuildKit in GitLab CI:
https://docs.gitlab.com/ci/docker/using_buildkit/ · Runner trust zones:
https://about.gitlab.com/resources/well-architected/architecture-design/runner-trust-zones/ · m6i.xlarge price in
eu-central-1: https://www.doit.com/compute/compute/aws/eu-central-1/m6i.xlarge
<!-- plan:end -->
