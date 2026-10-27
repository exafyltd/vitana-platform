# Tasks — ci-push-to-result
Authoritative plan: `plan.md` (between the plan markers). VTIDs: one per lane, allocated by CI PLAN-SPAR after policy
approval; never by hand. Branches `kiro/ci-push-to-result/<lane-id>`; PR titles
`VTID-xxxxx (ci-push-to-result/<lane-id>): …`; `Collab-Session` + `Collab-Lane` trailers on every commit; identity
`kiro-agent[bot]`; no `Co-Authored-By: Claude`. Evidence in `docs/validation/<VTID>/` (`commands.log`,
`red-on-base.txt`, `acceptance.md`, `timings.md`). Common to both lanes: nothing outside `paths`; no protected gate
file; no required check removed, renamed or path-filtered; no test skipped; deploys nothing.

<!-- lane: v1-vitest-shards -->
## Lane `v1-vitest-shards` (vitana-v1)
- [ ] S1 `scripts/ci/vitest-shards/shard-union.test.mjs` written first (union ok; missing file; file in two shards;
      failed suite; empty shard report; no reports), red on `origin/main` (module missing).
- [ ] S2 `scripts/ci/vitest-shards/shard-union.mjs`: reads the full file list (`vitest list --filesOnly --json`) and
      N Vitest JSON reports; prints per-shard file/test counts; exits 1 naming every missing, duplicated or failed
      file; paths compared relative to the repo root.
- [ ] S3 `UNIT-TESTS.yml`: `vitest` job → matrix `shard: [1, 2, 3]` (`fail-fast: false`) named
      `Vitest (jsdom, shard N/3)`, JSON report + (shard 1) file list uploaded as artifacts; new aggregate job named
      `Vitest (jsdom)` (`needs` the shards, `if: always()`) runs the S1 test and the S2 union check and fails unless
      every shard succeeded. Triggers, concurrency, other jobs unchanged.
- [ ] S4 Run locally: `node --test scripts/ci/vitest-shards/*.test.mjs`; three local shard runs + union check
      against the full list; record counts in `commands.log`.
- [ ] S5 On the PR head: all three shards and `Vitest (jsdom)` green; before/after timings in `timings.md`.

**Acceptance**
- A check named exactly `Vitest (jsdom)` still exists on every PR, push and nightly run, and is red when any shard
  fails, is cancelled or skipped, or when the union check fails.
- The union check uses the shards' own run reports (not `vitest list --shard`, which ignores the shard) and the
  full file list from the same commit; every file ran in exactly one shard; test totals equal a full run's.
- No test file, `vitest.config.ts` or `PR-GATE.yml` change; `Realtime helper` and `Edge data client` unchanged.
- Measured `Vitest (jsdom)` push→green on the PR head is below the §2 baseline (job p50 345 s).

<!-- lane: platform-gate-install -->
## Lane `platform-gate-install` (vitana-platform)
- [ ] P1 `scripts/ci/phase-2b-naming/kebab-check.test.mjs` written first: oracle = the current inline loop of
      `PHASE-2B-NAMING-ENFORCEMENT.yml` (copied verbatim into the test), fixture tree (uppercase, underscore,
      kebab, `README.md`/`Dockerfile.js`-style exceptions, `node_modules`, `dist`, `build`, `.next`, `/temp_`,
      `.github`, multi-dot names, no extension) + the real repository tree; identical violations and exit code.
      Red on `origin/main` (script missing).
- [ ] P2 `scripts/ci/phase-2b-naming/kebab-check.sh`: same `find`, skip regex, basename rule, exceptions, messages
      and exit code; one `awk` pass.
- [ ] P3 `PHASE-2B-NAMING-ENFORCEMENT.yml`: checkout without `fetch-depth: 0`; the kebab step runs the script. Other
      steps unchanged.
- [ ] P4 `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`: `setup-node` `cache: npm` +
      `cache-dependency-path: services/gateway/package-lock.json`; `npm ci --no-audit --no-fund`. Job `validate`,
      trigger, build and validator unchanged.
- [ ] P5 `node --test scripts/ci/phase-2b-naming/*.test.mjs`, `node --test scripts/collab/*.test.mjs`, preflight;
      on the PR head both jobs green; before/after timings in `timings.md`.

**Acceptance**
- `validate` still runs on every `pull_request`, still runs `npm run build` and the canonical-source validator; the
  log shows a setup-node npm cache restore.
- The kebab check reports exactly what the inline loop reports, on fixtures and on the repository tree (oracle test).
- No other PHASE-2B step changes; no git-history-dependent step exists in the workflow.
- Measured job durations on the PR head are below the §2 baselines (ENFORCE p50 158 s, PHASE-2B p50 65 s).
