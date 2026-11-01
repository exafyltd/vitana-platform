---
slug: github-api-quota
author: kiro
author_seat: exafy
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T14:00Z
---
# Handoff — github-api-quota (cut GitHub REST quota use in the gateway and CI scripts)
Planner: Kiro seat `exafy` (workflow run `wf_86ea1b7889ccc773`). Plan: `plan.md` (between the plan markers). Detail:
`tasks.md`. Lanes (all `executor: kiro`, seat `exafy`, reviewer accept by `vitana-lane-reviewer`):
`gh-http`, `ci-scripts-backoff` (wave 1); `gh-clients`, `gh-graphql-core` (wave 2, after `gh-http`);
`gh-graphql-wire` (after `gh-clients` and `gh-graphql-core`), `pm-observer-graphql` (after the same two),
`polling-cadence` (after `gh-clients`) (wave 3). No lane shares a file with another lane except
`github-service.ts`, which `gh-graphql-wire` edits after `gh-clients` (sequential by `depends_on`).

Deferred, not in any lane (see `plan.md` §3 D12 and D14): `scripts/collab/queue.mjs`, `scripts/collab/plan-spar.mjs`,
`.github/workflows/PR-GATE.yml` and `services/gateway/src/services/plan-sparring/**` (protected gate files; an owner
instruction naming the plan is needed); `services/mcp*` connectors; `scripts/ci/**` readers; vitana-v1 (no GitHub client
of its own that matters at this volume).

Shipping: the gateway changes deploy to staging through the usual merge path. STAGING-VERIFY has no read-only proof of
the rate-limit path, so each PR states "not verified on staging" with its covering unit test. Done at the staging gate
per the pipeline (Gate 2 is the owner's production question).

## Log
### 2026-11-01T14:00Z · kiro-seat-exafy · created → drafted
Planner run `wf_86ea1b7889ccc773`. Investigation: `RUN/investigate/inv-code.md`, `inv-rules.md`, `inv-tests.md`
(read-only, `origin/main` `62990ce285`). Premises checked in code: `github-service.ts:59` (`githubRequest`, no cache, no
rate-limit read), `:371` (`getPrStatus`, three REST calls, `.catch` defaults give a false `allPassed`), `:329`/`:340`
(status and check-runs reads), `project-manager/github-rest.ts:27` (`gh()`), `dev-autopilot-watcher.ts:79-81` (60 s
ticks), `config.ts:25` (PM tick 120 s), `routes/cicd.ts:1718` (10 s poll), `scripts/collab/protected-gate-files.json`
(protected list). No VTID allocated, no code changed, no live system touched. Next: `plan(github-api-quota)` PR, then
CI PLAN-SPAR.
