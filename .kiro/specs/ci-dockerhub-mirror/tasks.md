# Tasks — ci-dockerhub-mirror
<!-- lane: v1-service-images -->
Repo `exafyltd/vitana-v1`. Code starts only after the VTID is allocated (plan § Lanes).
- [ ] T1 Test first: write `src/lib/pr-ci-service-images.test.ts` (plan § Change 2). On `origin/main` run
      `npx vitest run src/lib/pr-ci-service-images.test.ts` and save the output to
      `docs/validation/<VTID>/red-on-base.txt`: it must fail naming the five files of plan § Today 4 (the
      `public.ecr.aws/` assertion), not a setup or parse error.
- [ ] T2 In `PR-GATE.yml`, `SQL-CALENDAR-ENTRY-SHARE.yml`, `SQL-EVENT-SHARE-POSTS.yml`, `SQL-GROUP-PARTICIPANTS.yml`
      and `SQL-THREAD-JOIN-HARDENING.yml`: `image: public.ecr.aws/docker/library/postgres:16` → `image: postgres:16`,
      and the comment line above it names the new reason (plan § Change 1). No other line changes.
- [ ] T3 Green on head: the guard test passes; `npm run test:unit` passes. Commands and summaries in
      `docs/validation/<VTID>/commands.log`.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json` (UTF-8, no BOM): `service: community-app`, one test
      `kind: "existing"`, `ref: "npx vitest run src/lib/pr-ci-service-images.test.ts"`, reason "CI-only change, the
      app bundle is unchanged".
- [ ] T5 PR titled `VTID-xxxxx (ci-dockerhub-mirror/v1-service-images): …`; on its head `pr-gate` passes
      `Initialize containers` and is green, and the four `SQL-*` checks are green.
Acceptance:
- Change types: Tooling/CI (workflow image references, a Vitest guard, validation records).
- **Outcome** — CI: vitana-v1 `pr-gate` no longer fails on the ECR Public anonymous data cap; the five service images
  are the same official `postgres:16`.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: service `env`, `ports`, `options`, names and every step byte-identical.
- **Staging proof** — not verified on staging: CI-only change, the deployed bundle is unchanged; covering test is
  the guard; `staging-tests.json` present so STAGING-TESTS-REQUIRED passes.
- Red on base for the reason fixed, green on head; diff only inside the lane `paths`; no test skipped or loosened;
  files UTF-8 without BOM.
