---
lane: jobs-community-scan-tenant
state: ready
next_actor: kiro
depends_on: [jobs-tenant-loop]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/services/community-autopilot/scan-runner.ts
  - services/gateway/src/routes/autopilot-recommendations.ts
  - services/gateway/src/services/memory-embedding-backfill-loop.ts
  - services/gateway/test/vtid-05268-community-scan-tenant.test.ts
  - docs/validation/VTID-05268/**
updated: 2026-10-22T19:50Z
vtid: VTID-05268
---
# jobs-community-scan-tenant — community scan & memory backfill per active tenant (repo vitana-platform)

Plan: `.kiro/specs/mt-jobs/plan.md` (authoritative) and the `jobs-community-scan-tenant` section of `tasks.md`
(C1–C4, allowed paths, acceptance). Design: `design.md`.

`runCommunityScan` (`scan-runner.ts:255`) + the `/community-scan` route (`autopilot-recommendations.ts:2281`) loop
active tenants under the flag; in a tenant pass the member query (`scan-runner.ts:265`) is `is_primary` AND
`tenant_id` (each member once, under their primary tenant) and that tenant's `tenant_settings.timezone` is the final
default of the per-member clock (`:274-284`); off, platform-wide as today. The
route currently emits one `community_autopilot.scan.completed` OASIS event per call
(`autopilot-recommendations.ts:2299-2309`); under the loop it emits ONE event per tick that keeps the six top-level
fields (`enabled`, `dry_run`, the four counts summed) and adds `per_tenant`; flag off ⇒ identical payload; never N
per tick. The memory-embedding backfill loop's tenant source
becomes `activeTenantIds(sb)` under the flag (`MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` the off/pinned override).
Depends on `jobs-tenant-loop`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID and flips it to `next_actor: kiro`. Rules
(collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve, no deploy, no
Supabase/AWS write. Work only inside the allowed paths. Branch `kiro/mt-jobs/jobs-community-scan-tenant`; PR title
`VTID-xxxxx (mt-jobs/jobs-community-scan-tenant): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-jobs/jobs-community-scan-tenant`. When the PR is open: set `state: in-review`, `next_actor: kiro`
(reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Depends on `jobs-tenant-loop` (shared loop/resolver). Seat `jtadic`, reviewer `exafy`.
### 2026-10-18T20:08Z u{00B7} kiro-hotmail-202610151618-b437 u{00B7} re-spar round (s2-round-1 R1-F4)
Added the OASIS aggregation decision: the per-call emit at autopilot-recommendations.ts:2299-2309 becomes ONE aggregated event after the per-tenant loop, not N per tick. C1/C3 updated. Paths unchanged.

### 2026-10-20T17:30Z · kiro-hotmail-202610151618-b437 · spar session 2 round 1 (76c3c99c) — no path change
R1-F3/F4: a tenant pass scans members by primary membership in that tenant (each member once); the one event per tick
keeps today's six top-level payload fields (backward-compatible) and adds `per_tenant`.

### 2026-10-20T17:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05268 allocated after policy approval (converged-auto-v1).

### 2026-10-22T19:50Z · kiro-hotmail-202610221946-2ad6 · paths glob fix (plan author)
`paths` listed the directories `services/gateway/test/` and `docs/validation/` without a glob, so Lane scope
(`globToRegex`) matched no file under them and refused PR #4319. Narrowed to what `tasks.md` C3/C4 allow:
`services/gateway/test/vtid-05268-community-scan-tenant.test.ts` and `docs/validation/VTID-05268/**`. No other key,
no state change. The other mt-jobs lanes keep their directory entries for now (one PR per lane).
