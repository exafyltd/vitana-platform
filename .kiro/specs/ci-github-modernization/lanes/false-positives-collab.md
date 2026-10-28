---
lane: false-positives-collab
state: ready
next_actor: kiro
depends_on: []
executor: claude
seat: exafyltd
reviewer_seat: claude
paths:
  - scripts/collab/queue.mjs
  - scripts/collab/queue.test.mjs
  - docs/validation/**
updated: 2026-10-21T12:26Z
vtid: VTID-05304
---
# Lane: false-positives-collab

Fix the Lane scope / Collab handoff false positives (reviewer-agent seat mismatch; `ci-plan-spar`/
`pm-agent` counted as a second session on a `_plan` lane; protected-gate file under an owner instruction
flagged by the check) and the Windows-only `queue.test.mjs` failures (`C:\C:\` path, `rm`) — one lane
because all of it is `queue.mjs`/`queue.test.mjs` (no two lanes may edit the same file). Tasks T1–T5 in
`tasks.md`.

`executor: claude` and this is a **protected gate file** (`scripts/collab/queue.mjs`): with
`CLAUDE_AVAILABLE=false` it is blocked on an owner instruction naming this plan before it can merge
(surfaced for Gate 2). Keep every subcommand name/shape (`scope-check` is grepped literally by vitana-v1;
a signature change alters v1 CI at the platform-merge instant). **Sequence behind open #4210** (VTID-05259,
the authoritative governance scope-check rewrite) and #4188 — rebase onto their merged result; never a
parallel `queue.mjs` lane. The fix must pass Lane scope under the OLD (base-revision) checker. Does **not**
edit the three-copy protected-gate list. No VTID yet.

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · ready
Lane created with the plan. Scope: `queue.mjs` + `queue.test.mjs` + validation docs. Evidence from
inv-rules §7 / inv-code §3-4 / inv-tests §2-3,6. Flagged protected-gate + the #4210/#4188 collision
(R1/R2/R6). No VTID yet.

### 2026-10-21T12:26Z · ci-plan-spar · ready (VTID allocated)
VTID-05304 allocated after policy approval (converged-auto-v1).
