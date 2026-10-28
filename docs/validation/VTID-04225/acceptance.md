# VTID-04225 — Dead GCP gateway URLs in `.github/workflows`: repoint the loop-feeding workflows to AWS staging, retire the GCP-only ones, pin it

## Reported

Platform owner, 2026-09-21: the autonomous Dev Autopilot loop
(`autoApproveTick → lazyPlanTick → executor → watcher → self-heal`) and the
self-healing chain (`routes/self-healing.ts → diagnosis → injector → executor`)
are built but STARVED. Root cause named in the brief: the workflows that feed
them still POST to the GCP Cloud Run gateway `gateway-q74ibpv6ia-uc.a.run.app`,
deleted 2026-08-16 (VTID-03599/VTID-03649).

## Verified before touching anything

- `DEV-AUTOPILOT.yml` run #324 (2026-09-21 13:36 UTC, `schedule`): the scanner
  produced 2,327 signals, then `POST failed 404: <html>… 404 Page not found`
  against the dead host. Every scheduled run in the list is `failure`
  (`outputs/dev-autopilot-run-324-failure.txt`).
- `E2E-ORB-MONITOR.yml` runs #2755–#2757: the `hub` matrix leg hangs against
  the dead `HUB_URL` until the 5-minute job timeout (`cancelled`), so its
  `Report failure to self-healing` step is skipped and nothing ever reaches
  `/api/v1/self-healing/report`.
- 46 workflow files referenced `*.run.app` or `lovable-vitana-vers1`
  (`outputs/dead-url-workflows-before.txt`), not the 9 the brief named.
