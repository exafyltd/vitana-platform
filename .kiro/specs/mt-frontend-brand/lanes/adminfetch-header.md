---
lane: adminfetch-header
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
paths:
  - src/lib/admin-api.ts
  - src/lib/admin-api.test.ts
updated: 2026-10-19T20:32Z
vtid: VTID-05241
---
# adminfetch-header — adminFetch sends documented tenant headers (repo vitana-v1)

Plan: `.kiro/specs/mt-frontend-brand/plan.md` and the `adminfetch-header` section of `tasks.md`
(AF1–AF2, allowed paths, acceptance). Design: `design.md`.

**Held until PLAN-SPAR allocates this lane's VTID** (`next_actor: owner`); PLAN-SPAR flips it to
`kiro`.

**This lane is preparatory plumbing** (round-1 R1-F2). It makes `adminFetch` SEND
`X-Vitana-Tenant` + `X-Vitana-Active-Role` and fixes the lying JSDoc so the doc matches the
code. No gateway route that `adminFetch` calls reads these headers yet — the only current
readers (`autopilot-recommendations.ts:430,1799,2336`, `calendar.ts:1054`) are not adminFetch
targets. The gateway-side tenant-scoping reads are a named WS7 follow-on VTID (plan Out of
scope), NOT this lane. The lane's member-neutral value today is the JSDoc fix; the Vitest
proves only client-send, not server-consumption.

Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`/another lane, no merge/approve/deploy/dispatch, no Supabase/AWS writes. Work only
in the allowed paths. Small, isolated change. The lane adds its own `docs/validation/<vtid>/`.
Branch `kiro/mt-frontend-brand/adminfetch-header`; PR title
`VTID-xxxxx (mt-frontend-brand/adminfetch-header): …`; trailers `Collab-Session`/`Collab-Lane`.
On PR open: `state: in-review`, `next_actor: kiro`, `pr: <url>`, log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Premise: `admin-api.ts:5-7` JSDoc claims it injects `X-Vitana-Tenant`/
`X-Vitana-Active-Role` but `:33-41` sends only Content-Type + Authorization; gateway CORS
already allows those headers (`cors.ts:67`, the `allowedHeaders` array). Reviewer seat `jtadic`
(≠ `exafyltd`).

### 2026-10-16T17:20Z · kiro-hotmail-202610151618-b437 · sparring round-1 fix (still ready)
Round-1 R1-F2 (major, accepted): verified `adminFetch` is called from commerce/admin/community
surfaces (vcaop portal, partner-onboarding, community/find-member, voice-lab, conversation,
backoffice) — none of those gateway routes read `X-Vitana-Tenant`. Only
`autopilot-recommendations.ts` + `calendar.ts` do, and `adminFetch` does not call them;
`reminders.ts:58` records header-tenant resolution was removed there. Relabelled this lane as
explicitly preparatory plumbing and moved the gateway-side reads to a named WS7 follow-on VTID
(plan Out of scope). R1-F3 (minor, accepted): corrected the CORS citation to `cors.ts:67`
(allowedHeaders array; `:71` was the VTID-02036 credentials comment). plan.md + tasks.md AF1–AF2
updated. State unchanged (`ready`).

### 2026-10-19T20:32Z · ci-plan-spar · ready (VTID allocated)
VTID-05241 allocated after policy approval (converged-auto-v1).
