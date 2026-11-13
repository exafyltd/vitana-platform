# Plan: speed up STAGING-VERIFY (exafyltd/vitana-platform)

Change class: standard (touches `.github/workflows/STAGING-VERIFY.yml` and `scripts/ci/staging-verify/**`).

Scope (files): `scripts/ci/staging-verify/run.mjs`, `scripts/ci/staging-verify/lib.cjs`, new `scripts/ci/staging-verify/pool.mjs`, their tests under `scripts/ci/staging-verify/*.test.*`, `.github/workflows/STAGING-VERIFY.yml` (env only, no trigger or concurrency change).

<!-- plan:begin -->
## Problem (measured, run 42470768985, a763b4f, 50 min, 145 checks, 45 VTIDs)
- `runSuite` runs every check one after another (`for ... await`, run.mjs:376), and `runExisting` uses `spawnSync` (run.mjs:362).
- The four shared commands `npm run bundle`, `npm run typecheck`, `npm run parity:check`, `npm run gen:i18n` ran 23 times each in that run (92 invocations, ~36 min). Same repo tree, same command.
- Jest/Vitest: 38 distinct test files, ~6.5 min, serial. Playwright: ~4.5 min, one worker.

## Design (revised after round-1 findings)
1. **Unit of parallelism = one VTID suite chain.** Checks inside a suite run strictly in manifest order, as today. Parallelism is only between suites. (Answers F1, F6.)
2. **Setup phase before the pool.** For each cwd that any suite uses, run `npm run gen:i18n` once, before any suite starts (not per suite). Every suite then sees a complete `catalog-map.generated.ts`. (Answers F1, F2.)
3. **Conservative lock per cwd (F3 default).** Every `npm`/`npx` command in a cwd takes that cwd's exclusive lock, including `npx jest`, `npx vitest`, `typecheck`, `bundle`, `parity:check`. Two commands in the same cwd never overlap, so no writer races a reader and no pre-script rewrites a file a jest run is reading. Different cwds may run in parallel. HTTP checks use their own limit of 2 and take no cwd lock. The cost is that jest files in one cwd no longer overlap; the dedupe is the main gain. (Answers F2, F3.)
4. **Dedupe shared commands.** Key = sha256(command + cwd + allowlisted env + repo tree hash of cwd). The first suite that needs a key runs it while later suites wait on that key; they reuse its result. Each VTID's row still records its own check with `reused_from`. Failure semantics unchanged: a failed shared command fails every dependent row. Env differences (e.g. `APP_PROFILE=development` on some manifests) produce separate keys, so the number of deduped runs is "one per distinct key", not a fixed 4. (Answers F4.)
5. **Scope.** The mechanism is in the shared runner, so gateway manifests (`test:roles`, `test:operator`, `test:support`) also dedupe. Timings are measured on community-app only; gateway gain is not claimed. (Answers F5.)
6. **Bounded pool.** `pool.mjs` uses async `spawn`, a global limit `--jobs N` (default 4, env `STAGING_VERIFY_JOBS`), and returns rows in original order. Output stays identical in shape.
7. **Playwright unchanged in semantics.** Specs within a suite run in order; the config file `.staging-verify.playwright.config.mjs` is written per cwd under that cwd's lock, so two suites never write it at once. (Answers F6.)
8. **CI-agnostic.** New code is plain Node, no GitHub API calls. The `--deploy-runs-file` path (VTID-05552, run.mjs:203-256) is unaffected: the pool only wraps check execution, not input loading. A test covers that path. (Answers F7.)
9. **Concurrency group unchanged** (one verify per service; staging serves one build at a time).

## Expected effect (community-app, estimate)
Shared commands drop from 92 invocations to one per distinct key (likely 4–8). Jest runs serially within a cwd, so the jest gain is smaller than first estimated. Estimate: 50 min → roughly 12–18 min. Measured after implementation, not assumed.

## Tests
- Unit: dedupe key changes with cwd, command, env or tree hash; identical inputs reuse one result.
- Unit: a suite's checks stay in order; the pool respects `--jobs`; the cwd lock prevents two commands in one cwd overlapping.
- Unit: a failed shared command fails every dependent row.
- Unit: setup phase runs gen:i18n once per cwd before any suite.
- Equivalence: old and new runner on the same mocked command results give identical rows (pass/fail, names, order).
- Unit: `--deploy-runs-file` path still works with the pool.
- Staging: one read-only STAGING-VERIFY run after merge; compare wall time and results with the previous run. No production calls; the existing staging guard applies.

## Non-goals
Per-PR preview verification, GitLab parent/child pipeline layout, changing any suite's assertions.
<!-- plan:end -->

## Planner responses (round 1)
- F1 (major, unit of parallelism): ACCEPTED. Suite chains are sequential; parallel only across suites (design 1).
- F2 (major, npm pre-script side effects): ACCEPTED. gen:i18n runs once in a setup phase per cwd (design 2); all npm/npx commands in a cwd are exclusive so no pre-script rewrite races a jest read (design 3).
- F3 (major, lock classification): ACCEPTED with the conservative default (design 3): all npm/npx commands in one cwd are exclusive; HTTP is separate.
- F4 (minor, env keys): ACCEPTED. Claim restated as "one per distinct key" (design 4).
- F5 (minor, gateway scope): ACCEPTED. Mechanism applies to both services; gain only measured on community-app (design 5).
- F6 (minor, Playwright config collision): ACCEPTED, subsumed by F1 (design 7).
- F7 (minor, --deploy-runs-file path): ACCEPTED. Test added (design 8).
Round 2: please mark each finding closed / acknowledged / disputed, and raise new blockers or majors only.
