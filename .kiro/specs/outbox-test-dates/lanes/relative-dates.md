---
lane: relative-dates
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: messenger
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx
  - docs/validation/VTID-*/**
updated: 2026-10-28T11:55Z
claimed_by: kiro-exafyltd-202610220833-d231
branch: kiro/outbox-test-dates/relative-dates
pr: https://github.com/exafyltd/vitana-v1/pull/1507
vtid: VTID-05372
---
# relative-dates — outbox fixtures relative to now (vitana-v1)
Plan: `.kiro/specs/outbox-test-dates/plan.md`. **Held until PLAN-SPAR allocates this lane's VTID.**

## Log
### 2026-10-28T10:40Z · kiro-exafyltd-202610220833-d231 · created → ready
Created and held.

### 2026-10-28T10:36Z · ci-plan-spar · ready (VTID allocated)
VTID-05372 allocated after policy approval (converged-auto-v1).

### 2026-10-28T11:55Z · kiro-exafyltd-202610220833-d231 · ready → executing
Built D1–D2 in exafyltd/vitana-v1#1507 (14d18a4b1): the send-status outbox fixtures are now relative to now. Red 2/17
on origin/main, green 17/17 on head, full Vitest 3826/3826. CI: Vitest pending; pr-gate re-run (public.ecr.aws
"Data limit exceeded", infra). The NATIVE-CI parity job is red because of stale core extracts on main itself
(`gen-core-extract --check` fails on origin/main); it is not a required check and is outside this lane.
