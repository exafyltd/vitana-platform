# VTID-04709 — staging deploy can pin a commit already on main

Owner decision (2026-09-28): promote only the 23 commits `8a2b6bf..a4adbbe` to
production, not the 22 that landed on staging after them. Production is reached
by promoting the image staging runs (`AWS-PROD-DEPLOY-GATEWAY.yml`,
`promote-staging`), and `AWS-STAGE-DEPLOY-GATEWAY.yml` could only build main
HEAD — so there was no governed way to put staging on `a4adbbe` first.

## Change

`AWS-STAGE-DEPLOY-GATEWAY.yml` gains an optional `commit_sha` dispatch input:

- checkout uses `inputs.commit_sha || github.sha` — a push deploy is unchanged;
- a pinned value must be a full 40-char SHA that is already an ancestor of
  `origin/main`, otherwise the run fails before building;
- the commit stamp (`GIT_COMMIT_SHA`, `BUILD_INFO`, smoke check) is the commit
  actually checked out (`git rev-parse HEAD`), not `GITHUB_SHA`.

## Acceptance criteria

AC-1 The workflow declares an optional `commit_sha` dispatch input, default empty.
  TEST: services/gateway/test/vtid-04709-staging-deploy-pinned-commit.test.ts
AC-2 Checkout uses the pinned commit when given, else the triggering commit.
  TEST: services/gateway/test/vtid-04709-staging-deploy-pinned-commit.test.ts
AC-3 A pin that is not a full SHA on main fails the run before any build.
  TEST: services/gateway/test/vtid-04709-staging-deploy-pinned-commit.test.ts
AC-4 The deployed commit stamp is the checked-out commit, never `GITHUB_SHA`.
  TEST: services/gateway/test/vtid-04709-staging-deploy-pinned-commit.test.ts
AC-5 Every existing test that reads this workflow still passes (incl. the VTID-03788 bash-syntax/size guard).
  TEST: services/gateway/test (45 suites that read AWS-STAGE-DEPLOY-GATEWAY.yml)
AC-6 (after merge) A dispatch with `commit_sha=a4adbbea580f7389ce00529a675e9a5d59000a1e` makes staging serve that commit.
  CURL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info

OASIS_IMPACT: no — the workflow's existing deploy event already carries the stamped commit.
