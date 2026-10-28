---
lane: email-brand-db
state: in-review
next_actor: kiro
pr: https://github.com/exafyltd/vitana-v1/pull/1464
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafyltd
paths:
  - supabase/migrations/20261101090000_vtid_05245_tenant_email_branding.sql
  - docs/validation/VTID-05245/**
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-10-20T12:18Z
vtid: VTID-05245
---
# email-brand-db — tenant-keyed email branding helper (repo vitana-v1, DB)

Plan: `.kiro/specs/mt-frontend-brand/plan.md` and the `email-brand-db` section of `tasks.md`
(ED1–ED2, allowed paths, acceptance). Design + migration rules: `design.md`.

**Held until PLAN-SPAR allocates this lane's VTID** (`next_actor: owner`); PLAN-SPAR flips it to
`kiro`. The migration file name's `vtid_xxxxx` is renamed to the allocated VTID at build time;
renumber the `20261101090000` prefix if a later migration exists then.

Executor rules (collaboration §7a): a DB change is a migration FILE in this PR — Kiro never
applies it, never runs `apply_migration`/`execute_sql` DDL, never writes to a live system.
Claude applies it via RUN-MIGRATION after merge, with the read-only pre/post checks. Expand-only
(a read helper/view, seeded with Maxina's current literal values); `SET lock_timeout`; no NOT
NULL, no hot-table backfill. Add the MIGRATION-QUEUE row as the first `20261101…` entry (after
`20261014000700`), rollback `docs/validation/<vtid>/rollback.sql`. The lane adds its own
`docs/validation/<vtid>/` (rollback.sql, pre/post-check SQL, scope.json). Branch
`kiro/mt-frontend-brand/email-brand-db`; PR title `VTID-xxxxx (mt-frontend-brand/email-brand-db): …`;
trailers `Collab-Session`/`Collab-Lane`. On PR open: `state: in-review`, `next_actor: kiro`,
`pr: <url>`, log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. DB lane split from `email-brand-code` per §4.7. Seeds Maxina's current email
branding so behaviour is byte-identical until a tenant overrides. Seat `hotmail`
(supabase/migrations + DB lanes per the brief); reviewer seat `exafyltd` (≠ `hotmail`).

### 2026-10-19T20:32Z · ci-plan-spar · ready (VTID allocated)
VTID-05245 allocated after policy approval (converged-auto-v1).
### 2026-10-20T08:43Z · kiro-hotmail-202610151618-b437 · paths fix
`paths`: migration file name now carries the allocated VTID (`vtid_xxxxx` → `vtid_05245`), and
`docs/validation/VTID-05245/**` added, as the lane body already says the lane adds its own
`docs/validation/<vtid>/` (rollback.sql, pre/post-check SQL, scope.json). `MIGRATION-QUEUE.md`
does not exist in vitana-v1; the program's single queue is in vitana-platform, so row 9 ships as a
separate platform PR: https://github.com/exafyltd/vitana-platform/pull/4204
### 2026-10-20T08:46Z · kiro-hotmail-202610151618-b437 · ready → in-review
Migration `20261101090000_vtid_05245_tenant_email_branding.sql` + rollback/pre/post-check/scope.json shipped
(not applied), PR https://github.com/exafyltd/vitana-v1/pull/1464 opened; awaiting review by seat exafyltd.
### 2026-10-20T12:18Z · kiro-hotmail-202610151618-b437 · plan merged (§7b owner-directed)
Plan PR https://github.com/exafyltd/vitana-platform/pull/4172 (`plan(mt-frontend-brand)`) is merged to main as
`975a1bdb82b111f7bd8363dcdfec9a7c34993b55` under collaboration.md §7b. Owner instruction in conversation
2026-10-20: "you do it, claude is off , you have to do it, we have changed the rule" (in reply to the list naming
#4172, #4206, #4208). This lane's state is unchanged. #1464 (vitana-v1) and #4204 were not merged.
### 2026-10-21T19:13Z · kiro-exafyltd-202610211913-904e · review
review: accept
head: 9f431c7c72a238be89ffb2f479ef1422be290065
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4254 (platform head 9f431c7c72a238be89ffb2f479ef1422be290065); https://github.com/exafyltd/vitana-v1/pull/1464 (v1 head 8ef799c6372fb1126f5680cf4a1e8141308ebc20)
Findings: none blocking. Non-blocking: CI checks were still pending on both heads (the land step confirms Lane scope and Collab handoff green before merging); red-to-green is SQL-level only, as the migration cannot be applied by Kiro; unverified FK and auth.users premises are left for the owner's apply and post-check; PR pairing and merge order #1464 then #4254; email-brand-code still needs the owner's apply.
Next: the land step merges under §7b once the required checks are green and the PRs are up to date with main
