---
lane: native-extract-regen
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-v1]
paths:
  - packages/core/src/extracted/news-feed-ranker.generated.ts
  - packages/core/src/extracted/feed-compose.generated.ts
  - docs/validation/VTID-*/**
updated: 2026-11-03T12:16Z
vtid: VTID-05476
claimed_by: kiro-jtadic-202610291040-a0e6
branch: kiro/welcome-finish-r2/native-extract-regen
pr:
---
# Lane `native-extract-regen`
Plan: `.kiro/specs/welcome-finish-r2/` — `plan.md` and the `tasks.md` section `<!-- lane: native-extract-regen -->` are authoritative.
VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

## Log
### 2026-10-30T15:00Z · kiro-jtadic-202610291040-a0e6 · created → ready
Lane drafted with the plan.

### 2026-11-02T15:59Z · ci-plan-spar · ready (VTID allocated)
VTID-05476 allocated after policy approval (converged-auto-v1).

### 2026-11-03T12:16Z · kiro-jtadic-202610291040-a0e6 · ready → executing
Built in vitana-v1 (branch `kiro/welcome-finish-r2/native-extract-regen`, lane head `98961f693`, then merged with `origin/main` to pick up the latest base). This is an evidence-only lane: on vitana-v1 `main` both `node scripts/native/gen-core-extract.mjs --check` and `node scripts/native/core-closure.mjs --check` already exit 0 — VTID-05427 regenerated the native extracts — so there are no generated or runtime file changes to make. Red-on-base is therefore not reproducible, and `acceptance.md` states so. The evidence lives in `docs/validation/VTID-05476/` in vitana-v1. It must still land before vitana-v1 #1520 so that PR's NATIVE-CI runs on a green base. Next: the reviewer agent reviews the code PR (exafyltd/vitana-v1).
