---
change_class: standard
---
# plan(agentic-delivery): hard cutover of delivery to our own GitLab, both repositories, supervised in the Command Hub

Author: Kiro, seat `exafy`, session `kiro-exafy-202611041929-802c` (Kiro Web). Revised on 2026-11-04 on the owner's
instruction: *"we need a hard cut and move away from github. this bottleneck is too expensive for the team waiting for
days for things that could be done in minutes. we need a hard cutover and move to gitlab for the delivery."* It replaces
the staged waves of the first draft (PR #4680, closed; its one sparring round escalated on the partner's evidence floor,
session `41979912`, with no finding on the plan). Premises were read at vitana-platform `4066f563e7`; none of the cited
files changed up to the base of this PR. vitana-v1 is pinned at `7829ef2f2ef12364862961d339161229c286d6f0`
(`spar_refs`). It builds on the merged plans `eng-gitlab-m1` (#4677), `eng-gitlab-m2` (#4667) and `e2e-autonomy` (#4678),
whose lanes are not built yet, on `eng-platform-p01` (merged) and on `operating-workflow` (approved, not built). Files of
those plans that are not on `main` are named by plan section. Milestone 3 of program `engineering-platform`.

<!-- plan:begin -->
## 0. Premises to check first
Each is one file on `main` (vitana-platform unless marked v1):
1. `scripts/collab/land-guard.mjs`: `reviewCurrent` :59, `checksVerdict` :85 (reads check runs only), `mergeDecision`
   :108, the squash merge pinned to the head :286.
2. `scripts/collab/queue.mjs`: `validateRange` :779 and `scopeCheck` :912, which the GitLab jobs import unchanged.
3. `scripts/ci/staging-verify/run.mjs`: VTIDs from commit subjects :375; the GitHub deploy-run listing :180, which gets a
   file input.
4. `scripts/ci/staging-verify/record-oasis.sh:28-59` and `services/gateway/src/services/testing/publish-gate.ts:148`:
   STAGING-VERIFY rows in OASIS, and the PUBLISH gate that reads them.
5. `services/gateway/src/routes/board-adapter.ts:8-22`: the Command Hub reads only `vtid_ledger` and `oasis_events`.
6. `services/gateway/src/services/github-service.ts:676` and `:686`: update-branch and merge, the two calls the cut guards.
7. `services/gateway/src/services/project-manager/writers.ts:150-156` and
   `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1228-1229`: one commit per file; the Project Manager live on staging.
8. v1 `.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml:297` and `:319-321`, v1 `.github/workflows/I18N-PROPAGATE.yml:163`:
   no staging rollback; STAGING-VERIFY started by a dispatch; a workflow that pushes to the branch it runs on.

## 1. Summary
- Built for how we work: about a dozen Kiro accounts running about 96 sessions, dozens of tasks at once in the same two
  repositories. Every task keeps its sparred plan, its own VTID, its tests and STAGING-VERIFY, and every step is
  recorded in OASIS. A one-lane task goes from plan PR to verified staging in 1 to 3 hours, instead of days.
- Hard cutover: on one day, both repositories move their delivery to our own GitLab: checks, the merge queue, staging
  deploys and STAGING-VERIFY. From that day GitHub Actions no longer runs on pull requests or pushes.
- Before the cut, the pieces are built (the 8 lanes here and the M2 lanes) and proven on copies of `main` running on
  GitLab, then rehearsed once. The cut happens when a mechanical checklist is green (§8). The target is 7 days after
  this plan is approved.
- For agents: a push gets its first check result in 1 to 3 minutes and all required checks in 5 to 10. A merge bot
  lands reviewed, green work in 5 to 15 minutes, testing up to 8 changes at once and landing them in order. Every
  landing deploys to staging and has its STAGING-VERIFY result in 10 to 20 minutes. Agents keep pushing branches as
  today; GitLab picks them up within a minute until each agent tool pushes to GitLab directly.
- For the owner: nothing to approve on the way. One staging summary per change, PUBLISH for production, and a Delivery
  screen in the Command Hub.
- The VTID ledger and OASIS stay the single record of all work. Every GitLab step writes an OASIS event with its VTID.
- After the cut: the gateway's GitHub calls move behind a provider layer, production publish moves to GitLab, GitHub is
  archived, then the repair and improvement loops follow.
- Measured per task in `timings.json`, and across tasks: first check result, accept to `main`, landings per hour,
  STAGING-VERIFY pass rate, change failure rate, time to restore and AWS cost per day (§10).

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
the built-in `GITHUB_TOKEN`. The rule at the cut: every workflow that checks pull requests, deploys or verifies staging,
closes VTIDs, re-runs tests or pushes to `main` is disabled, and its work runs on GitLab. Everything else stays on GitHub
unchanged until it moves after the cut. Lane `cutover` lists all 159 files with their action in
`scripts/eng/github-workflows.json`, and a test proves the list is complete. Templates T1 to T7: §3.3.

| Repo | Family (files) | At the cut | After the cut |
|---|---|---|---|
| v1 | PR-GATE, UNIT-TESTS, STAGING-TESTS-REQUIRED, i18n-check, CALENDAR-REGRESSION, NATIVE-CI, SQL-* (4) | disabled; T1, plus the full suite in T2 and T3. PR-GATE is a protected gate file: it is disabled on the owner's cut command naming this plan, and the file stays | deleted on the owner's instruction |
| v1 | AWS-STAGE-DEPLOY-FRONTEND | disabled; T2 | – |
| v1 | PREVIEW-DEPLOY-FRONTEND, PREVIEW-TEARDOWN-FRONTEND, E2E-PREVIEW-ORB | disabled; T4 | – |
| v1 | I18N-PROPAGATE (pushes to the branch it runs on, `I18N-PROPAGATE.yml:163`) | disabled; T7 | – |
| v1 | i18n-translate, i18n-audit-llm, i18n-long-words, WHATS-NEW-DRAFT, SCREENS-CATALOG-TRIGGER | kept (owner dispatch, or a push to `main` from the mirror); the branches and PRs they open go through the bridge (§3.13) | T7, or a GitLab pipeline trigger |
| v1 | AWS-PROD-DEPLOY-FRONTEND, DEPLOY | kept, dispatch only (PUBLISH; DEPLOY's push runs stay frozen by `cutover_gate`). Protected | T5 |
| v1 | supabase-functions-deploy, SUPABASE-FUNCTIONS-RETIRE, apply-*-migration (21) | kept, dispatch only (owner-approved, §7d) | T6 |
| v1 | STAGE-DEPLOY-FRONTEND | disabled (Cloud Run era) | deleted |
| platform | PR-GATE, UNIT, TEST-SUITE, CICDL-* (3), OASIS-PERSISTENCE, VALIDATOR-CHECK, COMMAND-HUB-GUARDRAILS, CI-SCRIPTS-TEST, AURORA-* (2), VOICE-* (2), ORB-TOOLS-LIFT-SCANNER, CALENDAR-REGRESSION, DEV-AUTOPILOT-IMPACT, VCAOP-GUARDRAILS-CI, STAGING-TESTS-REQUIRED, SQL-* (21), ENFORCE-FRONTEND-CANONICAL-SOURCE, PHASE-2B-NAMING-ENFORCEMENT, PHASE-2B-DOC-GATE | disabled; T1, plus the full suite in T2 and T3. The last three run only when their own files change, with the same rules. "validate" is a required status on GitHub `main` today (`DAILY-STATUS-UPDATE.yml:60`); on GitLab it is a T1 job. PR-GATE: as for v1 | deleted on the owner's instruction |
| platform | AWS-STAGE-DEPLOY-* (4), STAGING-VERIFY, STAGING-VERIFY-NIGHTLY, VTID-AUTO-CLOSE, TEST-SUITE-RERUN | disabled; T2 and T3, and GitLab retry on runner failure | – |
| platform | PLAN-SPAR | kept for plan PRs; the converged plan lands through GitLab (§3.5). Protected | a GitLab twin, then retired on the owner's instruction naming a plan |
| platform | AWS-PROD-DEPLOY-* (9), VISUAL-VERIFY-FRONTEND | kept, dispatch only (PUBLISH). AWS-PROD-* are protected | T5, then retired on the owner's instruction naming a plan |
| platform | RUN-MIGRATION, AWS-PROD-SETUP-* (2), AWS-PROVISION-* (2), AWS-OPS-ECS-SCALE-UNGOVERNED, AWS-REHEARSAL-AURORA-CLONE, AWS-STAGING-VALIDATION, SET-STAGING-TENANT-CONSENT, SETUP-OPERATOR-MEDIA-BUCKET, JOURNEY-TRANSLATIONS-BACKFILL, BOOTSTRAP-CLOUDFLARE-KV, ANDROID-DEVICE-E2E, MOBILE-DEVICE-E2E, E2E-TEST-RUN, OPS-TOGGLE-FLOW-V3-STAGING | kept, dispatch only; migrations keep §7d | T6 |
| platform | ALERT-* (7), CRON-* (3), E2E-ORB-MONITOR, MORNING-SYSTEM-HEALTH-CHECK, SCREEN-LOAD-* (2), EXERCISE-STAGING-SHADOW* (2), MARKETPLACE-SYNC-CRON, DEV-AUTOPILOT, VCAOP-HEALTH, TENANT-RESERVED-SLUGS-DRIFT, SMOKE-WELCOME-GREETING, CI-HEALTH, DAILY-STATUS-UPDATE, TEST-CATALOG, CODEINTEL-INDEX, MIGRATION-DRIFT-CHECK, DRIVER-WAKE, I18N-DB-SEED, REGEN-SCREENS-CATALOG, APPLY-FB061-DEBOUNCER-FIX, REUSABLE-NOTIFY | kept (schedules, dispatch, pushes from the mirror; small load); the PRs they open go through the bridge | T6, T2 or T7 |
| platform | DEPLOY-CLOUDFLARE-WORKERS | kept: it deploys production Workers on a push to `main` that changes `cloudflare/**` (its path filter, `DEPLOY-CLOUDFLARE-WORKERS.yml:12-17`), as today, now from the mirror's push; a known exception to principle 5 (§4) | owner decision C2 |
| platform | AUTO-DEPLOY, VTID-02409-BOOTSTRAP, VCAOP-CICD | disabled (GCP era, dead) | deleted |

After the cut the only GitHub workflows that run on a pull request are PLAN-SPAR (plan PRs) and the path-filtered
MIGRATION-DRIFT-CHECK. The pull-request fan-out that fills today's queue is gone.

### 2.3 Gateway files and scripts that need a Git-provider layer
53 gateway files touch GitHub: 43 make the calls themselves, 7 wire them, and 3 only carry GitHub-named topics. No
gateway file receives a GitHub webhook and none uses Octokit; `https://api.github.com` is hard-coded in 20 files.

| Group | Files (gateway `src/`) | GitHub operations | Moves in |
|---|---|---|---|
| Shared client and tokens | `services/github-service.ts` (update-branch :676, merge :686, dispatch :758), `vitana-repos.ts`, `project-manager/github-rest.ts`, `project-manager/github-app-token.ts` | every operation below | at the cut, merge and update-branch refuse (§3.13); the rest moves behind the provider after the cut |
| PUBLISH and deploy | `routes/operator.ts` (STAGING-VERIFY gate :2205; gateway leg :2298-2304; frontend leg :2328-2348, which rebuilds vitana-v1 `main` without a commit pin), `services/deploy-orchestrator.ts` (dead EXEC-DEPLOY) | workflow dispatch, run lookup | keeps working (dispatch-only workflows on the mirror); after the cut T5 |
| Merges and PRs | `routes/cicd.ts` (`safeMerge`; reads `config/service-path-map.json` at :111), `project-manager/{observe-live,writers,gate2,act,loop}.ts`, `routes/approvals.ts` | PR read, checks, compare, merge, update-branch, contents commits | at the cut: merges refuse and the staging Project Manager is off (§3.13); after the cut on the provider |
| Dev Autopilot and self-heal | `dev-autopilot-execute.ts`, `autopilot-agent/{run-agent-execution,agent-workspace}.ts`, `dev-autopilot-{approval,watcher,bridge,ci-logs,llm-review,llm-review-tools,overlap,planning}.ts`, `dev-autopilot/planner-tools.ts`, `autopilot-validator.ts`, `self-healing-diagnosis-service.ts`, `routine-runner/learn-outcomes.ts`, `jev/gates/deploy-cause-gate.ts` | branches, contents commits, PRs, merge, revert, check logs | paused at the cut (kill switch); after the cut on the provider |
| Operator and Kiro | `gemini-operator.ts`, `orb-tools/cicd-pr-tools.ts`, `orb-tools/database-migrations-tools.ts`, `operator-bootstrap-pack.ts`, `kiro/{kiro-push-branch,kiro-mcp-writes,kiro-repo-readiness}.ts`, `orb/developer/deep-dive.ts`, `dev-memory/resume-pack.ts` | code reads, Git Data API commits, PRs, dispatch | keeps working: reads use the mirror, branches and PRs go through the bridge; merges refuse |
| Views and tools | `operator-runs/run-view.ts`, `routes/testing.ts`, `routes/admin-i18n-ops.ts`, `routes/ops-runtime-health.ts`, `plan-sparring/github-tools.ts`, `db-i18n/notify-source-changed.ts`, `routes/tenant-specialists.ts`, `routes/worker-orchestrator.ts` | reads, dispatch, repository dispatch | keeps working against the mirror; after the cut on the provider |
| Topics only | `types/cicd.ts` (`cicd.github.*` at :174-184), `autopilot-event-mapper.ts`, `routes/vtid-terminalize.ts` | none | after the cut, GitLab aliases |

13 scripts call GitHub at run time: `scripts/collab/{plan-spar,land-guard,plan-driver,preflight,queue,kiro-web-session}.mjs`,
`scripts/ci/plan-spar-slot/slot.mjs`, `scripts/ci/staging-verify/run.mjs` (deploy-run listing at :180),
`scripts/ci/test-suite/rerun-policy.mjs`, `scripts/ci/regen-screens-catalog-pr.sh`, `scripts/cleanup-github.sh`,
`scripts/dev/context.mjs` and the dead `scripts/deploy/publish-to-prod.sh`. Before the cut only `run.mjs` changes (one
new input, §3.6); the rest keep working against the GitHub mirror and the bridge, and move after the cut. The provider
interface (after the cut) has these operations: change read, list,
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
1. One writer per branch at any moment. `main` of each repository has one home: GitHub until the cut, GitLab from the
   cut. An agent branch has one home too: GitHub while its agent can only push there (the bridge copies it), or GitLab.
   No branch is ever written on both sides; there is no two-way sync.
2. The VTID ledger and OASIS are the record of all work. GitLab, and GitHub until it is off, are where work happens.
   Git keeps the content (plans, lane files, code) and stays the only channel between agents (`collaboration.md` §1).
3. A trusted tool judges untrusted work. Every gate runs code from `main` or from `vitana/ci-config` and reads the
   branch as data, as Lane scope does today with the base revision's `queue.mjs` (`PR-GATE.yml:166-173`).
4. Feedback on a branch is fast and cheap. The full proof runs once, after landing, and then on staging.
5. Production stays the owner's PUBLISH after Gate 2. One existing exception stays exactly as it is today:
   `DEPLOY-CLOUDFLARE-WORKERS.yml` deploys production Workers when a push to `main` changes `cloudflare/**` (§4). The cut
   adds no other way for a landing to reach production.
6. Speed comes from parallel machines and selective checks; accuracy comes from the gates that do not change: an
   independent review on the current head, the full suite once after landing, and STAGING-VERIFY on the deployed build.

### 3.2 Runner classes
| Class (runner tag) | Runs | Holds | Machines |
|---|---|---|---|
| untrusted `vitana-eng` (M2 fleet) | every job of every merge-request pipeline and of the merge bot's train refs (§3.5) | nothing: no AWS role, no secret, no ID token; egress 80, 443 and DNS only (M2 §3.2) | single-use VMs, max 96; a warm pool of 4 ready machines (autoscaler `idle_count`) keeps the first result near 1 minute |
| main `vitana-eng-main` (protected runner: protected refs only, `main` and `assist/*`) | full suites after landing, image builds, STAGING-VERIFY, nightly, assist jobs | per-job ID tokens for read-only secrets (test user, LLM keys); no instance policy | second ASG under the M2 manager, single-use, max 12 |
| deploy `vitana-eng-deploy` | only central-script jobs: push image, staging deploy and rollback, preview upload and teardown, record, VTID close, notify platform | per-job ID tokens for the deploy roles (§7); never runs repo code | third ASG, single-use, max 6 |
| trusted host (GitLab machine) | GitLab, the merge bot, the settings sync (M2) and the GitHub bridge (§3.13) | bot tokens, the bridge's GitHub token | no CI job |

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
| T5 `publish` (after the cut) | the owner's PUBLISH | promote the verified image by digest, read-only post-deploy check, automatic rollback | deploy |
| T6 `ops-job` (after the cut) | a schedule or an owner dispatch | health checks, reports, owner-approved migrations | main, deploy |
| T7 `assist` | a rule in the service list | main's tool on the branch's data; the result is pushed or opened as a merge request by `bot-assist` | main |

### 3.4 Merge-request pipeline (T1)
- Governance jobs always run and are required: `lane-scope` imports `scopeCheck` (`scripts/collab/queue.mjs:912`)
  unchanged and reads lane files from `main` of the vitana-platform project with the job's own short-lived token (the
  settings sync lets vitana-v1 jobs read that project), so a lane whose `plan(` PR is not merged cannot land (fails
  closed; the driver merges the plan PR first, `driver.md` step 2); `change-suite` runs
  `run.mjs check-pr` ("no suite, no merge"). Two more run report-only, as today: `pr-gate-report` (the same `gate.mjs`
  checks; `scripts/ci/pr-gate/config.json` has `enforce: false`) and `collab-handoff` (imports `validateRange`,
  `queue.mjs:779`; required on vitana-platform, report-only on vitana-v1, as today).
- Service checks for vitana-v1 come from today's workflows: Vitest in three shards with a union check (the design of
  plan ci-push-to-result), typecheck, ESLint and design ratchets, build, i18n checks, calendar regression, edge data
  client and realtime helper, mobile, SQL tests, migration lint. Each job has generated `rules: changes:` from its
  service paths. A change to a shared path (lockfiles, `package.json`, TypeScript, Vite, ESLint or Tailwind config)
  selects every job. vitana-platform's checks come the same way from TEST-SUITE (typecheck and four Jest shards), UNIT,
  CICDL-GATEWAY-CI, OASIS-PERSISTENCE, VALIDATOR-CHECK, COMMAND-HUB-GUARDRAILS, the SQL and Aurora tests and the other
  pull-request families of §2.2, with their services taken from `config/service-path-map.json`.
