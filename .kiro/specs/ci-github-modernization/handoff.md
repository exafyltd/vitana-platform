---
slug: ci-github-modernization
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: parked
updated: 2026-10-21T10:16Z
parked_from: drafted
---
# Handoff — ci-github-modernization

Modernizes CI and GitHub for both Vitana repos: remove the one live dead GCP workflow, delete the dead
no-op remnants, fix the four confirmed pipeline false positives at their cause, fix the permanently-red
suites, speed up CI with caching / path filters / de-dup, and add a daily CI-health report. Phase 1
(read-only inventory, classification, time budget) is done — evidence in `RUN/investigate/inv-code.md`,
`inv-rules.md`, `inv-tests.md`. This spec is Phase 2.

Plan: `plan.md` (between the plan markers — what PLAN-SPAR spars). Tasks per lane in `tasks.md`.
Drafted — to be sparred by PLAN-SPAR; VTIDs allocated on convergence (policy `converged-auto-v1`), never
by hand.

Governance reality (shapes the whole split): almost every lane edits a governance path
(`.github/**`, `scripts/collab/**`, `scripts/ci/**`) so is `executor: claude`; three lanes edit a
**protected gate file** (false-positives-collab → `queue.mjs`; plan-spar-checks → `PLAN-SPAR.yml`;
speed-path-filters → `PR-GATE.yml`) and, with `CLAUDE_AVAILABLE=false` this run, each is blocked on an
owner instruction naming this plan before it can merge — surfaced for Gate 2. Only `stale-tests` is a
straightforward Kiro lane. No lane edits `CLAUDE.md` or the three-copy protected-gate list.

Branch-protection changes, the PR-GATE `enforce:true` flip, and any repo secret
(`PLAN_SPAR_PUSH_TOKEN`) are owner config: **listed for Gate 2, never made**.

Lanes (parallel by default, build concurrency ≤ 6; dependency order below):
- `dead-workflows` — vitana-platform, executor **claude** (`.github/**`). Remove `VCAOP-CICD.yml`. Independent.
- `fake-checks-dedupe` — vitana-platform, executor **claude** (`.github/**`). Delete dead CICDL Jest block + de-dup. Independent.
- `false-positives-collab` — vitana-platform, executor **claude**, **protected gate** (`queue.mjs`). Lane scope / Collab handoff false positives + Windows fixes. Sequence behind #4210 / #4188.
- `false-positives-validator` — vitana-platform, executor **claude** (`.github/**` + `scripts/ci/**`). VALIDATION_PROFILE template / clear failure. Independent.
- `plan-spar-checks` — vitana-platform, executor **claude**, **protected gate** (`PLAN-SPAR.yml`). Bot-head checks. Independent.
- `speed-path-filters` — vitana-platform, executor **claude**, **protected gate** (`PR-GATE.yml`). Caching / path filters / de-dup / shards. `depends_on: fake-checks-dedupe`.
- `stale-tests` — vitana-v1 + vitana-platform, executor **kiro** (seat `exafy`, reviewer `jtadic`). Fix VTID-05201 (v1) and VTID-05082 (platform) at cause. Independent.
- `ci-health` — vitana-platform, executor **claude** (`.github/**` + `scripts/ci/**`). Daily CI-health report. Independent.

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · drafted
Authored the spec from the three Phase-1 investigations (inv-code / inv-rules / inv-tests), grounded in
`origin/main` (a2d069ea). Eight lanes, files disjoint, real `depends_on` only. Isolated each protected-
gate edit into its own lane so one owner instruction can name them at Gate 2. Corrected the brief's stale
premises (UNIT.yml already real; EXEC/STAGE-DEPLOY already gone; dead-GCP set is just VCAOP-CICD.yml;
TEST-SUITE runs one Jest job not "4 shards"). No VTID allocated by this session. Next: push as `plan(` PR
for PLAN-SPAR round 1.

### 2026-10-21T10:16Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (round_cap_reached). Parked with the open findings in sparring/.
