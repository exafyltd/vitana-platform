---
lane: gateway-test-card
state: parked
next_actor: kiro
branch: kiro/companion-test-card/gateway-test-card
depends_on: []
executor: kiro
seat: exafyltd
area: platform
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/routes/companion.ts
  - services/gateway/src/services/companion/test-card.ts
  - services/gateway/src/types/cicd.ts
  - services/gateway/test/companion-test-card.test.ts
  - docs/validation/VTID-*/**
updated: 2026-11-12T20:15Z
vtid: VTID-05588
pr: https://github.com/exafyltd/vitana-platform/pull/4751
parked_from: in-review
---

# Lane: gateway-test-card (repo exafyltd/vitana-platform)

`POST /api/v1/companion/test-card`: exafy admin only, sends one Vitana Index companion card to the caller. Tasks
T1-T5 in tasks.md.

## Log
### 2026-11-06T17:10Z · kiro-exafy-202611061658-9ca9 · ready
Lane created with the plan.

### 2026-11-06T17:09Z · ci-plan-spar · ready (VTID allocated)
VTID-05588 allocated after policy approval (converged-auto-v1).

### 2026-11-06T17:10Z · kiro-exafy-202611061658-9ca9 · ready → executing
Claimed; branch `kiro/companion-test-card/gateway-test-card` from origin/main `2b9356e041`.

### 2026-11-06T17:26Z · kiro-exafy-202611061658-9ca9 · executing → in-review
Built on `kiro/companion-test-card/gateway-test-card` from origin/main `2b9356e041`. Test first: 13 failed on base, 13
passed on head (`docs/validation/VTID-05588/red-on-base.txt`). Companion suites 77/77, `test:roles` 105/105,
typecheck and build clean; the full suite's 2 failures fail the same on base (`commands.log`). PR https://github.com/exafyltd/vitana-platform/pull/4751. Decision:
`getSupabase()` is the service-role client (sparring R2-F1). Next: reviewer agent on the current head.

### 2026-11-06T17:52:00Z · agent-vitana-lane-reviewer-202611061752-166e · review
review: changes
head: d40cefc21eea15005cddc95bd84d332da9258b54
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4751
Findings: [blocking] Item 3: CI on head d40cefc2 could not be verified. gh pr view and gh pr checks fail with "GraphQL pass-through is not supported", and gh run view needs a run id that no allowed command can list. Without CI evidence the verdict cannot be accept.
Findings: [non-blocking] test/companion-test-card.test.ts: the staging, off and shadow tests check only that nothing was inserted. They do not check that no table was read or that compose was never called. The code order already meets 10c.
Findings: [non-blocking] routes/companion.ts: the 60 s rate limit is an in-process Map, so each gateway task counts separately. The plan accepts this; noted for Gate 2.
Findings: [non-blocking] 10d passes. lib/supabase.ts:9/19 builds getSupabase() with the service-role key, and getServiceClient() is not exported, so getSupabase() meets the plan's intent (R2-F1).
Findings: Other items pass on reading the code (1, 2, 4, 5, 6, 7, 8, 9, 10a, 10b, 10c, 10e).
Next: the lane's seat (or the caller) supplies readable CI status for head d40cefc2 and re-requests review. No code change is required by this review.

### 2026-11-06T17:54Z · kiro-exafy-202611061658-9ca9 · in-review → executing
Review `changes` on d40cefc2: the only blocking finding is that the reviewer could not read CI (`gh pr checks` is not
available in Kiro Web). Taking the non-blocking test finding too: the staging, off and shadow refusals now also assert
that no table is read and that fetchIndex and compose are not called.

### 2026-11-06T17:55Z · kiro-exafy-202611061658-9ca9 · executing → in-review
Refusal tests hardened (13/13 green, outputs/green.txt). The next review gets the head's check-run ids so CI can be
read with `gh run view`. PR https://github.com/exafyltd/vitana-platform/pull/4751.

### 2026-11-06T18:29:00Z · agent-vitana-lane-reviewer-202611061829-aa3f · review
review: accept
head: a5dab40125c77971e545118d9965cd603b33ac5b
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4751
Findings: [non-blocking] routes/companion.ts: the 60 s rate limit is an in-process Map, so each gateway task counts separately. The plan accepts this; noted for Gate 2.
Findings: [non-blocking] routes/companion.ts uses getSupabase() where plan.md names getServiceClient(). lib/supabase.ts builds getSupabase() only from the service-role key, so 10d passes (R2-F1).
Findings: [non-blocking] routes/companion.ts: the new console.error in the catch block draws an "Unexpected console statement" lint annotation. The runs still concluded success (42270102908, 42270102906).
Findings: Item 3 passes: all 13 workflow runs on a5dab40 are completed/success. Item 4 passes: red 13 failed on base 2b9356e0, green 13/13 on head. Item 5 passes: the only test change since d40cefc2 adds assertions. Items 1, 2, 6, 7, 8 (no UI), 9 (no protected gate file), 10a-10e pass.
Next: the land step merges under §7b
### 2026-11-12T20:15Z · pm-agent · in-review → parked
park (stale_claim); claim released; Claude unavailable → exafyltd