- Read off the LIVE task definitions (`vitana-gateway` rev 489,
  `vitana-gateway-awsdr` rev 114, `outputs/task-def-env-names.txt`): neither
  carries `DEV_AUTOPILOT_SCAN_TOKEN` or `GATEWAY_INTERNAL_TOKEN`; staging has
  no `GATEWAY_SERVICE_TOKEN` at all (prod maps it to the
  `vitana/supabase/prod/service-role-key` secret). So even with a live URL,
  `requireScanToken` would have rejected every scan ("DEV_AUTOPILOT_SCAN_TOKEN
  not set — rejecting all scan posts") and `requireServiceOrAdmin` would have
  401'd every self-healing report on staging. The repo secret
  `DEV_AUTOPILOT_SCAN_TOKEN` exists (masked `***` in the run log).

## Classification of the 46 files

REPOINTED to AWS staging (`https://preview-aws-gateway.vitanaland.com`,
frontend `https://preview-aws.vitanaland.com`) — every one runs on GitHub
runners and needs nothing from GCP: `DEV-AUTOPILOT.yml` (now with a
`gateway_url` dispatch input; the cron can only ever hit staging),
`DEV-AUTOPILOT-IMPACT.yml`, `E2E-ORB-MONITOR.yml`, `E2E-TEST-RUN.yml`,
`SCREEN-LOAD-TIMING.yml`, `REUSABLE-NOTIFY.yml`, `VISUAL-VERIFY-FRONTEND.yml`,
`SET-STAGING-TENANT-CONSENT.yml`, `CRON-SHADOW-COMPARISON-REPORT.yml`,
`EXERCISE-STAGING-SHADOW.yml`, `EXERCISE-STAGING-SHADOW-CORPUS.yml`,
`OPS-TOGGLE-FLOW-V3-STAGING.yml`; plus the non-workflow defaults they share:
`e2e/playwright.config.ts`, `e2e/fixtures/test-users.ts`,
`scripts/ci/dev-autopilot-scan.mjs` (comment + the `deploy-smoke` gap entry
that pointed at `EXEC-DEPLOY.yml`).

RETIRED (deleted; every one authenticates to or deploys onto GCP —
`google-github-actions/auth`, `gcloud`, GCS, Vertex custom jobs — and has
been failing or unrunnable since billing went off; CLAUDE.md §9 already
listed them as dead cleanup candidates): `BIND-STAGING-SERVICE-TOKEN`,
`BOOTSTRAP-LIVEKIT-SECRETS`, `CANARY-READINESS-REPORT`,
`CRON-AUTOPILOT-BACKLOG-CONVERSION-PLAN`, `CRON-AUTOPILOT-BACKLOG-DRAIN-PLAN`,
`CRON-CONTEXT-QUALITY-SCORE`, `CRON-CONTEXT-SOURCE-INVENTORY`,
`CRON-DATASET-EXTRACTION`, `CRON-FINETUNE-STATUS`, `CRON-FINETUNE-TRAINER`,
`DEBUG-GATEWAY-LOGS`, `DEPLOY-AUTOPILOT-JOB` (was firing on every push to
`main`), `DEPLOY-ORB-AGENT`, `DESCRIBE-VERTEX-CUSTOMJOB`, `DIAGNOSE-AUTOPILOT`,
`ENABLE-GOOGLE-OAUTH-APIS`, `EXEC-DEPLOY`, `GRANT-WIF-STAGING-SECRETS`,
`MAP-DOMAIN`, `MCP-GATEWAY-CI`, `MIRROR-ARTIFACTS-S3`, `PHASE-EVIDENCE-DIGEST`,
`PHASE-GATE-STATUS-REPORT`, `PROVISION-MEMORYSTORE`, `RUN-STAGING-MIGRATION`,
`SET-AUTOPILOT-USE-JOB`, `SET-OPENAI-KEY`, `SMOKE-AWS-MIRROR`,
`SMOKE-LIVEKIT-TESTS`, `STAGE-ARTIFACTS-GCS`, `STAGE-DEPLOY`,
`UPDATE-GATEWAY-ENV`, `UPDATE-GATEWAY-LIVEKIT-ENV`, `VTID-OPS-JOURNEY-V2`
(one-shot governance registration for PR #2672, already executed).
`SMOKE-WELCOME-GREETING.yml`'s `workflow_run` on the retired EXEC-DEPLOY was
re-pointed at `AWS Stage Deploy Gateway (ECS)`. Git history keeps every file.

Of the four the brief asked to classify explicitly: `DEPLOY-ORB-AGENT.yml`,
`EXEC-DEPLOY.yml`, `SET-OPENAI-KEY.yml`, `VTID-OPS-JOURNEY-V2.yml` → all
RETIRE (Cloud Run deploy / `gcloud run services update` / a finished one-shot).

## Credentials wired onto the STAGING task def (`AWS-STAGE-DEPLOY-GATEWAY.yml`)

- `DEV_AUTOPILOT_SCAN_TOKEN` — plain env var from the repo secret of the same
  name (the `MARKETPLACE_SYNC_SECRET` precedent on the prod workflow).
- `GATEWAY_SERVICE_TOKEN` — Secrets Manager reference to
  `vitana/supabase/prod/service-role-key`, byte-identical to what the prod
  task def already maps it to, so the repo secret `GATEWAY_SERVICE_TOKEN` the
  E2E workflows send is accepted by the same comparison on both stacks.
- `GATEWAY_INTERNAL_TOKEN` — OPTIONAL (ERP-bridge pattern): wired only once
  `vitana/gateway/staging/internal-token` exists (VTID-04226's
  `scripts/aws/setup-gateway-internal-token.sh`). Never fails a deploy.
- None of the three is added to `AWS-PROD-DEPLOY-GATEWAY.yml`.
- The register step's `run:` block had to stay under the VTID-03788 20,000-char
  guard: two large comment blocks (VTID-04000, VTID-03591) moved out of the
  script to the comment area above it (bash no-ops either way).

## Acceptance criteria

AC-1 No `.github/workflows/*.yml` references a `*.run.app` host or `lovable-vitana-vers1`; the guard fails the build if one returns.
TEST: services/gateway/test/vtid-04225-no-dead-gcp-urls-in-workflows.test.ts — "no workflow references a Cloud Run host (*.run.app)" / "…decommissioned GCP project id"

AC-2 DEV-AUTOPILOT.yml, DEV-AUTOPILOT-IMPACT.yml, E2E-ORB-MONITOR.yml, E2E-TEST-RUN.yml, SCREEN-LOAD-TIMING.yml target the AWS STAGING gateway; the scan cron cannot reach prod without an explicit `gateway_url` dispatch input.
TEST: services/gateway/test/vtid-04225-no-dead-gcp-urls-in-workflows.test.ts — "the loop-feeding workflows target the AWS STAGING gateway"

AC-3 The retired GCP-only workflows are deleted, and the one workflow_run consumer of EXEC-DEPLOY is re-pointed.
TEST: services/gateway/test/vtid-04225-no-dead-gcp-urls-in-workflows.test.ts — "the retired GCP-only workflows are gone" / "SMOKE-WELCOME-GREETING.yml no longer waits on the retired EXEC-DEPLOY"

AC-4 The e2e harness defaults (`playwright.config.ts`, `fixtures/test-users.ts`) match the workflows.
TEST: services/gateway/test/vtid-04225-no-dead-gcp-urls-in-workflows.test.ts — "the e2e harness defaults match the workflows"

AC-5 The staging task def gets `DEV_AUTOPILOT_SCAN_TOKEN`, `GATEWAY_SERVICE_TOKEN` and (optionally) `GATEWAY_INTERNAL_TOKEN`; the prod workflow is untouched; the staging register step stays under the 20,000-char guard and passes `bash -n`.
TEST: services/gateway/test/vtid-04225-no-dead-gcp-urls-in-workflows.test.ts — "the staging gateway task def carries the credentials"
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-6 Every existing test that pins a workflow's shape still passes (27 suites read `.github/workflows`).
TEST: services/gateway/test/vtid-03850-staging-executor-dispatch-pinned.test.ts
TEST: services/gateway/test/vtid-04037-staging-operator-agent-flags-pinned.test.ts
TEST: services/gateway/test/scripts/validator-path-guard.test.ts

## Not verified here

The repointed workflows are only proven live once this merges and the staging
gateway redeploys with the new task def — that is VTID-04228's evidence pack
(`docs/validation/VTID-04228/`): a `workflow_dispatch` of DEV-AUTOPILOT.yml
answering 2xx from `preview-aws-gateway`, rows in `autopilot_recommendations`,
and a self-healing report row from E2E-ORB-MONITOR.yml. A green workflow run
is not that evidence (§15).