- `gate` needs every check with `optional: true`. With the governance jobs it is the only required job, so no
  required job is ever path-filtered (the lesson of ci-github-modernization; M2's bot refuses an absent required job).
- Selection is never narrower than GitHub's path filters: a test over the file lists of the last 60 merged vitana-v1
  PRs (a fixture read once) checks that each PR selects every check whose GitHub workflow ran for it.
- `interruptible` plus auto-cancel: a new push cancels the old pipeline of that branch.
- **Speed rules**, so the required checks finish in 5 to 10 minutes: the governance jobs come first and take under a
  minute; no check job runs longer than about 4 minutes (Vitest and Jest are sharded until they fit, with the union check
  of plan ci-push-to-result); dependencies come from the S3 cache keyed by the lockfile hash, and the job image already
  holds the toolchain (M2 image). The nightly report (T3) lists every job whose median passed 4 minutes, and that opens
  an improve task (I2, §6).
- Retry only on runner failure, stuck job or scheduler failure, at most once (M2 central CI). A failing test is never
  retried automatically and never skipped.
- The signed-in part of vitana-v1's `preview-e2e` (`vitana-v1/.github/workflows/PR-GATE.yml:196`, test-user secrets
  at :259-260) cannot run on an untrusted machine. On GitLab the merge request runs the same specs without a session,
  and the signed-in specs run after landing in STAGING-VERIFY on the deployed build, which is the binding run under
  rule 46. No spec is dropped; the session moves from before merge to after merge.

