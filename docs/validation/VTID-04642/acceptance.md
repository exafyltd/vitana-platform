# VTID-04642 — Testing & QA rebuild, phase P3: Overview, Catalog and Runs screens

## Report

The Command Hub Testing & QA module replaces its four stale tabs (Unit Tests,
Integration Tests, Validator Tests, CI Reports) with three screens built on the
catalog (P1, VTID-04637) and the results store (P2, VTID-04641). E2E stays as
the run launcher until P4.

- **Overview** — one card per environment (Development / PR, Nightly, Staging,
  Production — production labelled as read-only monitors and health checks):
  7-day pass rate, runs, failing / flaky / idle workflows. The latest
  STAGING-VERIFY verdict per service with its failed tests. "Needs attention":
  every failing or flaky workflow with its streak, last success and last run.
  Coverage: files, cases, suites, scheduled runs a day, suites no workflow
  runs, flagged workflows. Sync state per repository and "Sync from GitHub now".
- **Catalog** — every suite (repo, runner, files, cases, environments,
  schedule, latest result of the workflows that run it; never-run suites
  marked) and every workflow (kind, schedule, environments, 7-day pass rate,
  latest result, flags such as dead hosts or UI tests touching production).
  Filter by environment (or "never run in CI") and text; a suite row expands
  to its files.
- **Runs** — every CI run in both repositories, newest first, filterable by
  environment, result and repository, with the failed jobs; "Run gateway
  tests now" dispatches TEST-SUITE.yml (the existing admin-only route).
- Old links (`/testing-qa/unit-tests/`, `integration-tests`, `validator-tests`
  → Catalog; `ci-reports` → Runs) still land somewhere useful. The tab list is
  updated in `app.js`, `navigation-config.js`, both screen inventories and the
  voice navigator catalog (`DEVHUB.TESTING.OVERVIEW` / `.CATALOG`; the existing
  `DEVHUB.TESTING.CI_REPORTS` id now opens Runs).
- CSP: all styling is `tq-*` classes in `styles.css`; data is written with
  `textContent` only. Cache-bust bumped to `20261014-vtid-04642`.
- Not done here: `scripts/regen-screens-catalog.mjs` fails against the current
  vitana-v1 (`ReferenceError: Inbox is not defined` in admin-navigation.ts),
  independent of this change, so the inventory was edited by hand and checked
  with `validate-dev-frontend-spec.mjs` (20 modules / 115 screens, OK).

## Acceptance Criteria

AC-1 — The module has exactly Overview, Catalog, Runs and E2E, consistently in app.js, navigation-config.js and the screen inventory; the old tab URLs land on Catalog / Runs.
TEST: services/gateway/test/command-hub/vtid-04642-testing-qa-screens.test.ts

AC-2 — Each screen reads its admin API (results summary, catalog, catalog suite, results runs, results sync) with the auth headers, and labels the four environments.
TEST: services/gateway/test/command-hub/vtid-04642-testing-qa-screens.test.ts

AC-3 — No inline styles and no innerHTML in the new code (CSP, escaping); the removed P0 notice and stale tabs stay gone.
TEST: services/gateway/test/command-hub/vtid-04642-testing-qa-screens.test.ts, services/gateway/test/command-hub/vtid-04635-testing-qa-tabs-honest.test.ts

AC-4 — Visually verified on a local harness (real catalog built from both repositories, real summary functions, synthetic runs, real STAGING-VERIFY verdicts) at 1400×900 and 390×844: no page errors, no horizontal page overflow, the never-run filter shows 9 suites, a suite row expands to its 10 files, the failures filter shows only failures, and /testing-qa/unit-tests/ opens the catalog.
TEST: docs/validation/VTID-04642/outputs/harness-shoot.js (screenshots in outputs/)
