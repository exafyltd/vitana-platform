---
lane: speed-path-filters
state: ready
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
updated: 2026-10-21T11:20Z
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