### 3.5 Landing (the merge queue)
M2's merge bot (`scripts/eng/gitlab-land.mjs`, eng-gitlab-m2 §3.4) lands one reviewed, green, up-to-date merge
request per project at a time with fast-forward plus squash, using the `land-guard.mjs` decisions unchanged. The cut adds:
- **Cross-repo review source.** A vitana-v1 merge request titled `VTID-xxxxx (<slug>/<lane>): …` has its review entry
  in the platform lane file. The bot reads that entry from the vitana-platform project (`main`, then branches
  `kiro/<slug>/*`, bridged or native). It must pass `reviewCurrent` (`land-guard.mjs:59`) against the merge request's commits, and the
  reviewer's `Collab-Session` must not appear on any commit of the merge request. Same-repo lanes keep M2's
  push-identity check.
- **Order.** First, revert and `fix-main` merge requests while `main` is red. Then the oldest accept. A merge request
  that touches a hot file (`collaboration.md` §8a item 4) waits until the previous hot-file landing has its
  STAGING-VERIFY result.
- **Train.** To land each change in 5 to 15 minutes without breaking `main`, the bot tests up to 8 ready merge requests
  per repository at once, in queue order. Position k is a bot ref `train/<k>` that merges `main` and the first k merge
  requests; its pipeline runs the required jobs on the untrusted class. When position k is green and positions 1 to k-1
  have landed, the bot updates merge request k by merging `main` into it with `ci.skip`, checks that the new head's tree
  equals the tested tree of position k, and lands it. A failed or conflicting position drops that merge request from the
  train (it goes back to its builder) and the positions behind it are rebuilt without it. Every state of `main` is a
  tested tree, and each merge request stays one squash commit with its VTID. This uses GitLab's "skipped pipelines are
  considered successful" setting (Free). Only `bot-land` and the owner can merge, so nobody else can use a skipped
  pipeline to land.
- **Main red pauses landing**, except for the first group.
- **Squash message.** The merge request title (VTID first) and description, plus trailers `Merge-Request: !<iid>`,
  `Source-Branch:`, `Reviewed-Head:`, `Review-Verdict: accept`, `Reviewer: agent:vitana-lane-reviewer (<model>)` and
  `Accepted-At:`. STAGING-VERIFY keeps reading VTIDs from the subject; the trailers feed `delivery.landed` (§3.11).
- **Queue labels** (`queue-ready`, `queue-updating`, `queue-waiting`, `queue-blocked`, `queue-paused`; plain labels,
  Free) so the state reaches OASIS through merge-request events.
- **Plan merge requests** (title `plan(`, spec files and the program entry only) land when `handoff.md` on the head says
  `approved` with a `sparring_record`, PLAN-SPAR's last run on that head succeeded (its result reaches GitLab through
  the bridge), and the governance jobs pass, as `.kiro/pipeline/planning.md` §6 says today.
- **Assist trigger** (§3.9). Protected gate files are never landed by the bot; the owner merges them in GitLab (M2).

### 3.6 Main pipeline: full suite, image, staging, STAGING-VERIFY, records (T2)
1. `full-suite`: every check of the repository on the landed commit (main class). Main pipelines are not interruptible,
   so a red `main` is always tied to one landing. It runs in parallel with the image build and the staging deploy, as
   today on GitHub, so staging is not held up; a red full suite pauses landing (§3.5).
2. For each changed deployable service: `build-image` (main class, rootless BuildKit with
   `--oci-worker-no-process-sandbox`, output an OCI archive, no push); `push-image` (deploy class, push to ECR, record
   the digest); `deploy-staging` (deploy class: copy the live task definition, change only the image digest and the
   commit variables, register, update the service, wait until stable, check the served build stamp). In live mode it
   also applies the service's `env_overrides` from the service list; for the gateway at the cut these are
   `PM_AGENT_ENABLED=false`, `DELIVERY_HOST_VITANA_PLATFORM=gitlab` and `DELIVERY_HOST_VITANA_V1=gitlab` (§3.13). A
   deploy that starts after a newer landing was already deployed ends as superseded without deploying. Image builds
   reuse BuildKit layer caches kept in ECR, and the staging services stabilise in a few minutes because their target
   groups' deregistration delay is 30 seconds (set by the owner's setup script, A1).
3. `staging-verify` (main class, `resource_group` per service, oldest first): platform `main`'s
   `scripts/ci/staging-verify/run.mjs verify` unchanged, except one new input `--deploy-runs-file` that the deploy job
   writes, in place of the GitHub Actions API call (`run.mjs:180`). Each run covers every commit between production and
   the deployed commit (`run.mjs:373-375`), so every landed VTID is verified even when deploys batch.
4. `record` (deploy class): `record-oasis.sh` writes the `staging.verify.*` rows the PUBLISH gate reads. Lane
   `prerequisites` lets it take `WORKFLOW` (default `STAGING-VERIFY.yml`, so GitHub runs write exactly what they write
   today), and the GitLab job passes `gitlab:<project>/staging-verify`, so every row says which host verified it
   (`record-oasis.sh:40` hard-codes the GitHub name today). The fields the PUBLISH gate filters on (topic, service,
   commit; `publish-gate.ts:135`) do not change.
5. `vtid-close` (deploy class): `scripts/ci/vtid-auto-close.cjs` unchanged, with its environment taken from the squash
   commit (title, body, `Source-Branch:`).
6. `notify-platform` (vitana-v1): starts the platform pipeline that SCREENS-CATALOG-TRIGGER's dispatch starts today.
7. The plan driver (or the Project Manager when live) sends the staging summary, Gate 2, from OASIS evidence. Closing
   records stay lane-file commits in vitana-platform.
8. Shadow mode (`DELIVERY_MODE=shadow`, before the cutover): `deploy-staging` only renders the task definition and
   shows the diff; STAGING-VERIFY waits until staging serves the commit GitHub deployed and keeps its result in the job
   artifact; `record`, `vtid-close`, `notify-platform` and the assists do not run. So GitHub stays the only writer of
   OASIS verification rows and VTID closes until the cutover.

