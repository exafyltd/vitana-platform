---
lane: profiles-tenant-backfill
state: ready
next_actor: kiro
depends_on: [orphan-analysis-and-quarantine]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102042*.sql
  - supabase/tests/vtid_mt_data_cleanup_profiles_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-06T10:09Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05572
---
# Backfill profiles.tenant_id — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` (authoritative) and the `profiles-tenant-backfill` group of `tasks.md`
(tasks P1–P5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

Depends on `orphan-analysis-and-quarantine` (membership resolution and the 0/2+ list come from there). Backfill uses
the canonical primary `user_tenants` tenant; a member with 0 or 2+ memberships stays NULL and is never defaulted to
Maxina. The column stays **nullable** in this spec (NOT NULL on `profiles` is WS3/WS10).

**Cross-spec dependency:** canonical `user_tenants` from **mt-identity-r2 `membership-unification`** (not in
`depends_on:` — that lists only lanes of this spec).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
pre/post/rollback-check SQL is delivered under `docs/validation/<vtid>/` (RUN-MIGRATION checks). A database change is a migration
file in this PR. Work only inside the allowed paths; add this lane's own `docs/validation/<vtid>/` in the same PR.

Branch `kiro/mt-data-cleanup-r2/profiles-tenant-backfill`; PR title
`VTID-xxxxx (mt-data-cleanup-r2/profiles-tenant-backfill): …`; commit trailers `Collab-Session: <your kiro session id>`
and `Collab-Lane: mt-data-cleanup-r2/profiles-tenant-backfill`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-data-cleanup/profiles-tenant-backfill`. Versions day-shifted to `20261102*`; WS1 dependency named `mt-identity-r2`;
executor and reviewer on today's §3a/§7 rules.

### 2026-11-06T10:09Z · ci-plan-spar · ready (VTID allocated)
VTID-05572 allocated after policy approval (converged-auto-v1).

### 2026-11-07T16:05:00Z · agent-vitana-lane-reviewer-202611071604-119b · review
review: accept
head: fd0bd0e4b8d2f58460bc4c747f6a4e6b427c790e
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4800
Findings: non-blocking: the single-membership profile whose tenant is missing from tenants is neither set nor listed (earlier finding, still open; follow-up); non-blocking: the PR check status could not be read here (gh GraphQL unsupported), so CI 12/12 is the caller's report and the land step must confirm it on this head
Next: the land step merges under §7b
