---
change_class: standard
---
# plan(pm-ci-load): superseded PR runs cancel, and the Project Manager gets its own GitHub App identity
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610271503-9458` (Kiro Web). Repo: `exafyltd/vitana-platform`
only. Premises pinned to `origin/main` `fe4495db71`. Detail per lane: `tasks.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web), P1: *"Help get the no-op-write fix in #4396 completed … Work with the CI modernization
effort to prevent unnecessary heavy jobs on PM bookkeeping branches while retaining checks those changes actually
need. Investigate a dedicated GitHub App for the PM, with only the permissions it needs. If that is not practical in
our environment, propose a dedicated account/token instead. Prepare the configuration and document any setup action
that genuinely requires me or an administrator. Measure the effect on CI volume, queue time, and rate-limit
failures."* The root cause (the PM re-writing unchanged lanes) is fixed by plan `pm-reassign-idempotent` (#4396,
another session); this plan is the second, independent guard plus the identity split.

## 2. Today (`fe4495db71`)
1. Volume (pipeline analysis, 2026-10-27): `pm-agent/*` commits 2026-10-26T04Z → 10-27T11Z ran at 336-378 per hour
   (3,912 `update` + 3,687 `parked` in 24 h); in a 1.9 h window they caused 811 of 1,000 platform workflow runs and
   93% of runner minutes. Their `unit` jobs queued 6-11 min while the job itself runs ~30 s.
