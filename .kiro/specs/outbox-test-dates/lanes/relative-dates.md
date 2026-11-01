---
lane: relative-dates
state: in-review
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
updated: 2026-10-28T12:00Z
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

### 2026-10-28T12:00Z · kiro-exafyltd-202610220833-d231 · executing → in-review (independent review requested)
exafyltd/vitana-v1#1507 head 14d18a4b1: Vitest (jsdom), Edge data client and Realtime helper are green. pr-gate is red
twice at its postgres service image pull (public.ecr.aws "Data limit exceeded", infra; out of scope of
ci-ecr-public-auth, premise 4). It is re-run when the registry allows.
Review route (§8, driver.md step 4): this plan has no live driver. The next Kiro session that resumes it (a seat
automation or another interactive session, not in this lane's executing log) runs `vitana-lane-reviewer` on the PR's
current head and commits the review entry. Setting `reviewer_seat` here is refused by Lane scope, because lane
permissions come from the base revision. The builder session released its
claim and runs no driver for this plan. The owner's merge approval is not a substitute for this review.
