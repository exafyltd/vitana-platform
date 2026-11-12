---
lane: crash-port
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/src/telemetry/**
  - apps/mobile/tests/telemetry/**
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:07Z
vtid: VTID-05659
---
# Crash-free session port with a no-op default (provider-agnostic)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (decision 3) and the `tasks.md` section marked
`<!-- lane: crash-port -->` (tasks X1–X3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** `apps/mobile/src/telemetry/crash-port.ts` defines `startSession`, `endSession(crashed)` and `setCrashProvider`,
with a no-op default. The pattern is that of `apps/mobile/src/push/provider.ts:53`. No SDK package is added; the
vendor is owner-gated (`crash-sdk-owner`).

**Acceptance (reviewer: hotmail):** unit tests cover session start and end, the crashed flag, the default provider
sending nothing, and a provider error that is caught and not thrown into the UI; `npm test` and `npm run typecheck`
pass in `apps/mobile`; `package.json` gains no dependency.

**Never:** no network call from the port, no SDK import, no production host, no VTID by hand.

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/crash-port`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05659 allocated after policy approval (converged-auto-v1).
