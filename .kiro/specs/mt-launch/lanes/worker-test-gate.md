---
lane: worker-test-gate
state: ready
next_actor: kiro
depends_on: [pack-intake-admin, tenant-owner-analytics]
executor: claude
reviewer_seat: jtadic
paths:
  - .github/workflows/PR-GATE.yml
  - .github/workflows/mt-launch-suites.yml
updated: 2026-10-21T13:58Z
vtid: VTID-05327
---
# worker-test-gate — CI gate for linters, D18 guard, golden (repo vitana-platform)

Plan: `../plan.md` (authoritative) and the `worker-test-gate` section of `../tasks.md` (tasks P1–P2, allowed paths,
acceptance). Design + successor rules: `../design.md`.

**executor: claude.** This lane touches governance paths (`.github/workflows/**`), which collaboration §3a/§7a reserve
for Claude Code — a Kiro `executor` lane may never reach a governance path. So `next_actor: claude` (not owner-held);
Claude builds it. It wires the three linter suites, the D18 analytics health-boundary guard, and the unchanged Maxina
golden assertion into the gateway Jest job / PR-GATE so WS8 code cannot merge without them. No source files change here.

Depends on `pack-intake-admin` and `tenant-owner-analytics` (the suites they add must exist before the gate references
them). Reviewer seat `jtadic` (a Kiro seat reviews the governance lane per §7).

Branch `claude/mt-launch/worker-test-gate`; PR title `VTID-xxxxx (mt-launch/worker-test-gate): …`; commit trailers
`Collab-Session: <claude session id>` and `Collab-Lane: mt-launch/worker-test-gate`.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created. Governance lane, executor `claude`, reviewer seat `jtadic`. VTID allocated by PLAN-SPAR after convergence like
the others; Claude builds it after the two code lanes add their suites.

### 2026-10-21T13:58Z · ci-plan-spar · ready (VTID allocated)
VTID-05327 allocated after policy approval (converged-auto-v1).
