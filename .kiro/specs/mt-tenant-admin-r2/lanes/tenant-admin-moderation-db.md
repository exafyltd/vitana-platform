---
lane: tenant-admin-moderation-db
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102070100_vtid_*_mt_tenant_admin_p2_moderation.sql
  - supabase/migrations/20261102070150_vtid_*_mt_tenant_admin_p3_moderation.sql
  - supabase/migrations/20261102070600_vtid_*_mt_moderator_tenant_scope.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-11-02T16:20Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05491
---
# Tenant-admin moderation DB — P2/P3 + moderator tenant-scope (repo vitana-platform)

Plan: `.kiro/specs/mt-tenant-admin-r2/plan.md` (authoritative) and the `tenant-admin-moderation-db` section of
`tasks.md`. Design and the rules you must follow: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Owns moderation (CROSS-SPEC O4): this lane + the gateway lane carry the moderation RPCs/triggers/predicate; there is
no `moderation-tenant-db` lane. Migrations P2 `070100`, P3 `070150`, moderator-tenant-scope `070600`. **mt-community-
isolation C3 is reserved at `070160`** — these files sort around it. MIGRATION-QUEUE order: P2 → P3 → C3 → (lifecycle)
→ moderator-tenant-scope. Each migration ships its rollback under `docs/validation/<vtid>/`, read-only pre/post checks,
and a MIGRATION-QUEUE row in the same PR; a not-yet-live table goes into `migration-drift-baseline.json` and is removed
after apply. Expand/contract only; `lock_timeout` + retries; snapshot before any data move. The lane adds its own
`docs/validation/<vtid>/` (not in `paths`; see collaboration §2 — the executor creates it in the PR).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, **no Supabase or AWS writes** — a DB change is a migration file in this PR,
applied later by Kiro via RUN-MIGRATION, only on the owner's approval of the files and the target database (§7d). Work only inside the allowed paths. Branch
`kiro/mt-tenant-admin-r2/tenant-admin-moderation-db`; PR title `VTID-xxxxx (mt-tenant-admin-r2/tenant-admin-moderation-db):
…`; commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-tenant-admin-r2/tenant-admin-
moderation-db`. When the PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry,
release the claim.

## Log
### 2026-11-01T15:50Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-tenant-admin/tenant-admin-moderation-db`. Versions day-shifted to `20261102070*`. Executor and reviewer follow today's §3a/§7 rules.

### 2026-11-02T16:20Z · ci-plan-spar · ready (VTID allocated)
VTID-05491 allocated after policy approval (converged-auto-v1).

### 2026-11-07T13:20:00Z · agent-vitana-lane-reviewer-202611071317-2799 · review
review: accept
head: 0f37b5068e4190f10bbf806b4b470ccd6bff536b
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4791
Findings: non-blocking: acceptance.md:59 AC-5 still says "queue rows 30-32" (should be 34-36); non-blocking: queue rows 32-33 intentionally left for PR #4788 (VTID-05493), gap until it lands; non-blocking: CI 12/12 green taken from caller's REST read (GraphQL denied to reviewer)
Next: the land step merges under §7b
