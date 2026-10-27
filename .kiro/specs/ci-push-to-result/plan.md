---
change_class: standard
---
# plan(ci-push-to-result): shorter push-to-result critical path in both repos without dropping a check
Author: Kiro, seat `jtadic`, session `kiro-jtadic-202610271219-d5d7` (Kiro Web). Repos: `exafyltd/vitana-platform`
(spec) and `exafyltd/vitana-v1`. Premises pinned to platform `origin/main` `fef112e8c7`, vitana-v1 `origin/main`
`a6c5bd073`. Detail per lane: `tasks.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web): *"Analyze our CI and test suite for opportunities to reduce the time from push to a
reliable result … Rank improvements by expected time saved and implementation effort. Implement and validate the
highest-impact independent improvements through the existing pipeline where possible. Do not disable required checks
or reduce meaningful test coverage."* Another session owns the Kiro hooks, guards, session setup and local preflight
(`kiro-web-reliability`, #4392); this plan does not touch those files.

## 2. Today (measured from GitHub REST job/step timestamps, PR runs 2026-10-19 … 2026-10-27)
Data: 45 recent PRs per repo (non-`pm-agent/*`), 842 platform runs and 754 vitana-v1 runs with every job and step.
1. **Runner queue is the largest delay, and it is caused by the PM bookkeeping loop, owned elsewhere.** Platform job
   queue (created → started) was p50 ~200 s, p90 450–950 s in the hours the staging PM pushed to `pm-agent/<slug>`
   bookkeeping PRs (one push per lane per ~4 min, ~7 `pull_request` workflows each, >2500 runs/day). From
   2026-10-27T11:00Z, after the owner paused the PM, p50 2 s, p90 2–8 s. Fix in flight: plan PR #4396
   (`pm-reassign-idempotent`). Not changed here (§6).
2. **Platform: the only required check is the critical path of almost every PR.**
   `.github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml:11-21` runs on every `pull_request`; it was the last
   check to finish on 14 of 20 platform PR heads since 11:00Z (107–173 s; VALIDATOR-CHECK on 3). Job p50 158 s: `npm ci` in
   `services/gateway` 70 s (no dependency cache, `:11-17`; log: "added 802 packages … in 59s"), `npm run build` 72 s.
   `CICDL-GATEWAY-CI.yml` installs the same lockfile in 7–9 s with `--no-audit --no-fund` and a warm runner.
3. **Platform: `PHASE-2B-NAMING-ENFORCEMENT.yml` is next on the critical path (job p50 65 s).** Checkout with
   `fetch-depth: 0` (`:16-18`) 19 s though no step reads history; the kebab-case step (`:95-128`) forks two `grep`
   per file over every `.ts/.js/.tsx/.jsx` in the tree: 35 s.
4. **vitana-v1: one unsharded Vitest job is the critical path of 7 of 10 PR heads since 2026-10-24.**
   `vitana-v1/.github/workflows/UNIT-TESTS.yml:26-39`, job `Vitest (jsdom)`: p50 345 s, `npm run test:unit` 305 s
   (467 files), `npm ci` 23 s. The next-longest checks finish at 116–200 s (`PR-GATE`, `i18n-check`) or are
   native-only (`NATIVE-CI`, gated by its own "Which native jobs run" job). Vitest 4.1.10 supports `--shard=i/n`;
   `vitest list --shard` does not apply the shard (it lists all 467 files), so a union check must use the shards'
   own run reports.
5. Flakiness: no job passed and failed on the same head without a code change except governance checks re-run after a
   title/body edit; Vitest 0 of 92 heads. Not a speed lever.
6. Reliability, owned elsewhere: platform `TEST-SUITE.yml` is red on `main` (3 gateway suites since 2026-10-22);
   #4374 (`ci-github-modernization`, VTID-05308) fixes all three and is green on Jest, stalled on governance checks.
   `OASIS-PERSISTENCE.yml` `Gateway Service Tests` re-runs the whole gateway Jest suite unsharded (284 s, red 8 of 9)
   and its check name is read by the autopilot CI watcher. `VALIDATOR-CHECK.yml` Build Gate re-installs and rebuilds
   the gateway (114 s) and is read by #4392's preflight lane. None changed here (§6).

## 3. Ranking (expected saving per PR × effort)
| # | Change | Saves | Effort | Here? |
|---|---|---|---|---|
| A | PM loop idempotent (no runner flood) | 3–15 min per push while the PM runs | M (gateway + staging) | no — #4396 |
| B | v1 Vitest in 3 shards + aggregate `Vitest (jsdom)` | ~3.5 min, every v1 PR | S | lane `v1-vitest-shards` |
| C | ENFORCE npm dependency cache | ~50 s, every platform PR | XS | lane `platform-gate-install` |
| D | PHASE-2B naming: shallow checkout, one-pass kebab check | ~45 s runner, keeps it off the critical path after C | S | lane `platform-gate-install` |
| E | Land #4374 (red `main` TEST-SUITE) | reliability: gateway PR results readable again | S | no — VTID-05308 |
| F | Drop the duplicate unsharded gateway Jest in OASIS-PERSISTENCE | ~2.5 min on gateway PRs | M (autopilot reads its name) | no — reported |
| G | VALIDATOR-CHECK Build Gate cache | ~50 s on gateway PRs | XS | no — #4392 reads that file |

## 4. Lanes (parallel; no shared file; no `depends_on`)
### 4.1 Lane `v1-vitest-shards` (vitana-v1) — `.github/workflows/UNIT-TESTS.yml`, `scripts/ci/vitest-shards/**`, `docs/validation/VTID-*/**`
1. Job `vitest` becomes a matrix `shard: [1, 2, 3]` named `Vitest (jsdom, shard N/3)`, running
   `npx vitest run --shard=${{ matrix.shard }}/3 --reporter=default --reporter=json --outputFile.json=<file>`, then
   uploading the JSON report (and shard 1 also `vitest list --filesOnly --json`) as artifacts. Same triggers, same
   concurrency, same `npm ci`, same timeout; nightly and `main` push runs shard the same way.
2. A new job keeps the check name **`Vitest (jsdom)`**, `needs` the shards, `if: always()`, and fails unless every
   shard succeeded **and** `scripts/ci/vitest-shards/shard-union.mjs` proves, from the downloaded reports, that every
   file of the full list ran in exactly one shard (missing, duplicated or failed file → red, named). So a shard that
   silently runs nothing, or a Vitest change that breaks sharding, turns the check red.
3. `scripts/ci/vitest-shards/shard-union.test.mjs` (pure logic: union, duplicate, missing, failed-suite, empty input;
   red on base: the module does not exist) runs with `node --test` in the aggregate job before the union check.
4. Unchanged: `Realtime helper` and `Edge data client` jobs, `vitest.config.ts`, every test file, `PR-GATE.yml`.

### 4.2 Lane `platform-gate-install` (vitana-platform) — `.github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`, `.github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml`, `scripts/ci/phase-2b-naming/**`, `docs/validation/VTID-*/**`
1. ENFORCE: `actions/setup-node` gets `cache: npm` and `cache-dependency-path: services/gateway/package-lock.json`;
   install becomes `npm ci --no-audit --no-fund`. Job name `validate`, trigger, build and validator step unchanged.
2. PHASE-2B: checkout without `fetch-depth: 0` (no step reads git history). The kebab-case step calls
   `scripts/ci/phase-2b-naming/kebab-check.sh`: the same `find` expression, the same skip regex
   (`node_modules|\.git|\.next|dist|build|/temp_`), the same basename rule (`[A-Z]|_` after removing the last
   extension) and exceptions (`^(README|LICENSE|CHANGELOG|Dockerfile|Makefile)`), the same messages and exit code,
   evaluated in one `awk` pass instead of two forks per file.
3. `scripts/ci/phase-2b-naming/kebab-check.test.mjs` (run by `UNIT.yml`, which runs every `scripts/**/*.test.mjs`):
   an oracle test runs the current inline loop (copied verbatim) and the new script over a fixture tree with
   violations, exceptions, skipped dirs, `.github`, dotted names and names without an extension, and over the real
   repository tree, and requires identical violation lists and exit codes. Red on base: the script does not exist.

## 5. Validation and measurement
- Each lane's PR runs the changed workflow itself on its head; before/after job and step timings from the GitHub API
  go into `docs/validation/<VTID>/timings.md` (before = the medians in §2).
- v1: the aggregate `Vitest (jsdom)` green with the union report showing 467 (or the then-current count) files, each
  in one shard; the test count equals a full run's. A deliberate failing fixture is not committed; the union logic's
  failure paths are proven by `shard-union.test.mjs`.
- Platform: ENFORCE log shows the cache hit and the install time; PHASE-2B oracle test green; both jobs green.
- `docs/validation/<plan VTID>/timings.json` per §8b.

## 6. Unchanged / out of scope
No required check is removed, renamed or path-filtered; no test is skipped. Not touched: `PR-GATE.yml`, `PLAN-SPAR.yml`
and every protected gate file; `VALIDATOR-CHECK.yml`, `scripts/collab/**`, `AGENTS.md`, `.kiro/pipeline/**`,
`.kiro/hooks/**` (the `kiro-web-reliability` session's files); `services/gateway/**` and the PM (#4396);
`TEST-SUITE.yml`, `OASIS-PERSISTENCE.yml`, `CICDL-GATEWAY-CI.yml` (`ci-github-modernization`). Items A, E, F, G of §3
are reported with evidence, not implemented. Deploys nothing: done when both lanes are merged green.

## 7. Risks
- R1 A renamed check would leave a pending check forever: the aggregate job keeps `Vitest (jsdom)` and always runs.
- R2 Sharding hides a file: the union check fails on any missing or duplicated file.
- R3 Extra runner jobs (+2 per v1 PR): acceptable while the queue is ~2 s (§2.1); if the PM flood returns, the
  shards still finish sooner than one job because each queues independently.
- R4 The npm cache key is the gateway lockfile hash; a lockfile change misses once and repopulates.
- R5 The kebab rewrite changes behaviour: the oracle test compares old and new over fixtures and the real tree.
<!-- plan:end -->