2. `.github/workflows/UNIT.yml:1-20` (required check `unit`) and `.github/workflows/PHASE-2B-DOC-GATE.yml:1-5` have
   **no `concurrency`**: every push of a PR queues a full run even when a newer push of the same PR exists (0 of 134
   and 0 of 131 runs cancelled in that window). `PR-GATE.yml` and `DEV-AUTOPILOT-IMPACT.yml` already cancel superseded
   runs (103 and 91 cancelled). `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` and `PHASE-2B-NAMING-ENFORCEMENT.yml` belong
   to lane `ci-push-to-result/platform-gate-install` (#4409, asked there); `STAGING-TESTS-REQUIRED.yml` is in lane
   `retire-claude-code/ci-runner-platform` — both left alone.
3. Identity: the PM's REST calls use `repoGitHubToken(repo) || GITHUB_SAFE_MERGE_TOKEN`
   (`services/gateway/src/services/project-manager/github-rest.ts:20-24`), i.e. Secrets Manager `vitana/github/pat`
   (`AWS-STAGE-DEPLOY-GATEWAY.yml:1092`, `:1290`), a PAT of the `exafyltd` user. PM commits show author `exafyltd`.
   Kiro Web sessions and `PLATFORM_DISPATCH_TOKEN` (vitana-v1 PR-GATE Lane scope, `vitana-v1/.github/workflows/PR-GATE.yml:305`)
   act as the same user, so they share one 5,000/h REST budget: 55 vitana-v1 Lane-scope / staging-guard job failures
   in 14 days were `API rate limit exceeded for user ID 171726573` (`exafyltd`).
4. The PM uses only these REST endpoints (`github-rest.ts`, `writers.ts`, `observe-live.ts`, `lease.ts`): repo
   contents read/write, git refs create/update, trees/blobs/commits read, pulls list/create/read/files/commits,
   `pulls/:n/update-branch`, `compare`, commit check-runs read, `actions/variables/:name` read. Merges go through the
   gateway safe-merge service (`act.ts:240-246`), not through `github-rest.ts`.
5. `jose` is already a gateway dependency (`services/gateway/package.json`), so an App JWT (RS256) needs no new package.

## 3. Lanes
### Lane 1 `pr-ci-concurrency` (executor kiro, reviewer agent; governance paths, no protected gate file)
1. Add to `UNIT.yml` and `PHASE-2B-DOC-GATE.yml`:
   `concurrency: { group: <workflow>-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: true }`.
   A superseded push's run is cancelled; the newest head of every PR still runs every job, so the required check that
   merges is always the one on the head (same pattern as `PR-GATE.yml`). No `paths:`/`paths-ignore:` filter and no
   branch condition, so no required check can stay pending and no PR skips a check.
2. `scripts/ci/workflow-concurrency/concurrency.test.mjs` (run by `UNIT.yml`'s `find scripts … *.test.mjs`): both
   files have the block; neither has a trigger-level path filter; the group key includes the PR number. Red on base.

### Lane 2 `pm-app-token` (executor kiro, reviewer agent; gateway code, deploys to staging)
1. New `services/gateway/src/services/project-manager/github-app-token.ts`: when `PM_GITHUB_APP_ID`,
   `PM_GITHUB_APP_PRIVATE_KEY` (PEM) and `PM_GITHUB_APP_INSTALLATION_ID` are all set, mint an RS256 App JWT with
   `jose` (iat −60 s, exp +9 min), exchange it at `POST /app/installations/<id>/access_tokens` with
   `repositories: [vitana-platform, vitana-v1]` and the permissions of §4, cache the token until 5 min before
   `expires_at`, single-flight refresh. Any of the three unset → `null`.
2. `github-rest.ts` `token(repo)`: App token first, else today's resolution, unchanged. A refresh failure is logged
   (`pm.github_app.token_failed`, no secret material) and the call uses today's token, so the PM never stops on the
   App. The safe-merge path is unchanged.
3. Tests (`services/gateway/test/project-manager/github-app-token.test.ts`, red on base): unset → `null` and
   `token()` returns today's value; JWT claims (`iss`, `iat`, `exp`, alg RS256) with a generated test key; cache
   reuse and refresh at the 5-min margin; concurrent callers share one exchange; exchange 401/5xx → fallback +
   one log line; the request body asks for exactly the §4 permissions.
4. `docs/project-manager/github-app.md`: why, the permissions, the setup steps of §5, how to verify (PM commits
   authored `vitana-pm[bot]`), how to roll back (unset the variables).
5. Staging proof (`docs/validation/<VTID>/staging-tests.json`, read-only): gateway alive; PM mode endpoint serves.
   With the App variables unset on staging the behaviour is unchanged, which is what is verified.
6. **Sequencing:** merge only after `pm-reassign-idempotent/reassign-noop` has merged (its staging deploy pin keeps
   the PM paused); otherwise this lane's gateway deploy would re-enable the PM loop (§2.1 and #4396 item 4).

## 4. App permissions (least privilege, both repos)
Repository: Contents read & write; Pull requests read & write; Checks read; Commit statuses read; Actions read
(variables are under "Variables" read); Metadata read (mandatory). No Administration, no Workflows write, no
Secrets, no Organization permissions, no webhook. Branch protection is not bypassed (the App is not in a bypass
list). If the App ever needs to edit `.github/workflows/**` it must not — the PM never writes workflow files.

## 5. Owner / administrator actions (only an org owner can do these)
1. Create a GitHub App in org `exafyltd` (Settings → Developer settings → GitHub Apps), name `vitana-pm`, webhook
   off, permissions of §4, "Only on this account".
2. Install it on `exafyltd/vitana-platform` and `exafyltd/vitana-v1` only; note the installation id.
3. Generate a private key; store it in AWS Secrets Manager `vitana/gateway/staging/pm-github-app-key` (and later
   `…/prod/…`), and the app id + installation id as plain values.
4. Then a follow-up lane (not in this plan; it edits `AWS-STAGE-DEPLOY-GATEWAY.yml`, shared with #4396 and
   `ci-ecr-public-auth`) wires the three into the staging task definition.
**Fallback if an App is not allowed:** a dedicated machine user (`vitana-pm-bot`) with a fine-grained PAT limited to
the two repos and the §4 permissions, stored the same way; same code path via `PM_GITHUB_TOKEN` is *not* added now
(one mechanism at a time); the App is preferred because its installation token has its own rate limit (≥ 5,000/h,
scaling with repos) and expires hourly.

## 6. Measurement
Before (§2.1, analysis window 2026-10-27T10:23-12:17Z) and after, from the Actions API: runs per hour on
`pm-agent/*` and overall; `unit` job queue p50/p90 (created → started); cancelled share of `unit`/doc-gate runs; and
`API rate limit exceeded` occurrences in vitana-v1 Lane-scope logs per day. Recorded in
`docs/validation/<VTID>/measurement.md` 24 h after each lane merges.

## 7. Unchanged
Every required check and what it runs; branch protection; the PM's decisions, its merge path and its pause; #4396's
files; `STAGING-TESTS-REQUIRED.yml`, `ENFORCE-FRONTEND…`, `PHASE-2B-NAMING…`, `AWS-STAGE-DEPLOY-GATEWAY.yml`.

## 8. Risks
- A cancelled superseded run shows as "cancelled" on the old head only; merges always need the head's own result.
- The App key is a new secret: Secrets Manager only, never logged; token cached in memory only.
<!-- plan:end -->