### 3.7 Previews for vitana-v1 (T4, at the cut)
The untrusted class builds with `--base=/mr-<iid>/` against the staging gateway, as PREVIEW-DEPLOY-FRONTEND does today
(`vitana-v1/.github/workflows/PREVIEW-DEPLOY-FRONTEND.yml:107-124`), and saves `dist/` as an artifact. The deploy class
uploads it with role `gl-v1-preview` to `s3://vitana-pr-previews/mr-<iid>/` and invalidates the preview CloudFront path.
A GitLab environment `review/mr-<iid>` (environments are Free) shows the link on the merge request and stops it on close.
The `mr-` prefix keeps GitLab previews apart from GitHub's `pr-<n>/` during the move. The role is narrow (one bucket
prefix and one distribution), so previews are part of the cut.

### 3.8 Rollback
- Staging (new): the deploy job captures the live task definition first. When the service does not stabilise or does
  not serve the new stamp, `rollback-staging` re-points it and waits for the old stamp, the pattern of the production
  gateway (`AWS-PROD-DEPLOY-GATEWAY.yml:1718-1745`), and records `staging.deploy.rolled_back`. Today staging has no
  automatic rollback (`vitana-v1/.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml:297`).
- Code: a revert merge request, reviewed, landed first in the queue (§3.5).
- Production: unchanged at the cut. T5 brings the same rollback to every service after the cut.
- The whole cut: §8.

### 3.9 Assist jobs (T7)
Some jobs must write to a branch. I18N-PROPAGATE fills every language when the German source changes, and
i18n-check's "no language left behind" step blocks a merge without it. (WHATS-NEW-DRAFT stays on GitHub at the cut and
opens its PR through the bridge, §2.2; it becomes an assist after the cut.)
They need secrets (LLM keys, Bedrock), so they cannot run on the untrusted class. The rule:
- The bot creates the protected ref `assist/<iid>-<rule>` at `main` (only `bot-land` and the owner may push there) and
  starts a pipeline on it with the merge request's id and head.
- The job runs the tool from `main` and reads the merge request's files only as data (catalog JSON), never its code.
  It pushes the result as one commit to the branch on the branch's home (GitHub for a bridged branch, with the bridge's
  token; GitLab otherwise) as `bot-assist` (Developer on vitana-v1 only; its
  token is a protected, masked CI variable that the settings sync rotates), once per head and rule, and only before the
  review accept.
- LLM keys come from Secrets Manager through role `gl-v1-assist`; providers stay as the workflows use them today.

### 3.10 Environments and who may deploy where
| Environment | Target | Started by | Class | AWS role | When |
|---|---|---|---|---|---|
| Merge-request preview | `s3://vitana-pr-previews/mr-<iid>/` and the preview CloudFront | central T4 job | deploy | `gl-v1-preview` | cut |
| Staging, vitana-v1 | ECS `vitana-community-app-staging` | T2 after landing | deploy | `gl-v1-staging` | cut |
| Staging, vitana-platform | the staging ECS services `vitana-gha-staging-deploy` may deploy today (gateway, ERP bridge, Kiro runner, PostgREST proxy) | T2 after landing | deploy | `gl-platform-staging` | cut |
| Production | the production ECS services and the frontend | the owner's PUBLISH only (GitHub dispatch until T5) | deploy | `gl-prod-publish` | after the cut |
| Engineering account | GitLab, runners | the owner's apply only (decision D5) | – | owner | always |

### 3.11 The record: VTID ledger and OASIS
- **Rule.** The ledger is the authority for status and OASIS for the timeline (`board-adapter.ts:8-22`). Every
  delivery step on GitLab writes one OASIS event that carries its VTID. The ledger changes only through the governed
  endpoints behind `requireLedgerWriteAuth`: allocation (`routes/vtid.ts:144`) and completion
  (`routes/oasis-tasks.ts:550`). Finished VTIDs are terminalized (ALWAYS 6) and never modified (IF–THEN 3). A fix
  after a terminal VTID is a new lane with a new VTID from PLAN-SPAR, as `driver.md` step 7 already says.
- **Writers.** The GitLab webhook route (M2 §3.5: signed, through `emitOasisEvent`,
  `services/oasis-event-service.ts:59`) writes every GitLab fact. The `record` job writes STAGING-VERIFY with
  `record-oasis.sh`, whose only change is the `workflow` value (§3.6 step 4). The `vtid-close` job closes VTIDs through the governed endpoint. No new writer inserts
  into the database directly.
- **Events.**

| Fact | Topic | Writer | When |
|---|---|---|---|
| Merge request opened, closed, merged | `scm.gitlab.merge_request.opened`, `.closed`, `.merged` (M2) | webhook | M2; the cut adds lane key, head SHA and URL |
| Merge request updated (queue label, new head) | `scm.gitlab.merge_request.updated` | webhook | cut |
| Push to an agent branch (head, session from the trailers) | `scm.gitlab.push` | webhook | cut |
| Review entry pushed (lane, verdict, reviewer model, reviewed head, from the `Collab-*` trailers) | `delivery.review.recorded` | webhook, from push events | cut |
| Lane file changed (slug, lane, commit, session) | `delivery.lane.updated` | webhook, from push events | cut |
| Pipeline started and finished, with each job's name, status, wait and run seconds | `scm.gitlab.pipeline.started`, `.succeeded`, `.failed`, `.canceled` | webhook | M2 and cut |
| Landed: merge SHA, merge request, reviewed head, verdict, reviewer model, seconds from accept to land | `delivery.landed` | webhook, from the trailers of the `main` pipeline's commit | cut |
| Staging deploy finished or rolled back | `staging.deploy.completed`, `.failed` (existing, `types/cicd.ts:1037-1038`), `staging.deploy.rolled_back` | webhook, from the deploy job's status | cut |
| STAGING-VERIFY | `staging.verify.passed`, `.failed`, `.superseded` (existing) | `record` job | cut |
| VTID closed at landing | lifecycle event of `/api/v1/oasis/tasks/:vtid/complete` | `vtid-close` job | cut |
| A GitHub PR moved to GitLab; a repository cut over | `scm.migration.pr_moved`, `scm.migration.cutover` | webhook (the merge-request description line `Moved from <PR URL>`; the tag `delivery/cutover-<repo>`) | cut |
| Lane state value at each change (read from the file at that commit) | `delivery.lane.state_changed` | gateway, through the provider layer | after the cut |
| A GitHub merge refused after the cut | `delivery.merge.refused` | gateway guard (§3.13) | cut |
| Gate 2 sent | `delivery.gate2.sent` | driver or Project Manager | after the cut |
| Heal and improve actions | `delivery.heal.*`, `delivery.improve.*` | gateway loop service | with the loops |

- **VTID on every event.** It is the first `VTID-\d{5}` in the merge-request title, or in the subject of the commit on
  `main` (the rule STAGING-VERIFY uses, `run.mjs:375`); a push takes the VTID of its branch's merge request. Pipeline-level facts without one (a nightly run) use
  `BOOTSTRAP-DELIVERY`, as STAGING-VERIFY uses `BOOTSTRAP-STAGING-VERIFY` (`record-oasis.sh:28`).
- **Exactly once for readers.** Each event carries `metadata.dedupe_key` (host, project, object, id, state). Readers keep
  the first row per key. GitLab redeliveries are already dropped by `webhook-id` (M2); the key catches duplicates
  across gateway tasks.
- **Environment tag.** `emitOasisEvent` stamps `metadata.env` with the writing gateway's environment
  (`oasis-event-service.ts:80-90`), which is staging until the webhook moves to production after the cut. Delivery events add `metadata.plane: delivery` and
  `metadata.host: gitlab`, and delivery views do not filter them by `env`. The PUBLISH gate keeps reading only the
  CI-written `staging.verify.*` rows.
- **History across the move.** Nothing is rewritten. GitHub-era rows stay (`cicd.github.*`, `types/cicd.ts:174-184`),
  and ledger links to GitHub PRs stay readable in the archived repositories. With `scm.migration.pr_moved` and
  `scm.migration.cutover`, one VTID's timeline runs through both hosts.
- **Lifecycle mapper.** `autopilot-event-mapper.ts` is not edited at the cut. Its GitLab aliases come with Dev Autopilot's
  move after the cut, so no GitLab event can complete a Command Hub card by accident (`autopilot-event-mapper.ts:326-333`).
- **Metrics** (§5, §10) are computed from OASIS and the ledger, not from the Git host, so they survive the GitHub
  shutdown.

