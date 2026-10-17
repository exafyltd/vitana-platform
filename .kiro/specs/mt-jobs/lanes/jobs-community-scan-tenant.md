---
lane: jobs-community-scan-tenant
state: ready
next_actor: owner
depends_on: [jobs-tenant-loop]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/services/community-autopilot/scan-runner.ts
  - services/gateway/src/routes/autopilot-recommendations.ts
  - services/gateway/src/services/memory-embedding-backfill-loop.ts
  - services/gateway/test/
  - docs/validation/
updated: 2026-10-15T16:40Z
---
# jobs-community-scan-tenant — community scan & memory backfill per active tenant (repo vitana-platform)

Plan: `.kiro/specs/mt-jobs/plan.md` (authoritative) and the `jobs-community-scan-tenant` section of `tasks.md`
(C1–C4, allowed paths, acceptance). Design: `design.md`.

`runCommunityScan` (`scan-runner.ts:255`) + the `/community-scan` route (`autopilot-recommendations.ts:2281`) loop
active tenants under the flag, each tenant's members with that tenant's timezone; off, platform-wide as today. The
memory-embedding backfill loop's tenant source becomes `activeTenantIds(sb)` under the flag
(`MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` the off/pinned override). Depends on `jobs-tenant-loop`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID and flips it to `next_actor: kiro`. Rules
(collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve, no deploy, no
Supabase/AWS write. Work only inside the allowed paths. Branch `kiro/mt-jobs/jobs-community-scan-tenant`; PR title
`VTID-xxxxx (mt-jobs/jobs-community-scan-tenant): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-jobs/jobs-community-scan-tenant`. When the PR is open: set `state: in-review`, `next_actor: kiro`
(reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Depends on `jobs-tenant-loop` (shared loop/resolver). Seat `jtadic`, reviewer `exafy`.
