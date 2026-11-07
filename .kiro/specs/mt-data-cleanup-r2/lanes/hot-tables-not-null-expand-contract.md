---
lane: hot-tables-not-null-expand-contract
state: done
next_actor: kiro
depends_on: [orphan-analysis-and-quarantine, profiles-tenant-backfill]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102043*.sql
  - supabase/tests/vtid_mt_data_cleanup_notnull_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - DATABASE_SCHEMA.md
updated: 2026-11-07T19:00Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05569
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-data-cleanup-r2/hot-tables-not-null-expand-contract
pr: https://github.com/exafyltd/vitana-platform/pull/4837
---
# Assert and pin NOT NULL on the hot tables — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` (authoritative) and the `hot-tables-not-null-expand-contract` group of
`tasks.md` (tasks H1–H6, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

Runs **last** in this spec: depends on `orphan-analysis-and-quarantine` and `profiles-tenant-backfill`, because its
assertion includes their zero-orphan state. **Assert-and-pin, no expand/contract** (sparring R1-F1/F2): `chat_messages`,
`user_notifications` (`20260225000000_notification_system.sql:27`) and `product_analytics_events`
(`20260612140000_BOOTSTRAP_product_analytics_events.sql:33`) are already `tenant_id NOT NULL` in DDL. Ship one
assertion-only migration (DO block that RAISEs if any of the three `tenant_id` columns is nullable or holds a tenant
id not in `tenants`) — no trigger, no backfill, no default, no `SET NOT NULL` — plus a no-op rollback file, and record
`tenant_id UUID NOT NULL` for these tables in `DATABASE_SCHEMA.md` (line ~2543 and the `user_notifications` entry). If
the assertion ever fires, stop: §4.7 expand/contract is re-planned in a new sparred plan, not improvised here.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
pre/post/rollback-check SQL is delivered under `docs/validation/<vtid>/` (RUN-MIGRATION checks). A database change is a migration
file in this PR. Work only inside the allowed paths; add this lane's own `docs/validation/<vtid>/` in the same PR.

Branch `kiro/mt-data-cleanup-r2/hot-tables-not-null-expand-contract`; PR title
`VTID-xxxxx (mt-data-cleanup-r2/hot-tables-not-null-expand-contract): …`; commit trailers `Collab-Session: <your kiro
session id>` and `Collab-Lane: mt-data-cleanup-r2/hot-tables-not-null-expand-contract`. When the PR is open: set
`state: in-review`, `next_actor: kiro` (reviewer seat `jtadic`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-data-cleanup/hot-tables-not-null-expand-contract`. Versions day-shifted to `20261102*`; WS1 dependency named `mt-identity-r2`;
executor and reviewer on today's §3a/§7 rules.

### 2026-11-06T10:09Z · ci-plan-spar · ready (VTID allocated)
VTID-05569 allocated after policy approval (converged-auto-v1).

### 2026-11-07T18:45:00Z · agent-vitana-lane-reviewer-202611071840-31f4 · review
review: accept
head: b4a9cd0da0dc92d4edae7e6311326654d828e18b
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4837
Findings:
- none blocking. The assert-and-pin migration matches tasks.md H1-H6 and the Acceptance (plan premise 5 holds: all three tenant_id columns are NOT NULL in DDL). All 27 files are in paths, no weakening, no live write, no protected file, no RLS or policy change, drift baseline untouched (120).
- non-blocking: PR check status unreadable here (gh GraphQL unsupported, gh api denied); 12/12 is the builder's report and the land step must confirm every required check green on this head.
- non-blocking: DATABASE_SCHEMA.md new section is inserted mid-entry and orphans the trailing connections_social line of the notification-categories entry (cosmetic).
- non-blocking: fixture inserts on a real stack depend on triggers not read here (CI pgTAP is the proof); the embedded DO-block copy can drift from the migration; the orphan scan on a large product_analytics_events may approach the 120s statement_timeout on apply (fails loudly).
- non-blocking: the migrations need owner approval per file and database (collaboration.md section 7d) and are not applied by this PR.
Next: the land step merges under §7b

### 2026-11-07T18:55Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-data-cleanup-r2/hot-tables-not-null-expand-contract; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T18:55Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4837. Reviewed on head `b4a9cd0da0` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T18:55Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: ececf7f9bda192db0d846813b1e3198c5c657472 (exafyltd/vitana-platform#4837)
authority: §7b PM rule. Squash merge by land-guard on head `e34a5124bf`: the reviewed head `b4a9cd0da0` plus the review-entry commit and a clean merge of main. `land-guard review` ok, `land-guard checks` green (12 checks), PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: the `done` record.

### 2026-11-07T19:00Z · kiro-hotmail-202611061752-cc1f · verified → done
This lane deploys nothing: it adds an assertion-only migration (20261102043000) with a no-op rollback, a pgTAP test, DATABASE_SCHEMA.md and MIGRATION-QUEUE rows 51-52, none applied. No staging deploy follows from the merge (ececf7f9bd), so there is no STAGING-VERIFY run for it; it is done at merge with green checks (12 green on head e34a5124bf). Applying the migrations needs the owner's approval of the files and the target database (collaboration.md §7d). Non-blocking review notes carried forward: DATABASE_SCHEMA.md section placement orphans a trailing connections_social line, the embedded DO-block copy can drift from the migration, and the orphan scan on a large product_analytics_events may approach the 120s statement_timeout on apply (fails loudly).
