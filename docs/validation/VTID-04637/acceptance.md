# VTID-04637 — Testing & QA rebuild, phase P1: the generated test catalog

## Report

The catalog of every automated test in both repositories, generated from the
code on every merge instead of typed in by hand.

- `scripts/test-catalog/lib.cjs` (pure) and `build.mjs` (I/O) scan a checkout
  of each repository: test files (Jest, Vitest, Playwright, pytest, Node
  regression scripts), `test:*` npm scripts and every GitHub workflow. Each
  file is grouped into a suite and given a domain (the 15 atlas domains plus
  frontend). Each workflow gets a kind (test / gate / monitor / e2e /
  deploy_smoke / job) and the environments it touches: dev_pr, nightly,
  staging, production. Suites are wired to the workflows that run them. A
  suite no workflow runs is marked `never_run`. Workflows pointing at dead
  hosts, or UI tests that touch production, are flagged.
- `TEST-CATALOG.yml` builds it on every relevant merge, daily and by hand, and
  publishes `s3://vitana-code-index/test-catalog/latest.json.gz`: the
  code-index bucket, whose policy already grants this workflow's OIDC role
  put and the gateway task role get. No new IAM.
- `services/testing/test-catalog.ts` loads it (10-minute cache, coalesced
  reads). `GET /api/v1/testing/catalog` returns it with environment, domain,
  runner, repo and text filters. `GET /api/v1/testing/catalog/suite?id=`
  returns one suite with its files and workflows. Both are exafy_admin only.

Built locally over both repositories: 1,644 files, ~19,400 cases, 116 suites,
60 test/monitor/gate workflows, 19 scheduled (~373 runs a day). 9 suites are
never run. 6 workflows are flagged: 4 dead hosts and 2 UI tests touching
production. Summary in `outputs/catalog-summary.json`.

## Acceptance Criteria

AC-1 — Every gateway Jest file is classified into a suite; every test, gate, monitor and e2e workflow in this repository gets an environment or a flag; suites are only wired to workflows that exist.
TEST: services/gateway/test/scripts/test-catalog-lib.test.ts — "this repository, scanned for real".

AC-2 — Classification rules: suite grouping, case counting, triggers and crons, environment by host, database monitors on production, dead-host and production-UI flags, deploy and job workflows, cron descriptions, never_run suites and named npm suites.
TEST: services/gateway/test/scripts/test-catalog-lib.test.ts

AC-3 — The catalog routes are exafy_admin only, answer a plain 503 when nothing is published, filter by environment (including never_run) and domain, and return suite detail; the loader caches for its TTL and rejects a malformed catalog.
TEST: services/gateway/test/routes/testing-catalog.test.ts

AC-4 — Deployed to staging, both catalog routes refuse an unauthenticated caller.
TEST: docs/validation/VTID-04637/staging-tests.json — run by STAGING-VERIFY.

## Route mount evidence

Two new GET routes on the existing `/api/v1/testing` router.

ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/testing', testingRouter, { owner: 'testing-qa' })` (unchanged); new `router.get('/catalog')` and `router.get('/catalog/suite')` in `services/gateway/src/routes/testing.ts`
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/testing/catalog
CURL_PROOF: pre-merge, the router answers on staging: `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/testing/suites` → `200 application/json; charset=utf-8`. After merge STAGING-VERIFY checks `/api/v1/testing/catalog` → 401 (staging-tests.json).