### 3.12 Command Hub: the Delivery screen
The Command Hub is the one console (program finding F10). A new module, Delivery, reads only the ledger and OASIS
(VTID-01170) through a new read route `/api/v1/delivery/*` (exafy_admin).
- At the cut: **Merge queue** per project (order, state label, wait, paused), **Pipelines** (latest per merge request, wait
  and run times, red `main`), **Releases** (staging commit per service, latest STAGING-VERIFY with link, the existing
  PUBLISH popover).
- After the cut: **Flow** (plans and lanes with state, seat, VTID, review verdict), **Agents** (sessions with their current
  lane, from lane and merge-request events), **Metrics** (§10).
- With the loops: **Loops**: each heal and improve loop with attempts, outcomes and its kill switch (Governance → Controls,
  `system_controls` with audit).
Machine counts and cost stay in CloudWatch (M2 monitoring); the screen links there, because polling metrics are not
OASIS events (NEVER 10).

### 3.13 The cut: bridge, guards and what stays on GitHub
- **`main`.** From the cut, GitLab's push mirror copies only protected branches (`main`) to GitHub within about a minute,
  with "keep divergent refs" on. GitHub `main` accepts pushes and merges only from the mirror account, so nothing can land
  on GitHub any more.
- **Agent branches.** Kiro Web sessions push through a GitHub connection today and may not reach our GitLab. So the
  `github-bridge` service on the trusted host copies agent branches (`kiro/*`, `claude/*`) from GitHub to GitLab every
  minute, never `main`, `assist/*` or `pm-agent/*`, and refuses a branch whose name already lives on GitLab with other
  history. Seats
  with a GitLab login (M2 service accounts) push to GitLab directly; the bridge leaves those branches alone.
- **Pull requests.** For every open GitHub PR from a bridged branch the bridge keeps one GitLab merge request with the
  same title and body. The merge request is what lands. The bridge posts each GitLab job result as a commit status
  `gitlab/<job>` on the GitHub commit, so tools that read GitHub (`plan-driver.mjs:195`) still see results, and it
  closes the GitHub PR with a link to the landed commit. Open PRs need no migration: they keep their branch, head and
  review entry.
- **Gateway guards.** With `DELIVERY_HOST_<REPO>=gitlab` the gateway's GitHub merge and update-branch calls
  (`github-service.ts:676`, `:686`) refuse with `merge_moved_to_gitlab` and an OASIS event. That covers `safeMerge`
  (`routes/cicd.ts`), the Project Manager and Dev Autopilot's watcher. GitHub's branch protection is the backstop until
  the setting is deployed. The staging Project Manager is switched off by the staging deploy (`PM_AGENT_ENABLED=false`),
  because landing and bookkeeping move to the merge bot and the drivers. Dev Autopilot is paused with its kill switch
  (owner) until it moves to the provider layer. Reads keep working against the GitHub mirror.
- **Kept on GitHub** (§2.2): PLAN-SPAR for plan PRs, the dispatch-only production and migration workflows that PUBLISH
  and §7d start, and the scheduled jobs until they move. PUBLISH keeps working: it dispatches the same workflows, which
  build from the mirrored commit.

## 4. Governance on GitLab
| Gate | Today | From the cut | Stays exactly |
|---|---|---|---|
| Plan sparring and VTIDs | PLAN-SPAR.yml runs `plan-spar.mjs` (2 sessions, `:36`); VTIDs from `/api/v1/vtid/allocate` | unchanged on GitHub for plan PRs; the converged plan lands on GitLab (§3.5). After the cut a GitLab `plan-spar` job runs `main`'s `plan-spar.mjs` unchanged, and PLAN-SPAR.yml is retired on the owner's instruction naming that plan | policy `converged-auto-v1`, partner chain, the cap of 2, the `vtid_ledger` gate, VTIDs only from CI |
| PR gate | `PR-GATE.yml:27-117`, report-only | `pr-gate-report`: the same `gate.mjs` and `guard.cjs` from `main`, the same switch. PR-GATE.yml is disabled on the owner's cut command naming this plan (protected gate file, stop 3) | checks and their enforce switch |
| Lane scope | `PR-GATE.yml:150-173` | `lane-scope` job (required), `scopeCheck` unchanged | rule and code |
| Collab handoff | `PR-GATE.yml:123-142`; a report-only step on vitana-v1 | `collab-handoff` job, `validateRange` unchanged | same |
| Reviewer verdict bound to the head | review-entry trailers (`collaboration.md` §3); `reviewCurrent` | the bot calls `reviewCurrent`; cross-repo entries come from the platform lane file (§3.5) | trailers, chain models, never the builder |
| Protected gate files | `scripts/collab/protected-gate-files.json`; `mergeDecision` refuses them (`land-guard.mjs:108-110`) | the bot refuses them and the owner merges in GitLab. After the cut the list gains the GitLab merge authority and publish files, on the owner's instruction naming a plan | owner instruction plus reviewer accept |
| STAGING-VERIFY and "no suite, no merge" | `STAGING-VERIFY.yml`, `STAGING-TESTS-REQUIRED.yml`, `run.mjs` | T2, T3 and `change-suite` with the same runner from `main` | suites, read-only guard, never production, superseded rule, nightly full run |
| VTID auto-close | `VTID-AUTO-CLOSE.yml` | `vtid-close` job | script and opt-outs |
| Gate 1 and Gate 2 | policy approval; message from STAGING-VERIFY evidence | unchanged; commit lists from the GitHub mirror until the provider layer | text and evidence |
| PUBLISH | Command Hub → `operator.ts:2445` → `AWS-PROD-DEPLOY-*` | unchanged: the workflows run on GitHub from the mirrored commit. After the cut: T5, promoting by digest | owner only, after Gate 2, pinned to the verified commit |
| Cloudflare Workers deploy | `DEPLOY-CLOUDFLARE-WORKERS.yml:12-17` deploys production Workers on a push to `main` that changes `cloudflare/**`, without PUBLISH: a pre-existing exception to principle 5 | unchanged: the mirror's push of `main` starts it exactly as a merge on GitHub does today. It is the only kept workflow that a push to `main` starts and that deploys production; `github-workflows.test.mjs` (lane `cutover`) fails if another one appears | the path filter; moving it under PUBLISH is owner decision C2 |
| Migrations | §7d: the owner approves the files and the database | unchanged (dispatch on GitHub); after the cut one T6 owner-dispatched job | same |
| Identity, trailers, no force-push | `common-rules.md` rule 8 | one GitLab service account per seat (M2); author `kiro-agent[bot]` unchanged; force push off on `main` | same |

## 5. Concurrency for dozens of agents
| Measure | Today | Target from the cut, typical / slowest 5 % (both repositories) |
|---|---|---|
| One-lane task, plan PR opened to STAGING-VERIFY passed (`timings.json`) | days | 1 h / 3 h |
| Push to first job result | wait p50 11.1 min, then the job | 1 min / 3 min |
| Required merge-request checks done | vitana-v1 PR-GATE wall time p50 54.9 min | 5 min / 10 min |
| Accept to on `main` | not recorded | 5 min / 15 min |
| Landing to STAGING-VERIFY result | vitana-v1 staging deploy wall time p50 61.4 min, then verify | 10 min / 20 min |
| Landing capacity per repository | serial | up to 8 per train cycle, about 40 an hour |
| Parallel tasks supported | limited by the shared GitHub queue | about 96 sessions |
| Machine maximum (untrusted / main / deploy) | shared GitHub pool | 96 / 12 / 6 |
| AWS budget, engineering account | – | 5,000 USD per month |

- **Demand model.** Busy machines ≈ sessions × pushes per session-hour × jobs per pipeline × (minutes per job + 1 boot)
  ÷ 60. For 96 sessions, 2 pushes an hour and 6 jobs of 2.5 minutes: about 67 machines, plus the train positions; the
  untrusted class allows 96. The warm pool of 4 removes the boot wait for the first job. M2's quota check prints the vCPU
  requests.
- **Accounts.** The number of Kiro accounts does not change the delivery path. Every account pushes through the bridge,
  or directly once it has a GitLab login (M2 allows 100 service accounts); sessions stay attributed by their
  `Collab-Session` trailers, and work is assigned by `docs/programs/areas.yaml` as today.
- **Landing capacity.** One merge at a time with a full re-run before each gives about 6 landings an hour at 10-minute
  pipelines (60 ÷ (10 + 1)). The train (§3.5) tests up to 8 in parallel, so a cycle of about 10 minutes lands up to 8:
  about 40 an hour per repository. Staging does not cap landing: deploys queue per service and each STAGING-VERIFY covers
  every commit since production.
- **When the train is not enough.** When, on 3 working days in a row, accept to `main` passes 15 minutes for the slowest
  5 %, or more than 8 merge requests wait over an hour, the train grows to 12 positions; beyond that is owner decision C1.
- **Flaky tests.** Only runner failures retry, once. A job that fails and then passes on the same SHA counts as flaky
  (the CI-HEALTH definition). Three in 7 days opens an improve task (§6). A flaky test is never skipped or quarantined.
