# VTID-04215 — Dev Autopilot: recognise the AWS deploy topics so auto-merged work stops being reverted

## Root cause

`AWS-STAGE-DEPLOY-GATEWAY.yml` records a finished staging deploy in
`oasis_events` under topic `staging.deploy.completed` (`staging.deploy.failed`
on failure), with `metadata.git_commit` = the deployed `main` SHA. The prod
workflow writes `prod.deploy.completed` / `prod.deploy.failed`.

The Dev Autopilot deploy watcher (`dev-autopilot-watcher.ts`,
`loadRecentDeployEvents`) and the deploying-stage reconciler
(`dev-autopilot-execute.ts`, `reconcileDeploying`) queried only the GCP-era
topics — `deploy.gateway.success`, `deploy.gateway.failed`,
`cicd.deploy.service.succeeded`, `deploy.success`, `vtid.lifecycle.deployed` —
which the dead `EXEC-DEPLOY.yml` used to emit. No AWS workflow has ever
written one of those. So after the watcher squash-merged a PR and moved the
row to `deploying`, nothing could ever advance it: at the reconciler's
30-minute timeout the row was failed with "no deploy success event observed"
and `bridgeFailure(…, 'deploying', …)` opened and auto-merged a revert of the
merge commit.

Observed on 2026-09-20 (GitHub Actions runs 473/474/475/476 and the
`oasis_events` rows): executions `141c4e4b` (VTID-04134) and `f64f22e2`
(VTID-04135) auto-merged at 20:06 and 20:11 UTC, their staging deploys
succeeded by 20:15 and 20:23 UTC, and both were reverted from `main` at 20:38
and 20:43 UTC — correct, CI-green, deployed work deleted by the pipeline
itself. This made auto-merge structurally destructive: every execution that
reached `deploying` was guaranteed to be reverted.

## Fix

New `dev-autopilot-deploy-topics.ts` owns the contract:

- `deployTopicsForEnv(env)` — the only topic list either consumer queries:
  the AWS topics for the process's own `VITANA_ENV` (a staging gateway must
  never take a production deploy as proof its merge shipped, and vice versa)
  plus the legacy topics so a still-stored legacy row keeps working.
- `normalizeDeployEvent(row)` — maps an AWS row onto the
  `deploy.gateway.success|failed` + `branch:'main'` + `git_commit` shape
  `findDeployOutcomeForExecution` already matches on; legacy rows pass through.
- `resolveDeployOutcome(events, {mergeSha, sinceIso})` — the reconciler's
  pure decision: exact `git_commit === merge_sha` first, then the same
  queued-merge fallback the watcher has had since VTID-02700 (a later
  successful `main` deploy after the merge carries the merge; GitHub Actions
  `concurrency` cancels intermediate runs — run 478 that evening was cancelled
  exactly so), fail beating success.

The watcher's loader and the reconciler both use it. The reconciler now also
fails a row on an observed deploy FAILURE (previously it could only fail on
absence). A drift test reads both workflow files and fails if their topic
strings ever diverge from the module.

## Acceptance Criteria

AC-1 — The success/failure topic strings in `AWS-STAGE-DEPLOY-GATEWAY.yml` and `AWS-PROD-DEPLOY-GATEWAY.yml` are exactly the ones the consumers query, and the workflows write `metadata.git_commit`.
TEST: services/gateway/test/vtid-04215-deploy-event-contract.test.ts — "staging workflow emits exactly the success/failure topics this module names" and "production workflow emits …" (`npx jest services/gateway/test/vtid-04215-deploy-event-contract.test.ts`).

AC-2 — A staging process queries `staging.deploy.*` plus legacy and never `prod.deploy.*`; production (or unset) the reverse.
TEST: services/gateway/test/vtid-04215-deploy-event-contract.test.ts — "staging queries its own AWS topics plus legacy, never the prod topics" / "production (or unset) queries the prod topics, never staging".

AC-3 — `normalizeDeployEvent` maps the AWS topics onto the watcher's success/failure types with `branch` defaulted to `main`, keeps `git_commit`, and passes legacy topics through unchanged (null metadata tolerated).
TEST: services/gateway/test/vtid-04215-deploy-event-contract.test.ts — the five "normalizeDeployEvent" cases.

AC-4 — The exact reverted case: a `staging.deploy.completed` row for the merge SHA after the merge now resolves to `success` in the watcher; a later `main` deploy of a different SHA also resolves to `success`; a failed deploy resolves to `failed`; a pre-merge deploy does not count; the raw un-normalized row still would not match (normalization is load-bearing).
TEST: services/gateway/test/vtid-04215-deploy-event-contract.test.ts — the five "the watcher recognises a normalized staging deploy" cases.

AC-5 — `resolveDeployOutcome` prefers the exact `merge_sha` match, falls back to a later successful `main` deploy, lets a failure beat a success, ignores events before the watermark, returns `pending` with no events, and keeps the recency behaviour for rows without `merge_sha`.
TEST: services/gateway/test/vtid-04215-deploy-event-contract.test.ts — the six "resolveDeployOutcome" cases.

AC-6 — Existing watcher behaviour for legacy events is unchanged.
TEST: services/gateway/test/dev-autopilot-watcher.test.ts (31 pre-existing tests, re-run green).

## Verification

- `tsc --noEmit` (services/gateway): clean.
- `test/vtid-04215-deploy-event-contract.test.ts`: 19/19 passing.
- `test/dev-autopilot-watcher.test.ts`, `test/dev-autopilot-execute.test.ts`,
  `test/dev-autopilot-bridge.test.ts`, `test/dev-autopilot-env-ownership.test.ts`,
  `test/self-healing-reconciler-autopilot-link.test.ts`: 90/90 passing.

## Not verified

No live execution has passed `deploying` on this code yet — that needs a
real auto-merge on staging after this merges and deploys. The next real
signal is a `dev_autopilot.execution.deployed` event whose payload carries
`deploy_topic: "staging.deploy.completed"` and `matched_by: "merge_sha"` (or
`post_merge_main`), followed by `verifying` → `completed`, with no revert PR.
Production-owned rows still cannot pass `deploying` on a push, because prod
deploys only on PUBLISH — that is pre-existing and out of scope here.
