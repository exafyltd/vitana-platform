---
lane: vitana-v1-verified
state: ready
next_actor: claude
depends_on: [spar-vitana-v1-ref]
executor: claude
reviewer_seat: claude
paths:
  - docs/validation/VTID-*/vitana-v1-spar-evidence.md
updated: 2026-10-19T21:10Z
---
# Sentinel: machine-enforce that the plan was sparred with vitana-v1 readable (R2-F2)

Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) is authoritative. **Governance/control lane
(`executor: claude`).** VTID: assigned by CI after convergence.

**Why this lane exists.** The lane state machine has no `blocked` state, so a prose "approved→executing
self-block" (accepted for R1-F1) is advisory only — the queue would let any `ready` lane with no
`depends_on` be claimed the moment the plan converges, before the vitana-v1 premises were ever verified.
This sentinel converts the gate into real `depends_on` enforcement: **every implementation lane in this
spec lists `vitana-v1-verified` in its `depends_on`**, so the queue treats them as `blocked` until this
lane is `done`.

**The one job.** Confirm, from machine evidence, that a PLAN-SPAR session for this plan actually read
`exafyltd/vitana-v1` and converged on partner-verified native premises:
- a `tool_log` entry `read_file(repo: "exafyltd/vitana-v1", …)` with `ok: true` in the converging session
  (e.g. `apps/mobile/src/config/env.ts`), AND
- that session's `verdict` is `converged` / policy-approved.

Record the session id, the plan hash, and the `ok:true` vitana-v1 tool_log entry in
`docs/validation/<VTID>/vitana-v1-spar-evidence.md`, then set this lane `done`. That `done` unblocks every
implementation lane via the existing `depends_on` machinery. If a converging session shows **no** `ok:true`
vitana-v1 read, this lane stays `ready` and the implementation lanes stay blocked.

**Never** (collaboration §7a): `executor: claude`; the planner/kiro seats never set this lane `done`, never
dispatch workflows or deploy.

## Log
### 2026-10-19T21:10Z · kiro-202610151913-51bd · created → ready
Created in response to sparring R2-F2 (session 2): the R1-F1 self-block was prose-only with no machine
enforcement. This sentinel wires the gate through `depends_on`. next_actor: claude — Claude Code sets it
`done` only after a converging session's tool_log proves a successful vitana-v1 read.
