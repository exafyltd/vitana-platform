# VTID-05023 test coverage (agent J)

Base: origin/main a02b8918. The lint and PR-GATE changes exist only on cutover/vtid-05023-lane, so their rows refer to that branch.

## Coverage per change

| Change | Proving test | Regression-catching test | Runs in CI | MR |
|---|---|---|---|---|
| 1. Staging pinned test update (b46a9f51e0, MR !14) | services/gateway/test/orb/live/upstream/staging-aurora-database-url-pinned.test.ts | Same file, plus vtid-05023-aurora-strip-all.test.ts and vtid-05023-aurora-gate-exit.test.ts (new) | yes: gateway-jest in platform.gitlab-ci.yml (no rules, every pipeline); GitHub TEST-SUITE on services/** PRs and nightly | none (existing) |
| 2. GitHub staging strip of Aurora names from every container (fe182590cc, MR !15) | services/gateway/test/vtid-05023-aurora-strip-all.test.ts | Same file, plus vtid-05023-aurora-gate-exit.test.ts (new): gate exit status, and strip after the connected-apps merge | yes: gateway-jest; GitHub TEST-SUITE on services/** PRs and nightly | !22 |
| 3. GitLab deploy strip and gate (a02b8918, MR !16) | services/gateway/test/vtid-05023-gitlab-aurora-strip.test.ts (runs the job's jq; checks the gate query) | Same file, plus vtid-05023-aurora-gate-exit.test.ts (new): exit 1 and refusal message. Before !22, removing the gate's exit 1 passed every test. | yes: gateway-jest in platform.gitlab-ci.yml | !22 |
| 4. Vertex pinned test change and regenerated flag pins (97b9a2e0) | services/gateway/test/orb/live/upstream/staging-vertex-serbian-bridge-wiring-pinned.test.ts; services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts | Same two. The registry test runs scripts/conversation/generate-flag-pins.mjs --check, so the generated file must match both deploy workflows. | yes: gateway-jest | none |
| 5. Aurora compatibility lint (scripts/aws/aurora-compat-lint.mjs, lane branch) | scripts/aws/test/aurora-compat-lint.test.mjs (4 tests on lintSql) | scripts/aws/test/aurora-compat-lint-cli.test.mjs (new): file mode, --base/--head on a temp git repo, usage exit | yes on GitHub: UNIT.yml runs every scripts/**/*.test.mjs on every PR; PR-GATE runs the unit test on lane PRs. Not in the GitLab pipeline that runs for this project. | !23 (targets the lane branch) |
| 6. PR-GATE Aurora step (lane branch) | none existed before this review | aurora-compat-lint-cli.test.mjs (new): fails if the step lacks the unit test or the --base/--head command, or gains continue-on-error | yes: PR-GATE runs on every pull_request once the lane lands | !23 |
| 7. expect_json_in runner (6f73cd6b, pm-mode-probes) | scripts/ci/staging-verify/lib.test.cjs: 3 new tests | Same file | yes: STAGING-TESTS-REQUIRED runs lib.test.cjs on every PR; UNIT.yml also runs it | existing draft MR !11 |

## CI wiring

- The project's active pipeline is `platform.gitlab-ci.yml`, set by `ci_file` in infra/gitlab-engineering/settings/gitlab-settings.json. It runs `typecheck` and `gateway-jest` (services/gateway/test, all shards). It has no job for scripts/**/*.test.*. The `unit-scripts` job exists only in platform-delivery.gitlab-ci.yml, which that project does not include.
- So the script tests (lint, staging-verify runner) run only on GitHub: UNIT.yml, STAGING-TESTS-REQUIRED and PR-GATE.
- GitHub TEST-SUITE triggers on services/** only. A PR that changes only .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml does not run the GitHub-side pinned and strip tests on that PR. GitLab gateway-jest still runs them. No GitHub workflow was changed here.

## Gaps found

1. The gate's exit status had no test in either deploy file. Removing `exit 1` passed CI. Fixed by !22.
2. The GitHub transform's strip was tested only with an empty connected-apps input. Moving the final strip above the connected-apps merge passed CI. Fixed by !22.
3. The lint command and the PR-GATE step had no test. A no-op `main()` would leave PR-GATE green. Fixed by !23.

## Observed, not fixed

- aurora-compat-lint.mjs: `--base <ref>` without `--head` exits 1 with a stack trace, not the documented 2. PR-GATE always passes both refs, so CI cannot reach this path. Not tested, not a blocker.

## Evidence

- Scratch Jest 29 with ts-jest, outside the repo. Five files: the new gate-exit file (5 tests), plus the GitHub strip, GitLab strip, staging pinned and Vertex pinned files from main. 26 of 26 pass.
- Mutations, each reverted after the run:
  - GitLab gate `exit 1` removed: 1 case fails.
  - GitHub final strip removed from secrets: 1 case fails.
  - Lint `main()` guard disabled: 3 CLI cases fail.
  - PR-GATE lint command replaced with `echo`: 1 wiring case fails.
- cutover/vtid-05023-lane lint CLI: fail.sql exits 1, pass.sql exits 0. The existing unit test passes 4 of 4.
- pm-mode-probes lib.test.cjs: 69 pass, 0 fail (run from a git archive of the branch).
- `node scripts/conversation/generate-flag-pins.mjs --check`: current.
- The vtid-04525 registry test as a whole was not run. It needs the full gateway install. Its pins check was run directly.
- A mistaken root-level `node --test` run also executed unrelated supabase and workspace suites, which fail in this sandbox. Those results are not part of this review.

## Merge state

- !22 (cutover/vtid-05023-J-gate-exit-tests -> main): ready for review.
- !23 (cutover/vtid-05023-J-lint-cli-tests -> cutover/vtid-05023-lane): its unit tests run in CI only after the lane lands.
- No production, AWS, Aurora, GitHub workflow, or vtid-05005 change was made.
