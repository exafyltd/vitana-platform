---
lane: community-tenant-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101060*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - supabase/tests/mt_community_isolation_*.sql
updated: 2026-10-15T16:30Z
---
# Community tables — tenant_id + RLS (DB) — mt-community-isolation/community-tenant-db (repo vitana-platform)

HELD: `next_actor: owner` and no `vtid` until PLAN-SPAR converges this plan and allocates the VTID;
it then flips this lane to `kiro`. Plan: `../plan.md`; tasks + allowed paths + acceptance:
`../tasks.md` (`<!-- lane: community-tenant-db -->`); design + successor rules: `../design.md`.

Adds `tenant_id` (nullable → BEFORE INSERT trigger filling from the actor's resolved tenant →
deterministic batched backfill → `CHECK … NOT VALID` → `VALIDATE`; **no `SET NOT NULL`** — WS2
backfills existing rows) and, because these tables **already have RLS enabled with permissive
policies** (verified: `vitana-v1/.../20250917153624_*.sql`, `.../20251010065205_*.sql`),
**rewrites** every policy user-private / tenant-shared (`is_member`) / admin-only (`is_tenant_admin`)
rather than newly enabling RLS, plus the realtime tenant predicate, on `profile_posts`, the four
`global_community_*` tables (`global_community_profiles`, `global_community_groups`,
`global_community_events`, `global_community_group_members`), `media_uploads`,
`community_live_streams`, `calendar_events`, `content_reports`, `feedback_tickets`, `daily_matches`.
**Per-user vs content rows:** `global_community_profiles` (one row per user, users 1:N in
`user_tenants`) gets **no** `tenant_id` — its policies use a membership predicate; `global_community_group_members` copies its group's `tenant_id`; content rows backfill
deterministically (author's only membership, else single `is_primary`, else NULL — no guess), and
the `CHECK` is VALIDATEd only once the NULL count is 0.
Rewritten SELECT policies keep author-owned (`user_id = auth.uid()`) read access for NULL-`tenant_id`
rows. For `content_reports` this lane owns only `tenant_id` + base RLS — mt-tenant-admin's
`moderator-tenant-scope-db` (`070600`, sorts after) layers moderation policies on top (cross-spec O4).
**The policy-rewrite migration is NOT feature-flag-gated** (RLS enforces on apply), so its
MIGRATION-QUEUE row is placed strictly after the WS1 resolver/membership migrations AND after this
lane's own `tenant_id` backfill. Version range `20261101060000–065959`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no
merge/approve/deploy/workflow dispatch, no Supabase/AWS writes — a database change is a migration
file in this PR, applied by Claude via RUN-MIGRATION after merge. Expand/contract only; `lock_timeout`
+ retries; `bak_*` snapshot before any data move; pre-approved rollback migration + read-only
`live-before.sql` / `post-apply-checks.sql` under `docs/validation/<vtid>/` (this lane adds its own
`docs/validation/<vtid>/`). Add MIGRATION-QUEUE rows in the same PR at the position after the WS1
resolver/membership migrations. Depends on WS1's `is_member()` / `tenant_id_for_policies()` /
`is_tenant_admin()` (external spec dependency — stated here, not in `depends_on`, which lists only
lanes of this spec).

Branch `kiro/mt-community-isolation/community-tenant-db`;
PR title `VTID-xxxxx (mt-community-isolation/community-tenant-db): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-community-isolation/community-tenant-db`.
When the PR is open: set `state: in-review`, `next_actor: kiro` (the reviewer seat), `pr: <url>`,
append a log entry, release the claim.

## Log
### 2026-10-15T16:30Z · kiro-hotmail-202610151618-b437 · created → ready
Lane drafted. HELD until PLAN-SPAR allocates the VTID.
