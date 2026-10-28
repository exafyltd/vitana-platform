---
lane: speed-path-filters
state: executing
next_actor: claude
depends_on: [fake-checks-dedupe]
executor: claude
seat: exafyltd
reviewer_seat: claude
claimed_by: kiro-202610211348-9f71
branch: kiro/ci-github-modernization/speed-path-filters
paths:
  - .github/workflows/PR-GATE.yml
  - .github/workflows/TEST-SUITE.yml
  - scripts/ci/test-suite/shard-union.test.mjs
  - scripts/ci/test-suite/rerun-policy.test.mjs
  - docs/validation/**
updated: 2026-10-21T16:30Z
vtid: VTID-05307
---
# Lane: speed-path-filters

Speed up CI with caching, path filters on **non-gate** jobs only, de-dup, and a confirmed/re-balanced
gateway Jest shard setup — target ≤ 15 min on a typical gateway PR. Tasks T1–T4 in `tasks.md`.

`executor: claude` and it edits `PR-GATE.yml`, a **protected gate file**: with `CLAUDE_AVAILABLE=false` it
is blocked on an owner instruction naming this plan before it can merge (surfaced for Gate 2). Hard
constraints: never path-filter the required gate jobs (PR-GATE / Lane scope / Collab handoff) — a required
check that never runs stays pending and wedges merges (inv-code §5). Does **not** flip PR-GATE
`enforce:true` (behaviour change + protected-gate edit → listed for Gate 2). `CICDL-GATEWAY-CI.yml` is
owned by `fake-checks-dedupe`, so this lane `depends_on` it and does not touch that file. No VTID yet.

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · ready
Lane created with the plan. Scope: PR-GATE.yml, TEST-SUITE.yml, the shard/rerun tests, validation docs.
Evidence from inv-code §5 / inv-tests §3(D),§4. Flagged protected-gate, the required-check path-filter
trap, and the enforce-flip deferral (R4/R5). `depends_on: fake-checks-dedupe` to keep CICDL disjoint. No
VTID yet.

### 2026-10-21T11:52Z · kiro-hotmail-202610210852-0b8e · spar s2 round-1 R1-F2/R1-F3 accepted
This lane owns every TEST-SUITE.yml edit, so it now also lands the vcaop-matrix migration lane 1 depends
on: a `typecheck` step and a run-in-band `test:guardrails` step on the `vcaop` entry (TEST-SUITE.yml
:111-113). Build de-dup clarified: the real gateway-build duplicate is CICDL ↔ ENFORCE (the required
check), handled in lane 2; this lane changes no gateway build step and still does not touch
`CICDL-GATEWAY-CI.yml`. Paths unchanged.

### 2026-10-21T12:20Z · kiro-hotmail-202610210852-0b8e · spar s2 round-2 R2-F2 accepted
Committed the vcaop-matrix migration to one concrete mechanism (option A, conditional steps on the shared
`services` body): add `typecheck`/`guardrails` keys to the `vcaop` matrix entry only, and two steps after
`Run tests` guarded by `if: matrix.typecheck != ''` / `if: matrix.guardrails != ''`. Absent keys render as
`''` for oasis-projector/openclaw-bridge so their guards are false — no empty `run:`. Proof test parses
TEST-SUITE.yml and asserts the vcaop keys, the two guarded steps, and the absence of the keys on the other
two entries. Paths unchanged.

### 2026-10-21T12:26Z · ci-plan-spar · ready (VTID allocated)
VTID-05307 allocated after policy approval (converged-auto-v1).

### 2026-10-21T16:30Z · kiro-202610211348-9f71 · executing (implemented)
Claimed lane (claim sha 82df873e9), worktree on origin/main 183af3e9 (fake-checks-dedupe already landed;
all depends_on satisfied). Implemented T1–T4:
- **T1 caching:** `TEST-SUITE.yml` gateway shards get `setup-node` `cache: pnpm` +
  `cache-dependency-path: pnpm-lock.yaml` (root workspace lockfile); the `services` matrix gets per-entry
  `cache`/`lockfile` keys wired into `setup-node` (`cache: npm` + each service's `package-lock.json` for
  vcaop/oasis-projector; `cache: pnpm` + `openclaw-bridge/pnpm-lock.yaml`). `PR-GATE.yml` `pr-gate` job
  gets `cache: npm` + `services/gateway/package-lock.json` for its conditional gateway `npm ci`.
- **T2 path filters:** added NONE to the required gate jobs (PR-GATE/Lane scope/Collab handoff) — a
  path-filtered required check stays pending and wedges merges (inv-code §5). TEST-SUITE already carries
  its own non-gate `paths:` filter; left as-is. Verified PR-GATE still triggers on `pull_request` types
  only with no `paths:`.
- **T3 shards:** kept the 4-shard gateway matrix (VTID-05272) intact — not collapsed. No hand-maintained
  shard assignment exists to re-balance (Jest's `--shard=N/4` balances by file over `--listTests`); the
  ground-truth count (~1,737 suites / 4 ≈ ~434 per shard) does not warrant a count change. Recorded the
  ground-truth counts and the uncovered Playwright/e2e + shell/Python coverage gap for the ci-health lane
  in `docs/validation/VTID-05307/measured-critical-path.md`.
- **T4 tests/artifact:** extended `scripts/ci/test-suite/shard-union.test.mjs` with two assertions
  pinning the caching contract + surviving 4-shard matrix + unfiltered/`enforce`-untouched gate — red on
  base (no cache), green on head (node --test: 15/15 pass). `rerun-policy.test.mjs` unchanged (no rerun
  logic changed). Before/after critical path + red→green proof + commands.log under docs/validation.
- **Did NOT** add the `typecheck`/`guardrails` keys to the vcaop matrix entry — the converged plan
  (R1-F1) removed that migration (the earlier spar-round log entries above predate R1-F1);
  `VCAOP-GUARDRAILS-CI.yml` already runs those gates, so lane 1 (dead-workflows) handles vcaop with no
  TEST-SUITE change. Did NOT touch `CICDL-GATEWAY-CI.yml` (lane 2) and did NOT flip `enforce`.
- **Protected gate:** `PR-GATE.yml` is a protected gate file; with `CLAUDE_AVAILABLE=false` this lane's
  merge needs an owner instruction naming the plan (surfaced for Gate 2). Logged in decisions.md.

### 2026-10-22T12:55Z · agent-vitana-lane-reviewer-202610221255-5f07 · review
review: changes
head: 067e1bbd41578fe533c22389260a1e3fd085cbf3
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4261
Findings: blocking - Gateway (Jest, shard 1/4) and Test Suite Summary failed on the current head (run 39769711351); blocking - Collab handoff failed on the current head (commits from 2 sessions: kiro-exafyltd-202610220837-1779, kiro-202610211348-9f71; claim held by kiro-202610211348-9f71); non-blocking - protected gate file .github/workflows/PR-GATE.yml needs a legacy Claude review or owner instruction before merge
Next: the lane's seat fixes the blocking findings
