# Tasks — pipeline-speed

<!-- lane: pipeline-speed -->
- [ ] L1 — PM bookkeeping idempotency in `writers.ts` (`changeAlreadyRecorded`), with two regression tests. Code exists
      (commit `9519b394e9`). Gate: `npx jest test/project-manager` green.
- [ ] L2 — per-PR concurrency on `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`, `PHASE-2B-NAMING-ENFORCEMENT.yml`,
      `STAGING-TESTS-REQUIRED.yml` (commit `07ab1c797c`). Gate: workflow YAML parses; CI green on the lane PR.
- [ ] Staging proof after deploy: queue depth and the `pm-agent/*` share of new runs, before and after (see plan §4).
