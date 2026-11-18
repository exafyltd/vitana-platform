---
lane: profiles-tenant-backfill
state: done
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
updated: 2026-11-07T17:00Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05572
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-data-cleanup-r2/profiles-tenant-backfill
pr: https://github.com/exafyltd/vitana-platform/pull/4800
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

### 2026-11-07T16:35:00Z · agent-vitana-lane-reviewer-202611071633-4cab · review
review: accept
head: 9e9bfa03264ca7c417c805b0b0fb57a29ff741a1
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4800
Findings: non-blocking: a missing-tenant single membership is not listed in legacy_archive.mt_profiles_tenant_unresolved (carried over from the review of fd0bd0e4b8); otherwise none. Re-review scope: the merge of origin/main 9ab419f9d1 adds only this lane's rows 41-42 and their note to MIGRATION-QUEUE.md (rows 1-39 untouched, no renumbering); the lane's own files are unchanged since fd0bd0e4b8d2f58460bc4c747f6a4e6b427c790e apart from the lane-log entry.
Next: the land step merges under §7b

### 2026-11-07T16:51:00Z · agent-vitana-lane-reviewer-202611071650-b6d3 · review
review: accept
head: b0fbfe52ccb3a1277c02009b05d4f57d955ffb31
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4800
Findings: non-blocking: a missing-tenant single membership is not listed in legacy_archive.mt_profiles_tenant_unresolved (carried over, follow-up); non-blocking: the merge's second parent is b7e52a6df4 (descendant of 7daa4ae3a7, row 40 landed with f65570b637), scope checked against b7e52a6df4; non-blocking: PR check status unreadable here (gh GraphQL unsupported), the land step must confirm every required check green on this head. Re-review scope: merge of origin/main into 9e9bfa0326 changes only MIGRATION-QUEUE.md (main rows 1-40 and notes untouched, this lane's rows 41-42 and note added after them, no renumbering); the lane's own migrations, tests and docs/validation/VTID-05572 are unchanged since 9e9bfa0326 apart from the lane-log entry.
Next: the land step merges under §7b

### 2026-11-07T16:56Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-data-cleanup-r2/profiles-tenant-backfill; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T16:56Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4800. Reviewed on head `b0fbfe52cc` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T16:56Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: f8f095327bbf25cc989287697652843d0bec98f2 (exafyltd/vitana-platform#4800)
authority: §7b PM rule. Squash merge by land-guard on head `5597628980`: the reviewed head `b0fbfe52cc` plus the review-entry commit. `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: STAGING-VERIFY on the merge commit, then the `done` record.

### 2026-11-07T17:00Z · kiro-hotmail-202611061752-cc1f · verified → done
Closing record 2 of 2. Merge f8f095327b (#4800) is verified: no deploy path is touched, so the lane is done at merge (§7b). The migrations in this lane are in the repository and NOT applied; applying them needs the owner's approval per file and database (collaboration.md §7d).
