---
lane: jobs-tenant-loop
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/services/mt-flags.ts
  - services/gateway/src/services/jobs/job-tenant-loop.ts
  - services/gateway/src/index.ts
  - services/gateway/src/routes/scheduled-notifications.ts
  - services/gateway/test/
  - docs/validation/
updated: 2026-10-15T16:40Z
---
# jobs-tenant-loop — shared mt-flags + active-tenant loop (repo vitana-platform)

Plan: `.kiro/specs/mt-jobs/plan.md` (authoritative) and the `jobs-tenant-loop` section of `tasks.md` (L1–L6,
allowed paths, acceptance). Design: `design.md`.

Adds the shared `services/gateway/src/services/mt-flags.ts` and `services/gateway/src/services/jobs/job-tenant-loop.ts`
that gate the mt-launch APIs and the M2 flag flips, and converts the heartbeat loop (`index.ts:1838-1866`) and the
`scheduled-notifications.ts` routes to iterate active tenants under the flag. Flag off ⇒ byte-for-byte today. No
migration. Keep `npm run test:operator` green.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID and flips it to `next_actor: kiro` (seat
`jtadic`). Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve,
no deploy, no Supabase/AWS write. Work only inside the allowed paths. Branch `kiro/mt-jobs/jobs-tenant-loop`;
PR title `VTID-xxxxx (mt-jobs/jobs-tenant-loop): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-jobs/jobs-tenant-loop`. When the PR is open: set `state: in-review`, `next_actor: kiro` (reviewer
seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
First code lane; the shared gate (`mt-flags.ts`, `job-tenant-loop.ts`) the other three code lanes and mt-launch
build on. Seat `jtadic` (uncovered platform gateway work per the brief's lane rule), reviewer `exafy`.
