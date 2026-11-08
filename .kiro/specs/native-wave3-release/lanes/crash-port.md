---
lane: crash-port
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/src/telemetry/**
  - apps/mobile/tests/telemetry/**
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T11:36Z
vtid: VTID-05631
---
# Crash-free session port with a no-op default (provider-agnostic)
Plan: `.kiro/specs/native-wave3-release/` — `plan.md` (decision 3) and the `tasks.md` section marked
`<!-- lane: crash-port -->` (tasks X1–X3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** `apps/mobile/src/telemetry/crash-port.ts` defines `startSession`, `endSession(crashed)` and `setCrashProvider`,
with a no-op default. The pattern is that of `apps/mobile/src/push/provider.ts:53`. No SDK package is added; the
vendor is owner-gated (`crash-sdk-owner`).

**Acceptance (reviewer: hotmail):** unit tests cover session start and end, the crashed flag, the default provider
sending nothing, and a provider error that is caught and not thrown into the UI; `npm test` and `npm run typecheck`
pass in `apps/mobile`; `package.json` gains no dependency.

**Never:** no network call from the port, no SDK import, no production host, no VTID by hand.

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → ready
Drafted with the plan. No crash-reporting SDK is wired on `origin/main`.

### 2026-11-08T11:36Z · ci-plan-spar · ready (VTID allocated)
VTID-05631 allocated after policy approval (converged-auto-v1).
