---
lane: jobs-automation-actor-tenant
state: ready
next_actor: owner
depends_on: [jobs-tenant-loop]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/routes/community.ts
  - services/gateway/src/routes/match-feedback.ts
  - services/gateway/src/routes/matchmaking.ts
  - services/gateway/src/routes/admin-signups.ts
  - services/gateway/src/services/orb-tools/groups-events-tools.ts
  - services/gateway/test/
  - docs/validation/
updated: 2026-10-15T16:40Z
---
# jobs-automation-actor-tenant — automation events carry the actor's real tenant (repo vitana-platform)

Plan: `.kiro/specs/mt-jobs/plan.md` (authoritative) and the `jobs-automation-actor-tenant` section of `tasks.md`
(A1–A3, allowed paths, acceptance). Design: `design.md`.

The seven event-dispatch sites (`community.ts:274,382,482`, `match-feedback.ts:280`, `matchmaking.ts:576`,
`admin-signups.ts:205`, `groups-events-tools.ts:360`) resolve the actor's real tenant via `resolveActorTenant`
(from `jobs-tenant-loop`) when the flag is on; off, `DEFAULT_TENANT_ID` unchanged. Depends on `jobs-tenant-loop`
for the resolver.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID and flips it to `next_actor: kiro`. Rules
(collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve, no deploy, no
Supabase/AWS write. Work only inside the allowed paths. Branch `kiro/mt-jobs/jobs-automation-actor-tenant`; PR title
`VTID-xxxxx (mt-jobs/jobs-automation-actor-tenant): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-jobs/jobs-automation-actor-tenant`. When the PR is open: set `state: in-review`, `next_actor: kiro`
(reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Depends on `jobs-tenant-loop` (shared resolver). Seat `jtadic`, reviewer `exafy`.
