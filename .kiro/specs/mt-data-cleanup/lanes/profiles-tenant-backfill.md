---
lane: profiles-tenant-backfill
state: ready
next_actor: owner
depends_on: [orphan-analysis-and-quarantine]
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101042*.sql
  - supabase/tests/vtid_mt_data_cleanup_profiles_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-01T13:00Z
---
# Backfill profiles.tenant_id — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup/plan.md` (authoritative) and the `profiles-tenant-backfill` group of `tasks.md`
(tasks P1–P5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; it then flips `next_actor` to kiro.
Depends on `orphan-analysis-and-quarantine` (membership resolution and the 0/2+ list come from there). Backfill uses
the canonical primary `user_tenants` tenant; a member with 0 or 2+ memberships stays NULL and is never defaulted to
Maxina. The column stays **nullable** in this spec (NOT NULL on `profiles` is WS3/WS10).

**Cross-spec dependency:** canonical `user_tenants` from **mt-identity `membership-unification`** (not in
`depends_on:` — that lists only lanes of this spec).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
pre/post/rollback-check SQL is delivered under `docs/validation/<vtid>/` for Claude. A database change is a migration
file in this PR. Work only inside the allowed paths; add this lane's own `docs/validation/<vtid>/` in the same PR.

Branch `kiro/mt-data-cleanup/profiles-tenant-backfill`; PR title
`VTID-xxxxx (mt-data-cleanup/profiles-tenant-backfill): …`; commit trailers `Collab-Session: <your kiro session id>`
and `Collab-Lane: mt-data-cleanup/profiles-tenant-backfill`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T13:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created with the spec shell (push-first). Held at `next_actor: owner` pending PLAN-SPAR VTID allocation.