- **What the train cannot do.** It cannot land a merge request that conflicts with one ahead of it (that one goes back
  to its builder), and a failure at position k costs the positions behind it one re-run.
- **Queue priority** is the order of §3.5: revert and fix-main first while `main` is red, then the oldest accept, with
  hot files kept one at a time.
- **Fairness.** Classes have separate machine pools, so merge-request load never starves `main`, staging or previews.
- **Agent caps stay**: at most 6 build lanes per plan, 2 PLAN-SPAR sessions (Bedrock quota shared with production,
  `collaboration.md` §8a item 2), one landing per repository and one staging deploy per service at a time. A PLAN-SPAR
  run took about 3 minutes tonight once it had a machine (this plan's first round ran 2.5 minutes after a 20-minute
  wait). With 2 slots that is about 40 runs an hour, enough for dozens of plans a day once the GitHub queue is gone.
  The partner's Bedrock quota is shared with production, so the cap stays 2; raising it is owner decision C3, because
  `PLAN-SPAR.yml` and `plan-spar.mjs` are protected.

## 6. Self-healing and self-improvement loops (after the cut)
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
| I3 queue pressure | the train trigger of §5 ("When the train is not enough") | Operator | a proposal to the owner |
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
  host's private address, and has no `AWS_*` variable (M2 acceptance A2). The cut repeats those checks on the two new
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
- **Roles at the cut.** `<v1>` is `project_path:vitana/vitana-v1:ref_type:branch:ref:`, `<pf>` the same for
  `vitana/vitana-platform`.

| Role | `aud` | `sub` | May | Class |
|---|---|---|---|---|
| `gl-v1-staging` | `aws:v1:staging` | `<v1>main` | push to ECR `vitana/community-app`; register task definitions of family `vitana-community-app`; update and describe `vitana-community-app-staging` only; pass only its task roles | deploy |
| `gl-platform-staging` | `aws:platform:staging` | `<pf>main` | the staging permissions of `vitana-gha-staging-deploy` (eng-platform-p01), and nothing more | deploy |
| `gl-v1-preview` | `aws:v1:preview` | `<v1>*` | write `vitana-pr-previews/mr-*` and `gl-main/*`; invalidate the preview distribution | deploy |
| `gl-verify` | `aws:verify` | `<v1>main`, `<pf>main` | read secret `vitana/ci/test-user` | main |
| `gl-record` | `aws:record` | `<v1>main`, `<pf>main` | read secrets `vitana/ci/oasis-recorder` and `vitana/ci/gateway-service-token` | deploy |
| `gl-assist` | `aws:assist` | `<v1>assist/*`, `<v1>main` | read secret `vitana/ci/llm-keys` (the providers I18N-PROPAGATE uses today) | main |

- **Secrets.** The GitHub secrets of the moved workflows go to Secrets Manager (test user, LLM keys, the gateway service
  token, the OASIS recorder key) or become roles (`AWS_STAGING_*`, `WHATS_NEW_BEDROCK_ROLE_ARN`) or plain CI variables
  (`PREVIEW_CF_*`). Cross-repo tokens (`PLATFORM_DISPATCH_TOKEN`, `VITANA_V1_READ_TOKEN`, `VITANA_V1_STATUS_TOKEN`,
  `CROSS_REPO_PAT`) are not needed on GitLab: jobs read the other project with their own job token. GitLab tokens are
  rotated by the settings sync (90 days, M2). No AWS key exists on the GitLab side. The kept GitHub workflows keep their
  secrets until they move; the vitana-v1 production deploy keeps its stored keys until plan eng-platform-p02 or T5.
- **GitHub tokens on the trusted host** (Secrets Manager of the engineering account): the push mirror's token
  (contents and workflows: write, both repositories) and the bridge's token (contents: write for assist commits on
  bridged branches; pull requests: write; commit statuses: write; both repositories). Neither reaches a CI job.
- **Accepted for now, fixed later.** Staging shares the production Supabase (decision D7). The `record` job holds the
  Supabase service-role key, as STAGING-VERIFY on GitHub does today (recording moves into the gateway with the loops).
  The reviewer agent runs inside the driver's session, so independence is by session id, not by credential (later: a
  reviewer service with its own GitLab account).

## 8. The hard cutover
### 8.1 Before the cut (target: 7 days after approval)
1. Land pipeline-speed PR #4674 first, so the PM commit storm stops filling GitHub's queue while the pieces are built.
2. Build the 8 lanes of §9 and the M2 lanes `fleet`, `settings`, `merge-bot`, `scm-webhook` and `monitoring` in
   parallel (at most 6 in flight per plan, `collaboration.md` §8a).
3. Shadow as each lane lands: GitLab runs the generated pipelines of both repositories on every mirrored `main` commit
   with `DELIVERY_MODE=shadow` (§3.6 step 8). It builds and pushes `shadow-<sha12>` images, renders the staging task
   definitions without registering them, deploys the non-production preview path `gl-main/`, and runs STAGING-VERIFY
   read-only on the commit GitHub deployed. `parity-report.mjs` compares the results with GitHub's for the same SHAs.
4. Bridge dry run on all open PRs of both repositories (115 and 35 on 2026-11-04): every PR gets its merge request with
   the same head, and the statuses come back, while nothing lands on GitLab.
5. Rehearsal (owner, one command, one-hour merge pause): GitLab deploys the current `main` of both repositories to
   staging and STAGING-VERIFY passes for the gateway and the community app. Then staging returns to the GitHub path.

**The cut happens when every item of this checklist is green** (`delivery-cutover.sh status` prints it):
M1 done; the M2 lanes above done and M2 rehearsal A1 to A9 passed; every lane of §9 done; owner steps A1 to A3 done;
at least 10 shadow commits per repository with no unexplained difference and within the §5 targets for first result
and required checks; the bridge dry run complete; the rehearsal
passed; the only production deploy a landing can start is DEPLOY-CLOUDFLARE-WORKERS for a `cloudflare/**` change, as today
(`github-workflows.test.mjs` green).

### 8.2 The cut (one owner command, about one hour)
`delivery-cutover.sh apply`, on the owner's command naming this plan, for both repositories:
1. GitHub `main` accepts pushes and merges only from the mirror account. Nothing lands on GitHub from here on.
2. The GitHub-to-GitLab copy of `main` runs once more, then stops.
3. The cutover marker is set. The settings sync turns both projects to the `native` profile: landing on, required jobs
   `lane-scope`, `change-suite` and `gate`, webhook on, push mirror of `main` to GitHub, protected `assist/*`,
   `DELIVERY_MODE=live`.
4. The GitHub workflows on the disable list of §2.2 are disabled, PR-GATE.yml included.
5. The bridge starts.
6. The owner sets the Dev Autopilot kill switch in the Command Hub.
7. The first GitLab `main` pipeline of vitana-platform deploys the gateway to staging with the cut settings (§3.6 step 2).
8. Tags `delivery/cutover-vitana-platform` and `delivery/cutover-vitana-v1`.
Lanes that were ready to land on GitHub land on GitLab from the next merge-bot tick; nothing is migrated by hand.

### 8.3 Exit criteria (10 working days after the cut)
The §5 targets hold (typical / slowest 5 %): first result 1 / 3 min, required checks 5 / 10 min, accept to `main`
5 / 15 min, landing to STAGING-VERIFY result 10 / 20 min, one-lane task 1 / 3 h. Every landed VTID has a
`delivery.landed` event and a STAGING-VERIFY result. No push to GitHub `main` except by the mirror. No GitHub workflow
run on a pull request except PLAN-SPAR and MIGRATION-DRIFT-CHECK. Change failure rate no worse than the 30 days before the
cut (from OASIS STAGING-VERIFY results and reverts). Cost per day within budget.

### 8.4 Rollback (within the 10 days)
`delivery-rollback.sh` (owner) reverses §8.2: stop landing on GitLab, check that GitHub `main` equals GitLab `main` (the
mirror already copied it), restore GitHub protection and workflows, stop the bridge, restart the GitHub-to-GitLab copy,
unset the marker, lift the Dev Autopilot pause. Open PRs never left GitHub, so nothing needs reopening. About one hour;
no commit is lost.

### 8.5 After the cut (later `plan(` PRs that cite this one)
1. The provider layer of §2.3: a GitHub implementation that wraps `github-service.ts` unchanged and a GitLab one. The
   Project Manager and Dev Autopilot come back on GitLab, and the PLAN-SPAR twin starts.
2. PUBLISH moves to T5 (promote by digest), which also pins the frontend to the verified commit: today the frontend leg
   rebuilds vitana-v1 `main` without a pin (`operator.ts:2326-2348`); the scheduled and owner-run jobs move to T6; the protected list gains the
   GitLab merge authority and publish files.
