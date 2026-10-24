---
lane: health-home-tenant-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101130000_*.sql
  - supabase/migrations/20261101130100_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - services/gateway/test/mt-native-health/health-home-tenant.pgtap.sql
updated: 2026-10-20T09:00Z
---
# Frozen health home tenant (DB) — mt-native-health/health-home-tenant-db (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (authoritative) and the `health-home-tenant-db` group of `tasks.md`
(tasks H1–H4, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates the VTID; it then flips to `kiro` and the lane gets its
`vtid`. Do not start before then.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane's file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes — **a database change is a
migration file in this PR; Claude applies it via RUN-MIGRATION after merge.** Work only inside the allowed paths.
Add `docs/validation/<vtid>/plan-sparring.md` (copy), `scope.json`, `staging-tests.json`, `rollback.sql`,
`live-before.sql`/`post-apply-checks.sql`.

Depends on mt-identity's membership unification (canonical `user_tenants.is_primary`): the MIGRATION-QUEUE row sorts
AFTER those rows; cite them when you add the row.

Branch `kiro/mt-native-health/health-home-tenant-db`; PR title
`VTID-xxxxx (mt-native-health/health-home-tenant-db): …`; commit trailers `Collab-Session: <your kiro session id>`
and `Collab-Lane: mt-native-health/health-home-tenant-db`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (the reviewer seat `jtadic` picks it up), `pr: <url>`, append a log entry, release the claim.

`docs/MULTI-TENANT-PLAN.md` is hash-locked: this lane never edits it. The backfill migration opens with a `RAISE EXCEPTION` guard (round-1 F6) that aborts unless every member has exactly one
primary `user_tenants` row, so it never freezes a wrong home tenant if mt-identity's membership unification has not
run yet.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Lane drafted by the hotmail Kiro seat (DB/migrations work → seat `hotmail`, reviewer `jtadic`). HELD at
`next_actor: owner` until PLAN-SPAR allocates the VTID. First lane of the spec; no in-spec dependencies. Round-1
F4/F6 folded in: program-doc correction added to paths; backfill self-enforces primary-membership canonicality.
### 2026-10-20T09:00Z · kiro-hotmail-202610151618-b437 · ready (answered sparring round 1, session fca982e6)
Removed `docs/MULTI-TENANT-PLAN.md` from paths and the program-doc edit: the parent plan is hash-locked and is not
amended; the Capacitor→Expo drift is recorded in this spec only.
