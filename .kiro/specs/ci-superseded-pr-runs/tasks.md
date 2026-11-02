# Tasks — ci-superseded-pr-runs

<!-- lane: v1-superseded-concurrency -->
Repo `exafyltd/vitana-v1`. Code starts only after the VTID is allocated.
- [ ] T1 Add the concurrency block (plan § Change 1) to: `i18n-check.yml`, `STAGING-TESTS-REQUIRED.yml`,
      `SQL-CALENDAR-ENTRY-SHARE.yml`, `SQL-EVENT-SHARE-POSTS.yml`, `SQL-GROUP-PARTICIPANTS.yml`,
      `SQL-THREAD-JOIN-HARDENING.yml`. Nothing else changes.
- [ ] T2 Check every changed file: `on:` unchanged, one `concurrency:` block, names/jobs/steps byte-identical.
- [ ] T3 Run `npm run test:unit`; save output to `docs/validation/<VTID>/commands.log`.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json`: `service: community-app`, one test `kind: "existing"`,
      `ref: "npm run test:unit"`, reason "CI-only change, the app bundle is unchanged".
- [ ] T5 PR titled `VTID-xxxxx (ci-superseded-pr-runs/v1-superseded-concurrency): …`.

Acceptance:
- Change types: Tooling/CI.
- **Outcome** — CI: a newer push to a PR cancels the older run of that PR for these six workflows.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: workflow names, triggers, jobs and steps unchanged.
- **Staging proof** — not verified on staging: CI-only change; covering suite is the existing unit run.
- Diff only inside the lane `paths`; no test skipped or loosened.

<!-- lane: platform-superseded-concurrency -->
Repo `exafyltd/vitana-platform`. Code starts only after the VTID is allocated.
- [ ] T1 Add the concurrency block (plan § Change 1) to the 38 PR-triggered workflows listed in the lane file.
      `PR-GATE.yml`, `PLAN-SPAR.yml`, `AWS-PROD-*.yml`, and the three that already have a block (`UNIT.yml`,
      `TEST-SUITE.yml`, `PHASE-2B-DOC-GATE.yml`) are not touched.
- [ ] T2 Check every changed file: `on:` unchanged, one `concurrency:` block, names/jobs/steps byte-identical.
- [ ] T3 Run the `scripts/collab` Node tests; save output to `docs/validation/<VTID>/commands.log`.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json`: one `kind: "existing"` test with a `ref` the validator accepts.
- [ ] T5 PR titled `VTID-xxxxx (ci-superseded-pr-runs/platform-superseded-concurrency): …`.

Acceptance:
- Change types: Tooling/CI.
- **Outcome** — CI: a newer push to a PR cancels the older run of that PR for the 38 workflows.
- **Contract** — n/a: workflow names, triggers, jobs and steps unchanged.
- Diff only inside the lane `paths`; no protected gate file changes.
