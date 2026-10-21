---
lane: ci-health
state: executing
next_actor: kiro
depends_on: []
executor: claude
seat: exafyltd
reviewer_seat: claude
claimed_by: kiro-202610211348-9f71
branch: kiro/ci-github-modernization/ci-health
paths:
  - .github/workflows/CI-HEALTH.yml
  - scripts/ci/health/**
  - docs/validation/**
updated: 2026-10-21T17:35Z
vtid: VTID-05301
---
# Lane: ci-health

Add a daily CI-health report (scheduled workflow + producer script + test) that reports flake rate,
red-on-main age and per-check median/p90 duration, modelled on `ALERT-*.yml` / `TEST-CATALOG.yml`'s
`schedule:`+publish shape. Turns the Phase-1 inventory into a standing signal. Tasks T1–T3 in `tasks.md`.
`executor: claude` (new `.github/**` + `scripts/ci/**`; **not** a protected gate file → merges on a
reviewer-agent accept). GitHub reads only, never against production. No VTID yet.

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · ready
Lane created with the plan. Scope: new CI-HEALTH.yml, scripts/ci/health/**, validation docs. Evidence
from inv-code §6 (no existing health aggregator; closest patterns named). No VTID yet.

### 2026-10-21T12:26Z · ci-plan-spar · ready (VTID allocated)
VTID-05301 allocated after policy approval (converged-auto-v1).

### 2026-10-21T17:35Z · kiro-202610211348-9f71 · executing
Claimed the lane (claim ref collab-claim/ci-github-modernization/ci-health). Implemented T1–T4:
- `scripts/ci/health/report.mjs` — producer reading `gh run list --json` data; pure exported
  `buildReport`/`percentiles`/`runDurationMs`/`normalizeCoverageGap`/`renderMarkdown`; reports flake
  rate (a head SHA that failed then succeeded), red-on-main age (oldest consecutive failing main run),
  per-check median/p90 duration, and the Playwright/e2e + shell/Python coverage gap (T1, T4).
- `.github/workflows/CI-HEALTH.yml` — scheduled (`17 5 * * *`) + dispatch, `contents:read`+`actions:read`,
  runs the producer over `gh run list` (GitHub reads only, no production call), publishes to the step
  summary + an artifact (T2).
- `scripts/ci/health/report.test.mjs` — `node --test`, dependency-free, enforced by UNIT.yml (T3).
Red on base (both files absent on origin/main); green on head (`node --test …` 9/9). Workflow YAML parses.
Not a protected gate file → merges on the reviewer-agent accept. Deploys nothing.
