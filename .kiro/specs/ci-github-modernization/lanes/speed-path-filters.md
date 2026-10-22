---
lane: speed-path-filters
state: parked
next_actor: kiro
depends_on: [fake-checks-dedupe]
executor: claude
seat: exafyltd
reviewer_seat: claude
paths:
  - .github/workflows/PR-GATE.yml
  - .github/workflows/TEST-SUITE.yml
  - scripts/ci/test-suite/shard-union.test.mjs
  - scripts/ci/test-suite/rerun-policy.test.mjs
  - docs/validation/**
updated: 2026-10-22T23:39Z
vtid: VTID-05307
parked_from: ready
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
### 2026-10-22T20:13Z · pm-agent · ready → parked
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:17Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:21Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:25Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:29Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:33Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:37Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:41Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:45Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:49Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:53Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:05Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:09Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:13Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:17Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:21Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:25Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:29Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:33Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:37Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:05Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:09Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:13Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:17Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:21Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:25Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:29Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:33Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:37Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:07Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:11Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:15Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:19Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:23Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:27Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:31Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:35Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T23:39Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
