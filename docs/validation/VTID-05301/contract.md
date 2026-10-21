# VTID-05301 — ci-health: daily CI-health report

Lane `ci-health` of plan `ci-github-modernization`. Turns the Phase-1 CI inventory
into a standing signal. GitHub reads only — never a call against any production service.

## What ships

- `scripts/ci/health/report.mjs` — producer. Pure, exported functions
  (`runDurationMs`, `percentiles`, `buildReport`, `normalizeCoverageGap`,
  `renderMarkdown`) + a `main()` that only does I/O. Reads the array produced by
  `gh run list --json name,conclusion,status,headSha,headBranch,createdAt,updatedAt`
  and emits `vitana.ci-health/v1`:
  - **flake rate** per workflow — a head SHA that both `failure`d and later
    `success`ed in the window (a re-run that went green); `flakeRate = flaky heads /
    heads with any failure`.
  - **red-on-main age** — for a workflow whose newest `main` run concluded
    `failure`, the hours back to the oldest *consecutive* failing `main` run (a
    green run before the streak does not extend it).
  - **per-check median / p90 duration** — from each finished run's
    `createdAt → updatedAt` wall time (nearest-rank p90).
  - **coverage gap** — the Playwright/e2e specs (~50) and the shell/Python test
    scripts that no required check runs today (ground-truth from the plan's "Today"
    section), carried as a recurring signal.
- `.github/workflows/CI-HEALTH.yml` — scheduled (`cron: '17 5 * * *'`) +
  `workflow_dispatch`. `permissions: contents: read, actions: read`. Runs
  `gh run list` (read-only) then the producer; publishes to the job step summary
  and uploads `ci-health.json` as an artifact. No deploy, no AWS, no production call.
- `scripts/ci/health/report.test.mjs` — `node --test`, dependency-free, so UNIT.yml
  (runs every `scripts/**/*.test.{cjs,mjs}`) enforces it. Covers flake rate,
  red-on-main age (including the green-latest case), per-check duration, the empty
  input case and the coverage gap.

## Current contract the assertions match

- `gh run list --json …` returns an array of objects with `name`, `conclusion`
  (`success`/`failure`/…), `status`, `headSha`, `headBranch`, `createdAt`,
  `updatedAt` (ISO-8601). The producer normalizes missing/extra fields and ignores
  runs with no workflow name.
- Only `success`/`failure` runs are counted as "finished" for flake/red/duration;
  in-progress or cancelled runs are excluded.

## Scope

Files are entirely within the lane's `paths`
(`.github/workflows/CI-HEALTH.yml`, `scripts/ci/health/**`, `docs/validation/**`).
Not a protected gate file (new `.github/**` + `scripts/ci/**`), so it merges on the
reviewer-agent accept. Deploys nothing → no `staging-tests.json`, no Gate 2.
