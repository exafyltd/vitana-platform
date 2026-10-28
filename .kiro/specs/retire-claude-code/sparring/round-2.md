# Sparring round 2 — converged

Session: `d1b25dea-ce0e-4b73-a46b-350d1fdc0c5b` · plan hash `371745f54f789687d4b213d5e34f2e9c86a95be54a9b519774c857244a7a3412`

## Summary

The revision substantively addresses all five round-1 findings: the bootstrap is de-risked (no --admin needed, merges with red lane-scope since neither repo requires it as a status check), seat/different-seat enforcement and the owner-instruction audit record are specified in the scope-rules code, the Playwright pin now enumerates files and adds a negative-control test, and the exact steering files carrying role text are named. Premise checks confirm the current code matches the plan's "measured state" claims (governance-only-by-claude at validateLane :180 and scopeCheck :471; session_-only review for reviewer_seat:claude at :479; areas.yaml seat list; STAGING-VERIFY's Chromium install in run.mjs:255). One new minor issue: the ci-runner-v1 lane over-enumerates vitana-v1/STAGING-TESTS-REQUIRED.yml as a browser job when it only runs a manifest presence check (run.mjs check-pr) and never installs or launches Playwright, and the plan's test matches the literal string `staging-verify/run.mjs`, which this file does not contain (it invokes $RUNNER_TEMP/sv/run.mjs).

## Findings

### R2-F1 [minor]

The ci-runner-v1 lane lists vitana-v1/STAGING-TESTS-REQUIRED.yml as one of the 3 files to pin to ubuntu-24.04, but that workflow does not run a browser: its only job (change-suite, runs-on: ubuntu-latest) validates that a docs/validation/<VTID>/staging-tests.json exists and invokes run.mjs with the `check-pr` subcommand (a manifest/shape check), never `verify`, and never installs or launches Playwright. The plan's own test matches the literal strings `playwright install`/`@playwright/test`/`playwright test`/`staging-verify/run.mjs`; this file contains none of those (it runs `$RUNNER_TEMP/sv/run.mjs check-pr`, fetched by path from the gh api URL on line 47), so the enumerated file list is over-specified and the described matcher would neither require nor catch an unpinned occurrence of this file.

- `exafyltd/vitana-v1:.github/workflows/STAGING-TESTS-REQUIRED.yml:27` — jobs: change-suite: runs-on: ubuntu-latest ... node "$RUNNER_TEMP/sv/run.mjs" check-pr --service community-app ...
- `exafyltd/vitana-v1:.github/workflows/STAGING-TESTS-REQUIRED.yml:45` — for f in lib.cjs run.mjs staging-guard.ts; do ... "repos/exafyltd/vitana-platform/contents/scripts/ci/staging-verify/$f?ref=main"

Suggestion: Clarify that the STAGING-TESTS-REQUIRED.yml pin is cosmetic (or drop it from the browser-job list). Either extend the test's matcher to also flag `staging-verify/run.mjs` invoked via a non-literal path/temp dir, or state explicitly that only E2E-PREVIEW-ORB.yml and PR-GATE.yml's preview-e2e job actually run a browser in vitana-v1. Also note the string-matcher can be evaded by alternate invocations (e.g. `npx -y playwright`, `bunx playwright`); the negative control only holds as long as real jobs use the exact matched strings.