3. Each agent surface pushes to GitLab directly as soon as it can reach it; the bridge stops when none pushes to GitHub.
4. **"GitHub can be switched off" means, for 14 days in a row:** no workflow run in either GitHub repository; no call to
   `api.github.com` from the gateway or scripts (a counter in the provider, and `git grep api.github.com services
   scripts` finds only tests and docs); no task definition that references a GitHub token; the `vitana-gha-*` roles
   unused in CloudTrail for 30 days; both repositories are push-mirror targets only. Then the owner archives them; issues
   and PR history stay readable there.
5. The loops of §6, the Command Hub Flow, Agents, Metrics and Loops tabs, a reviewer service with its own identity, and
   a longer train if its trigger fired. Exit: change failure rate and time to restore at or below their values after
   the cut, heal success at least 60 % as a starting target, no guardrail breach. Rollback: each loop's kill switch.

## 9. Lanes for the cut
All in vitana-platform, executor kiro, seat `exafy`, reviewer agent. No two lanes edit the same file. A lane that edits a
file of M1 or M2 starts when the M2 lane that owns that file is `done` (the plan driver applies this; lane files cannot
name another plan's lane). The interfaces between lanes are fixed in §3: template file names, the job names
`.build-image`, `.push-image`, `.deploy-staging`, `.rollback-staging`, `.preview-upload`, `.preview-stop`,
`.staging-verify`, `.record`, `.vtid-close`, `.notify-platform`, `.assist`, the service-list schema with `env_overrides`,
the deploy-runs file, the bridge's status names `gitlab/<job>`, and `record-oasis.sh`'s `WORKFLOW` input. There are 8
lanes; at most 6 build at once.

Order the plan driver applies (lane files can name only lanes of this plan, and these orders are not in them): lane
`prerequisites` lands first. Lanes `gateway-delivery` and `verify-on-gitlab` (its `.record` job) build on it, and so does
eng-gitlab-m2 lane `scm-webhook`: every file under `services/gateway/src/routes/` must be claimed by a domain of the
developer atlas (`services/gateway/src/orb/developer/domain-atlas.ts`, drift guard in
`test/vtid-04560-role-separation-regression.test.ts:524-528`), and neither `routes/internal-gitlab-webhook.ts` (M2) nor
`routes/delivery.ts` (here) is claimed today. `prerequisites` adds both claims to the atlas domain `deploy`.

| Lane | Builds | Owns (paths) | Starts | Deploys |
|---|---|---|---|---|
| `prerequisites` | the atlas claims of the two new route files; `record-oasis.sh`'s `WORKFLOW` input (§3.6 step 4) | `services/gateway/src/orb/developer/domain-atlas.ts`, `services/gateway/test/atlas-gitlab-route-claims.test.ts`, `scripts/ci/staging-verify/record-oasis.sh`, `scripts/ci/staging-verify/record-oasis-workflow.test.mjs` | at once | gateway to staging (an atlas entry; nothing a member sees) |
| `pipelines` | §3.3, §3.4, the orchestration of §3.6, T3, T7 jobs, for both repositories | `config/delivery/**`, `scripts/eng/pipeline-gen.mjs` and its tests and fixtures, `infra/gitlab-engineering/ci/{tpl-checks,tpl-main,tpl-nightly,tpl-assist}.yml`, `infra/gitlab-engineering/ci/{v1,platform}-delivery.gitlab-ci.yml` | after M2 `settings` | nothing |
| `deploy-path` | §3.2 classes, §3.6 step 2, §3.7, §3.8, §7 roles | `scripts/eng/deploy/**`, `infra/gitlab-engineering/ci/tpl-deploy.yml`, `infra/gitlab-engineering/terraform/fleet-classes.tf`, `infra/gitlab-engineering/host/fleet-manager-install.sh`, `scripts/aws/iam/gitlab-oidc-*.json`, `scripts/aws/setup-gitlab-oidc.sh`, structure tests, `infra/gitlab-engineering/RUNBOOK-delivery-aws.md` | after M2 `fleet` | nothing on merge |
| `verify-on-gitlab` | §3.6 steps 3 to 6 and 8, for the gateway and the community app | `scripts/ci/staging-verify/run.mjs`, `scripts/ci/staging-verify/deploy-runs.test.mjs`, `infra/gitlab-engineering/ci/tpl-verify.yml`, `scripts/eng/verify/**` | at once; the template merges after M2 `settings` | nothing |
| `merge-queue` | §3.5 (with plan merge requests), the §3.9 trigger, governance job wrappers | `scripts/eng/gitlab-land.mjs`, `scripts/eng/gitlab-land-queue.test.mjs`, `scripts/eng/review-source.mjs`, `scripts/eng/gitlab-gates.mjs`, `scripts/eng/assist-trigger.mjs` and their tests | after M2 `merge-bot` | nothing |
| `github-bridge` | §3.13 branches, pull requests, statuses | `scripts/eng/github-bridge.mjs`, `scripts/eng/github-bridge.test.mjs`, `infra/gitlab-engineering/host/units/vitana-github-bridge.{service,timer}`, `infra/gitlab-engineering/RUNBOOK-github-bridge.md` | after M2 `gitlab-client` | nothing on merge |
| `gateway-delivery` | §3.11 webhook mapping, §3.12 at the cut, the §3.13 guards | `services/gateway/src/services/gitlab-events/**`, `services/gateway/src/services/delivery-host.ts`, `services/gateway/src/services/github-service.ts`, `services/gateway/src/types/cicd.ts`, `services/gateway/src/routes/delivery.ts`, `services/gateway/src/index.ts`, `services/gateway/src/frontend/command-hub/{delivery.js,app.js,navigation-config.js,index.html}`, `services/gateway/specs/dev-screen-inventory-v1.json`, `services/gateway/test/delivery/**` | after M2 `scm-webhook` | gateway to staging |
| `cutover` | §8: shadow switch, checklist, cut and rollback scripts, the workflow list, parity and metrics, the driver note | `infra/gitlab-engineering/settings/gitlab-settings.json`, `scripts/eng/gitlab-settings.mjs`, `scripts/eng/gitlab-settings-cutover.test.mjs`, `scripts/eng/{delivery-cutover.sh,delivery-rollback.sh,parity-report.mjs,delivery-metrics.mjs,github-workflows.json}` and tests, `infra/gitlab-engineering/RUNBOOK-cutover.md`, `.kiro/pipeline/driver.md`, `.kiro/pipeline/lane-land.md` | after the other six and M2 `settings` | the shadow pipelines |

Every lane also owns `docs/validation/<its VTID>/**`. Hot files: `types/cicd.ts`, `index.ts`, `app.js` and
`github-service.ts` belong to `gateway-delivery` only (plan github-api-quota, not approved, also names
`github-service.ts`; whichever lands second merges `main` first). Tests are red on base because the files or behaviours
do not exist there; each lane's tests are in `tasks.md`. Node tests are dependency-free (`UNIT.yml` runs
`scripts/**/*.test.mjs` with no install); gateway tests run in the gateway Jest suite.

**Staging proof.** `gateway-delivery` deploys the gateway and proves on staging that `/api/v1/delivery/summary` answers
JSON 401 without a token, that the Command Hub serves the Delivery module, and that with the cut flag unset a merge call
behaves as before. The other lanes deploy nothing when merged. They are proven by the shadow pipelines of lane
`cutover`, which deploy a non-production path to staging: the `gl-main/` preview build, the `shadow-<sha12>` images in
the staging ECR repositories, the rendered task-definition diffs, and a read-only STAGING-VERIFY of the same commit. The
rehearsal then proves the real staging deploys.

## 10. Cost, risks, owner actions and measurement
**Cost (AWS only, eu-central-1 list prices, to be replaced by the price-list estimate the M2 fleet lane writes).**

| Item | Per month |
|---|---|
| Always on, from M1 and M2, with the GitLab host grown to m6i.2xlarge (about 0.46 USD/h) for 96 sessions: fleet manager, NAT gateway, load balancer, about 320 GB of gp3, S3, Secrets Manager, CloudWatch | about 470 to 520 USD |
| Warm pool of 4 untrusted machines, all day | about 370 USD |
| Job machines at today's activity: roughly 9,000 machine-minutes a day at a blended 0.0021 USD/min (80 % spot) | about 550 USD |
| Job machines with about 96 sessions busy 12 hours a day: roughly 57,000 machine-minutes a day | about 3,600 USD |
| NAT data for package installs, the main variable risk | kept low by the S3 cache through the gateway endpoint (M2) |

Caps: each class's machine maximum (§5) bounds the spend per hour; the AWS budget alarm warns at 50, 80 and 100 % of
5,000 USD (M2 monitoring).

**Risks.**
- R1 A hard cut moves both repositories at once, so a fault hits all work. The checklist, the rehearsal and the one-hour
  rollback limit it.
