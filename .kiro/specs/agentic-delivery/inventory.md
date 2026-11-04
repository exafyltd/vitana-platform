# Workflow inventory — agentic-delivery (generated)

Generated read-only from `.github/workflows/*.yml` of vitana-platform `4066f563e7` and vitana-v1 `7829ef2f2` on 2026-11-04.
Line numbers point into those commits. `image` = a `docker build` line, `role` = `role-to-assume`, `keys` = a stored
`AWS_*ACCESS_KEY_ID` reference, `ecs`/`s3` = a deploy command, `writes-repo` = `git push` or `gh pr create`. The fate column
applies the family table of plan.md §2.2, which is binding where the two differ. Templates T1–T7: plan.md §3.3.

Totals: 159 files (113 vitana-platform, 46 vitana-v1). Triggers: 60 pull_request, 1 pull_request_target, 42 push, 31 schedule (31 files with a cron), 134 workflow_dispatch, 4 workflow_run, 5 repository_dispatch, 2 workflow_call. 14 build images, 29 assume an AWS role, 12 reference stored AWS keys, 9 write to the repository. 37 stored secret names are referenced (plus the built-in GITHUB_TOKEN).

## vitana-platform

| File | on: (line) | Triggers | Cron | Flags | Fate |
|---|---|---|---|---|---|
| `ALERT-APP-USERS-IDENTITY-DRIFT.yml` | 44 | schedule, workflow_dispatch | 0 6 * * * | role:72 keys:34 | kept until wave 2, then T6 scheduled job |
| `ALERT-NEWDAY-BRIEFING-LOOP.yml` | 57 | schedule, workflow_dispatch | */20 * * * * | – | kept until wave 2, then T6 scheduled job |
| `ALERT-OASIS-LEDGER-INTEGRITY.yml` | 42 | schedule, workflow_dispatch | 40 7 * * * | – | kept until wave 2, then T6 scheduled job |
| `ALERT-ORB-BOOTSTRAP-LATENCY.yml` | 44 | schedule, workflow_dispatch | 35 * * * * | – | kept until wave 2, then T6 scheduled job |
| `ALERT-ORB-SESSION-STATE-HEALTH.yml` | 28 | schedule, workflow_dispatch | 20 7 * * * | – | kept until wave 2, then T6 scheduled job |
| `ALERT-PUSH-DISPATCH-HEALTH.yml` | 34 | schedule, workflow_dispatch | */20 * * * * | – | kept until wave 2, then T6 scheduled job |
| `ALERT-WELCOME-GREETING-HEALTH.yml` | 40 | schedule, workflow_dispatch | 0 7 * * * | – | kept until wave 2, then T6 scheduled job |
| `ANDROID-DEVICE-E2E.yml` | 18 | workflow_dispatch | – | – | kept until wave 2, then T6 owner-dispatched job |
| `APPLY-FB061-DEBOUNCER-FIX.yml` | 24 | workflow_dispatch | – | writes-repo:69 | one-off: retired at wave 2 if applied, else T7 |
| `AURORA-I18N-INTEGRATION.yml` | 15 | pull_request, workflow_dispatch | – | – | T1 checks at wave 2 |
| `AURORA-PRIVILEGE-PARITY-UNIT.yml` | 8 | pull_request, push | – | – | T1 checks at wave 2 |
| `AUTO-DEPLOY.yml` | 24 | push, workflow_dispatch | – | – | retired (GCP-era EXEC-DEPLOY path, dead) |
| `AWS-OPS-ECS-SCALE-UNGOVERNED.yml` | 27 | workflow_dispatch | – | role:74 ecs:22 | kept until wave 2, then T6 owner-dispatched job |
| `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` | 50 | workflow_dispatch | – | image:152 role:121 ecs:250 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-DEPLOY-GATEWAY.yml` | 60 | workflow_dispatch | – | image:458 role:332 ecs:1589 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-DEPLOY-KIRO-RUNNER.yml` | 17 | workflow_dispatch | – | role:64 ecs:124 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-DEPLOY-OASIS-OPERATOR.yml` | 29 | workflow_dispatch | – | image:148 role:101 ecs:167 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml` | 23 | workflow_dispatch | – | image:142 role:99 ecs:169 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-DEPLOY-ORB-AGENT.yml` | 25 | workflow_dispatch | – | image:144 role:101 ecs:174 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml` | 53 | workflow_dispatch | – | image:210 role:143 ecs:315 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-DEPLOY-REALTIME-AURORA.yml` | 56 | workflow_dispatch | – | image:391 role:197 ecs:491 s3:258 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml` | 21 | workflow_dispatch | – | image:140 role:97 ecs:170 | kept until wave 2, then T5 publish; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `AWS-PROD-SETUP-POSTGREST-AURORA-PROXY-EDGE.yml` | 43 | workflow_dispatch | – | role:108 ecs:207 s3:121 | kept until wave 2, then T6 owner-dispatched job (or retired when the one-off is done) |
| `AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml` | 42 | workflow_dispatch | – | role:111 | kept until wave 2, then T6 owner-dispatched job (or retired when the one-off is done) |
| `AWS-PROVISION-APPILIX-SECRETS.yml` | 58 | workflow_dispatch | – | role:107 keys:53 ecs:182 | kept until wave 2, then T6 owner-dispatched job (or retired when the one-off is done) |
| `AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml` | 21 | workflow_dispatch | – | role:46 keys:47 | kept until wave 2, then T6 owner-dispatched job (or retired when the one-off is done) |
| `AWS-REHEARSAL-AURORA-CLONE.yml` | 24 | workflow_dispatch | – | role:85 | kept until wave 2, then T6 owner-dispatched job |
| `AWS-STAGE-DEPLOY-ERP-BRIDGE.yml` | 25 | push, workflow_dispatch | – | image:133 role:97 keys:18 ecs:162 | T2 main-delivery at wave 2 |
| `AWS-STAGE-DEPLOY-GATEWAY.yml` | 34 | push, workflow_dispatch | – | image:238 role:207 keys:27 ecs:1348 | T2 main-delivery at wave 2 |
| `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` | 23 | push, pull_request, workflow_dispatch | – | image:80 role:108 keys:17 ecs:174 | T2 main-delivery at wave 2 |
| `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml` | 35 | push, workflow_dispatch | – | image:130 role:94 keys:28 ecs:152 | T2 main-delivery at wave 2 |
| `AWS-STAGING-VALIDATION.yml` | 28 | workflow_dispatch | – | – | kept until wave 2, then T6 owner-dispatched job |
| `BOOTSTRAP-CLOUDFLARE-KV.yml` | 17 | workflow_dispatch | – | – | kept until wave 2, then T6 owner-dispatched job or retired |
| `CALENDAR-REGRESSION.yml` | 16 | pull_request, push, workflow_dispatch | – | – | T1 checks at wave 2 |
| `CI-HEALTH.yml` | 20 | schedule, workflow_dispatch | 17 5 * * * | – | kept until wave 2, then T3 nightly report (same flake and duration rules) |
| `CI-SCRIPTS-TEST.yml` | 7 | pull_request, push | – | – | T1 checks at wave 2 |
| `CICDL-CORE-LINT-SERVICES.yml` | 3 | pull_request, push | – | – | T1 checks at wave 2 |
| `CICDL-CORE-OPENAPI-ENFORCE.yml` | 3 | pull_request, push | – | – | T1 checks at wave 2 |
| `CICDL-GATEWAY-CI.yml` | 9 | push, pull_request | – | – | T1 checks at wave 2 |
| `CODEINTEL-INDEX.yml` | 41 | push, workflow_dispatch | – | role:212 s3:220 | kept until wave 2, then T2 after-merge job |
| `COMMAND-HUB-GUARDRAILS.yml` | 9 | pull_request, push | – | – | T1 checks at wave 2 |
| `CRON-AUTO-PROMOTER.yml` | 12 | schedule, workflow_dispatch | 30 * * * * | – | kept until wave 2, then T6 scheduled job |
| `CRON-GRADUATION-RECOMMENDER.yml` | 9 | schedule, workflow_dispatch | 0 8 * * * | – | kept until wave 2, then T6 scheduled job |
| `CRON-SHADOW-COMPARISON-REPORT.yml` | 16 | schedule, workflow_dispatch | 15 8 * * * | – | kept until wave 2, then T6 scheduled job |
| `DAILY-STATUS-UPDATE.yml` | 2 | schedule, workflow_dispatch | 0 * * * * | writes-repo:68 | kept until wave 2, then T6 scheduled job (bot account) |
| `DEPLOY-CLOUDFLARE-WORKERS.yml` | 12 | push, workflow_dispatch | – | – | kept until wave 2; production deploy on push today: auto on merge versus PUBLISH is an owner decision in the wave 2 plan |
| `DEV-AUTOPILOT-IMPACT.yml` | 14 | pull_request, push, workflow_dispatch | – | – | T1 checks + T2 after-merge job at wave 2 |
| `DEV-AUTOPILOT.yml` | 9 | schedule, workflow_dispatch | 0 7,19 * * * | – | kept until wave 2, then T6 scheduled job |
| `DRIVER-WAKE.yml` | 11 | workflow_run, push, workflow_dispatch | – | – | retired at wave 2: GitLab events reach the gateway, which wakes drivers |
| `E2E-ORB-MONITOR.yml` | 3 | schedule, workflow_dispatch | */15 * * * * | – | kept until wave 2, then T6 scheduled job |
| `E2E-TEST-RUN.yml` | 10 | repository_dispatch, workflow_dispatch | – | – | kept until wave 2, then T6 dispatched job |
| `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` | 4 | pull_request | – | – | T1 check that runs only when its own files change (same rule) at wave 2; "validate" is a required status on main today |
| `EXERCISE-STAGING-SHADOW-CORPUS.yml` | 22 | schedule, workflow_dispatch | 35 7 * * * | – | kept until wave 2, then T6 scheduled job |
| `EXERCISE-STAGING-SHADOW.yml` | 20 | schedule, workflow_dispatch | 30 7 * * * | – | kept until wave 2, then T6 scheduled job |
| `I18N-DB-SEED.yml` | 20 | workflow_dispatch, repository_dispatch, schedule | 0 5 * * * | role:118 keys:119 writes-repo:70 | kept until wave 2, then T7 assist (opens an MR) + T6 for its database part |
| `JOURNEY-TRANSLATIONS-BACKFILL.yml` | 12 | workflow_dispatch | – | – | kept until wave 2, then T6 owner-dispatched job |
| `MARKETPLACE-SYNC-CRON.yml` | 23 | schedule, workflow_dispatch | 0 3 * * * | – | kept until wave 2, then T6 scheduled job |
| `MIGRATION-DRIFT-CHECK.yml` | 24 | pull_request, schedule, workflow_dispatch | 40 7 * * * | role:131 | T1 check + T6 scheduled at wave 2 |
| `MOBILE-DEVICE-E2E.yml` | 23 | workflow_dispatch | – | – | kept until wave 2, then T6 owner-dispatched job |
| `MORNING-SYSTEM-HEALTH-CHECK.yml` | 62 | schedule, workflow_dispatch | 0 6 * * * | – | kept until wave 2, then T6 scheduled job |
| `OASIS-PERSISTENCE.yml` | 6 | pull_request, push | – | – | T1 checks at wave 2 |
| `OPS-TOGGLE-FLOW-V3-STAGING.yml` | 13 | workflow_dispatch, push | – | – | kept until wave 2, then T6 dispatched job |
| `ORB-TOOLS-LIFT-SCANNER.yml` | 21 | pull_request, push, workflow_dispatch | – | – | T1 checks at wave 2 |
| `PHASE-2B-DOC-GATE.yml` | 2 | pull_request | – | – | T1 check that runs only when phase_2b/ changes (same rule) at wave 2 |
| `PHASE-2B-NAMING-ENFORCEMENT.yml` | 3 | pull_request, push | – | – | T1 check on changed files only (same rule) at wave 2 |
| `PLAN-SPAR.yml` | 23 | pull_request_target | – | writes-repo:115 | kept until wave 2; GitLab twin (plan-spar job) built beside it; protected gate file, retired at the platform cutover on the owner's instruction naming the plan |
| `PR-GATE.yml` | 14 | pull_request | – | – | T1 governance at wave 2; protected gate file: GitLab twin built beside it, retired at the platform cutover on the owner's instruction naming the plan |
| `REGEN-SCREENS-CATALOG.yml` | 22 | push, repository_dispatch, workflow_dispatch | – | – | kept until wave 2, then T7 assist (opens an MR) |
| `REUSABLE-NOTIFY.yml` | 3 | workflow_call | – | – | folded into the templates at wave 2, retired |
| `RUN-MIGRATION.yml` | 2 | workflow_dispatch | – | role:151 | kept until wave 2, then one T6 owner-dispatched migration job (collaboration.md §7d unchanged) |
| `SCREEN-LOAD-DAILY.yml` | 19 | schedule, workflow_dispatch | 52 5 * * * | – | kept until wave 2, then T6 scheduled job |
| `SCREEN-LOAD-TIMING.yml` | 18 | schedule, workflow_dispatch | 7,37 * * * * | – | kept until wave 2, then T6 scheduled job |
| `SET-STAGING-TENANT-CONSENT.yml` | 18 | workflow_dispatch | – | – | kept until wave 2, then T6 owner-dispatched job |
| `SETUP-OPERATOR-MEDIA-BUCKET.yml` | 10 | workflow_dispatch | – | – | kept until wave 2, then T6 owner-dispatched job or retired |
| `SMOKE-WELCOME-GREETING.yml` | 27 | workflow_dispatch, workflow_run, schedule | 0 7 * * * | – | kept until wave 2, then T6 scheduled job |
| `SQL-ACTIVITY-TIERS.yml` | 9 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-AUTH-BRIDGE.yml` | 12 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-COMMUNITY-EVENT-CALENDAR.yml` | 9 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-COMPANION-WIRING.yml` | 9 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-ERASE-USER-DATA.yml` | 12 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-HEALTH-SOURCES.yml` | 12 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-HEALTH-STORE.yml` | 12 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-INDEX-MOVEMENTS.yml` | 10 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-LIVE-ROOM-CALENDAR.yml` | 8 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-LIVE-ROOM-HOST-CALENDAR.yml` | 9 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE.yml` | 11 | pull_request, push, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-MEMORY-SENSITIVITY.yml` | 10 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-PARTNER-REVIEW.yml` | 9 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-PARTNER-TERMS.yml` | 11 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-RECORD-MIGRATION-ROW.yml` | 11 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-REMINDERS-IN-CALENDAR.yml` | 8 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-SUBSCRIPTION-DATES-IN-CALENDAR.yml` | 8 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-SUPPLIER-LISTING-GATE.yml` | 8 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-TENANT-FOUNDATION.yml` | 12 | pull_request, push, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-TEST-RESULTS-IN-CALENDAR.yml` | 8 | pull_request, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `SQL-WEARABLE-SAMPLES-RPC-REVOKE.yml` | 11 | pull_request, push, workflow_dispatch | – | – | T1 sql-tests at wave 2; kept on GitHub until the platform cutover |
| `STAGING-TESTS-REQUIRED.yml` | 14 | pull_request | – | – | T1 change-suite at wave 2 |
| `STAGING-VERIFY-NIGHTLY.yml` | 13 | schedule, workflow_dispatch | 17 2 * * * | – | community-app part replaced by T3 at wave 1; gateway part T3 at wave 2 |
| `STAGING-VERIFY.yml` | 43 | workflow_run, repository_dispatch, workflow_dispatch | – | – | community-app part replaced by T2 at wave 1; gateway part T2 at wave 2 |
| `TENANT-RESERVED-SLUGS-DRIFT.yml` | 13 | schedule, workflow_dispatch | 17 6 * * 1 | – | kept until wave 2, then T6 scheduled job |
| `TEST-CATALOG.yml` | 19 | push, schedule, workflow_dispatch | 23 4 * * * | role:90 s3:96 | kept until wave 2, then T2 after-merge + T6 scheduled |
| `TEST-SUITE-RERUN.yml` | 12 | workflow_run | – | – | retired at wave 2: GitLab retry on runner failures |
| `TEST-SUITE.yml` | 17 | pull_request, push, schedule, workflow_dispatch | 17 3 * * * | – | T1 checks + T2/T3 full suite at wave 2 |
| `UNIT.yml` | 2 | pull_request | – | – | T1 checks + T2/T3 full suite at wave 2 |
| `VALIDATOR-CHECK.yml` | 4 | pull_request | – | – | T1 checks at wave 2 |
| `VCAOP-CICD.yml` | 11 | pull_request, push | – | – | retired (dead; ci-github-modernization lane dead-workflows) |
| `VCAOP-GUARDRAILS-CI.yml` | 7 | pull_request, push | – | – | T1 checks at wave 2 |
| `VCAOP-HEALTH.yml` | 11 | schedule, workflow_dispatch | 0 * * * *; 30 6 * * * | – | kept until wave 2, then T6 scheduled job |
| `VISUAL-VERIFY-FRONTEND.yml` | 5 | repository_dispatch, workflow_dispatch | – | – | kept until wave 2, then a T5 post-publish check |
| `VOICE-PIPELINE-PARITY-SCANNER.yml` | 10 | pull_request, push, workflow_dispatch | – | – | T1 checks at wave 2 |
| `VOICE-TOOLS-MANIFEST-RECONCILE.yml` | 19 | pull_request, push, workflow_dispatch | – | – | T1 checks at wave 2 |
| `VTID-02409-BOOTSTRAP.yml` | 3 | push, workflow_dispatch | – | – | retired (one-off bootstrap, GCP-era) |
| `VTID-AUTO-CLOSE.yml` | 21 | pull_request | – | – | vitana-v1 part replaced by the T2 vtid-close job at wave 1 (same script); platform part at wave 2 |

## vitana-v1

| File | on: (line) | Triggers | Cron | Flags | Fate |
|---|---|---|---|---|---|
| `AWS-PROD-DEPLOY-FRONTEND.yml` | 41 | workflow_call, workflow_dispatch | – | image:244 keys:37 ecs:276 | kept on GitHub (PUBLISH dispatch only) until wave 2, then T5 publish; protected gate file |
| `AWS-STAGE-DEPLOY-FRONTEND.yml` | 33 | push, workflow_dispatch | – | image:187 role:152 keys:13 ecs:220 | T2 main-delivery: build, push by digest, staging deploy, STAGING-VERIFY (wave 1); disabled at the v1 cutover |
| `CALENDAR-REGRESSION.yml` | 20 | pull_request, push, workflow_dispatch | – | – | T1 checks (wave 1); disabled at the v1 cutover |
| `DEPLOY.yml` | 29 | push, workflow_dispatch | – | – | kept on GitHub (wrapper of the production deploy; push runs frozen by cutover_gate) until wave 2, then retired with T5 |
| `E2E-PREVIEW-ORB.yml` | 5 | workflow_dispatch, push | – | – | T4 preview verify step (wave 1); disabled at the v1 cutover |
| `I18N-PROPAGATE.yml` | 29 | pull_request, push, schedule, workflow_dispatch | 0 4 * * * | writes-repo:163 | T7 assist i18n-propagate (wave 1); disabled at the v1 cutover |
| `NATIVE-CI.yml` | 28 | pull_request, push, schedule, workflow_dispatch | 17 5 * * * | – | T1 mobile checks + T3 nightly (wave 1); disabled at the v1 cutover |
| `PR-GATE.yml` | 15 | pull_request | – | – | T1 governance + checks (wave 1); disabled on GitHub at the v1 cutover; protected gate file: deleted later only on the owner's instruction naming the plan |
| `PREVIEW-DEPLOY-FRONTEND.yml` | 27 | pull_request | – | role:113 keys:71 s3:124 | T4 preview (wave 1); disabled at the v1 cutover |
| `PREVIEW-TEARDOWN-FRONTEND.yml` | 16 | pull_request | – | role:62 keys:46 | T4 preview teardown (wave 1); disabled at the v1 cutover |
| `SCREENS-CATALOG-TRIGGER.yml` | 6 | push, workflow_dispatch | – | – | T2 job notify-platform (wave 1, until wave 2); disabled at the v1 cutover |
| `SQL-CALENDAR-ENTRY-SHARE.yml` | 8 | pull_request, workflow_dispatch | – | – | T1 sql-tests + T2/T3 full suite (wave 1); disabled on GitHub at the v1 cutover |
| `SQL-EVENT-SHARE-POSTS.yml` | 8 | pull_request, workflow_dispatch | – | – | T1 sql-tests + T2/T3 full suite (wave 1); disabled on GitHub at the v1 cutover |
| `SQL-GROUP-PARTICIPANTS.yml` | 7 | pull_request, workflow_dispatch | – | – | T1 sql-tests + T2/T3 full suite (wave 1); disabled on GitHub at the v1 cutover |
| `SQL-THREAD-JOIN-HARDENING.yml` | 8 | pull_request, workflow_dispatch | – | – | T1 sql-tests + T2/T3 full suite (wave 1); disabled on GitHub at the v1 cutover |
| `STAGE-DEPLOY-FRONTEND.yml` | 46 | workflow_dispatch | – | – | retired (Cloud Run era, dead); disabled at the v1 cutover |
| `STAGING-TESTS-REQUIRED.yml` | 19 | pull_request | – | – | T1 change-suite (wave 1); disabled at the v1 cutover |
| `SUPABASE-FUNCTIONS-RETIRE.yml` | 18 | workflow_dispatch | – | – | kept on GitHub (owner dispatch) until wave 2, then T6 or retired |
| `UNIT-TESTS.yml` | 12 | pull_request, push, schedule, workflow_dispatch | 47 3 * * * | – | T1 checks + T2/T3 full suite (wave 1); disabled at the v1 cutover |
| `WHATS-NEW-DRAFT.yml` | 18 | push, workflow_dispatch | – | role:93 writes-repo:143 | T7 assist whats-new-draft after landing (wave 1); disabled at the v1 cutover |
| `apply-comment-reactions-replies-migration.yml` | 16 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-cumulative-like-notifications-migration.yml` | 15 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-feed-video-interactions-migration.yml` | 14 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-fix-community-notify-name-fallback-migration.yml` | 15 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-july-19-kira-ticket-price-migration.yml` | 7 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-live-stream-interested-list-migration.yml` | 14 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-live-subscribers-migration.yml` | 14 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-localize-post-interaction-notifications-migration.yml` | 13 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-mentions-migration.yml` | 16 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-notify-name-fallback-full-name-migration.yml` | 17 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-notify-on-community-publish-migration.yml` | 14 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-notify-on-post-mention-migration.yml` | 18 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-post-interaction-notifications-migration.yml` | 18 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-post-notification-deeplink-migration.yml` | 12 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-vtid-03319-phase2-migration.yml` | 13 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-vtid-04916-event-share-posts-migration.yml` | 19 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-vtid-04955-group-participants-migration.yml` | 16 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-vtid-04960-thread-join-hardening-migration.yml` | 17 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-vtid-05126-calendar-entry-share-migration.yml` | 21 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-vtid-05133-ai-discoverable-migration.yml` | 17 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `apply-vtid-05206-community-intro-opt-in-migration.yml` | 17 | workflow_dispatch | – | – | kept on GitHub (owner-approved dispatch, collaboration.md §7d) until wave 2, then one T6 owner-dispatched migration job; applied one-offs retired |
| `i18n-audit-llm.yml` | 25 | workflow_dispatch | – | writes-repo:123 | T7 assist i18n-audit (wave 1, owner run); disabled at the v1 cutover |
| `i18n-check.yml` | 7 | pull_request, push | – | – | T1 i18n checks (wave 1); disabled at the v1 cutover |
| `i18n-long-words.yml` | 13 | workflow_dispatch | – | writes-repo:63 | T7 assist i18n-long-words (wave 1, owner run); disabled at the v1 cutover |
| `i18n-translate.yml` | 15 | workflow_dispatch | – | writes-repo:183 | T7 assist i18n-translate (wave 1, schedule or owner run); disabled at the v1 cutover |
| `supabase-functions-deploy.yml` | 15 | push, workflow_dispatch | – | – | kept on GitHub (owner dispatch; push runs frozen by cutover_gate) until wave 2, then T6 owner-dispatched production job |