- R2 Cross-repo review entries are trailers, as today, until the reviewer service.
- R3 In the first days the staging gateway writes delivery events into the shared database. They are for display; the
  PUBLISH gate reads only the CI-written STAGING-VERIFY rows.
- R4 The train is our own code on the Free tier (§3.5). Its safety rests on the tree check before each landing and on
  only `bot-land` and the owner being able to merge; the settings sync reports any other Maintainer.
- R5 Rootless BuildKit needs seccomp and AppArmor unconfined on the main class (not privileged). The fallback is rootless
  Buildah. The lane proves it on the M2 image.
- R6 One GitLab machine is a single point of failure (M1); the rollback to GitHub stays open for 10 days.
- R7 The bridge adds up to a minute per push and depends on GitHub's API for agent branches until each surface pushes to
  GitLab directly.
- R8 Until the protected list includes the GitLab merge authority, a reviewed lane can change the bot or the settings
  file. The settings sync reports any Maintainer other than `bot-land` and the owner (M2).
- R9 Signed-in preview specs move from before merge to after merge (§3.4).
- R11 The speed targets need the warm pool, sharded tests, warm caches and the shorter deregistration delay; the
  checklist holds the cut until the shadow pipelines meet them.
- R12 PUBLISH's frontend leg rebuilds vitana-v1 `main` without a commit pin (`operator.ts:2326-2348`). That is true
  today; after the cut GitHub `main` trails GitLab `main` by up to a minute, so the window in which a newer landing can
  ship with a PUBLISH is a little wider. Until T5 pins the frontend (§8.5 step 2), the Delivery screen shows the
  frontend commit staging verified next to GitHub's `main`, so the owner can see a difference before pressing PUBLISH.
- R10 Command Hub buttons that dispatch disabled vitana-v1 workflows (`routes/admin-i18n-ops.ts`, `routes/testing.ts`)
  answer with an error until they move; Dev Autopilot is paused until its move.

**Owner actions (only A to E).**
- A1 Run `scripts/aws/setup-gitlab-oidc.sh --apply` in CloudShell and fill the secrets it lists; with it, the staging
  target groups' deregistration delay goes to 30 seconds.
- A2 Apply the runner classes in the engineering account (the M2 owner entry point), with any quota request it prints,
  and grow the GitLab host to m6i.2xlarge (M1 `setup.sh grow`).
- A3 Create the two GitHub tokens of §7 (push mirror, bridge) and store them where the runbook says.
- A4 Run the M2 rehearsal and this plan's rehearsal (`delivery-cutover.sh rehearse`).
- A5 Command the cut naming this plan (it disables PR-GATE.yml, a protected gate file, stop 3) and run
  `delivery-cutover.sh apply`; run `delivery-rollback.sh` if the exit criteria fail.
- A6 (stop 13, with the loops) switch a loop from L1 to L2, `EXECUTION_DISARMED` or `AUTOPILOT_LOOP_ENABLED`.
- B1 Set the Dev Autopilot kill switch at the cut (a production control). B2 None else: production stays a normal
  PUBLISH after Gate 2.
- C The hard cut itself is the owner's decision of 2026-11-04. Later: C1 grow the train beyond 12 positions when its trigger fires;
  C2 whether DEPLOY-CLOUDFLARE-WORKERS moves under PUBLISH (until then it deploys as it does today); C3 raise the sparring cap.
- D1 Archive both GitHub repositories after the switch-off measure. D2 Delete the `claude-staging-validation` keys
  (eng-platform-p01 §8). D3 Retire PLAN-SPAR.yml and AWS-PROD-*.yml after their GitLab twins (protected gate files).
- E None planned. An escalated sparring verdict on this plan goes to the owner (stop 6).

**Measurement.** `docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`, `collaboration.md` §8b) and
`docs/validation/<plan VTID>/delivery-metrics.json` (`vitana.delivery-metrics/v1`): first-result time, required-checks
time, accept to `main`, landings per hour, queue depth, landing to STAGING-VERIFY result, STAGING-VERIFY pass rate,
change failure rate, time to restore and cost per day. Each field holds the GitHub baseline of §2.1 and the value after
the cut. They are computed from OASIS and the ledger through `/api/v1/delivery/metrics`; a field without a source is
`null`, never 0. The staging summary of the cut quotes the file.

**Sources (read 2026-11-04).** AWS IAM condition keys, GitLab.com-only claims:
https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html · GitLab ID token claims:
https://docs.gitlab.com/ci/secrets/id_token_authentication/ · GitLab push mirroring (Free; 5 minutes, 1 minute for
protected branches only): https://docs.gitlab.com/user/project/repository/mirror/push/ · Rootless BuildKit in GitLab CI:
https://docs.gitlab.com/ci/docker/using_buildkit/ · Runner trust zones:
https://about.gitlab.com/resources/well-architected/architecture-design/runner-trust-zones/ · m6i.xlarge price in
eu-central-1: https://www.doit.com/compute/compute/aws/eu-central-1/m6i.xlarge
<!-- plan:end -->

## Late lanes (added after convergence; outside the sparred plan text)
- `reseat` (2026-11-05, `lane_admin`): gives the eight lanes of §9 back to seat `exafy`, which §9 assigns. The Project
  Manager moved them to the exceptions seat `exafyltd` during a driver heartbeat gap (#4688). Lane file
  `lanes/reseat.md`, tasks group `reseat`. Its VTID comes from PLAN-SPAR. The sparred text above is unchanged.
- `nav-paths` (2026-11-05, `lane_admin`): adds four files to lane `gateway-delivery`'s `paths` (the Command Hub voice
  screens, the two stored-vector files, the ownership-guard line). Its builder found the Delivery screen cannot land green
  without them. The vectors are rebuilt with one Bedrock call, run by the owner or by CI, never from a session.
- `sv-cwd` (2026-11-05, fix forward of STAGING-VERIFY): three staging manifests of plan eng-platform-p01 run Jest from the
  repository root and fail every gateway STAGING-VERIFY since 14:57Z, this plan's merge commit `51c2bead07` included. Each
  gets `"cwd": "services/gateway"`.
- `cut-settings` (2026-11-05, after `cutover`): the settings the cut needs that no lane builds: `bot-assist` and its token
  rotation, pipeline schedules, oldest-first resource groups, the job-token allowlist, the artifact size limit, and the
  `assist/*` and `train/*` rules. It changes the settings file and sync script after `cutover` lands.
- `build-class-retag` (2026-11-08, late lane, `executor: kiro`, seat `exafy`): retags the five `build-image:*` jobs from
  `vitana-eng-main` to `vitana-eng-build`, the build class that deploy-path adds in `fleet-classes.tf`. The class is the only one
  whose BuildKit service runs unconfined (review 1ea5, finding 2). Reason: the five jobs run on `vitana-eng-main` today
  (`build-image:gateway`, `build-image:erp-bridge`, `build-image:kiro-runner`, `build-image:postgrest-aurora-proxy` in
  `platform-delivery.gitlab-ci.yml`; `build-image:community-app` in `v1-delivery.gitlab-ci.yml`). Deploy-path's test 14
  (`scripts/eng/fleet-classes-structure.test.mjs`) fails on exactly this. The generator sets the tag at
  `scripts/eng/pipeline-gen.mjs:193`. Lane file `lanes/build-class-retag.md`, tasks group `build-class-retag`. Merge gate: not
  before the `vitana-eng-build` class runs (owner steps A2 and A3), or the image builds wait for a runner that does not exist.
  The sparred text above is unchanged.
- `build-class-retag` paths change (2026-11-08 12:10Z, planner decision): the lane gains `docs/validation/VTID-05643/**`. Its PR's validator needs the evidence dir of the lane's own VTID (`acceptance.md`, `commands.log`, `outputs/`). The paths of the late lane above are otherwise unchanged.
- `build-class-retag-2` (2026-11-08 13:05Z, late lane, `executor: kiro`, seat `exafy`, planner decision): replaces `build-class-retag` (VTID-05643), which is closed without a build (PR #4873). Reason: the five `build-image:*` jobs tag `vitana-eng-main` (`build-image:gateway`, `build-image:erp-bridge`, `build-image:kiro-runner`, `build-image:postgrest-aurora-proxy` in `platform-delivery.gitlab-ci.yml`; `build-image:community-app` in `v1-delivery.gitlab-ci.yml`), and deploy-path test 14 (`scripts/eng/fleet-classes-structure.test.mjs`) requires the build class. Paths: `scripts/eng/pipeline-gen.mjs`, `scripts/eng/pipeline-gen.test.mjs`, `infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml`, `infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml`, `docs/validation/**`. Lane file `lanes/build-class-retag-2.md`, tasks group `build-class-retag-2`. Merge gate: not before the `vitana-eng-build` class runs (owner steps A2 and A3). The sparred text above is unchanged.
